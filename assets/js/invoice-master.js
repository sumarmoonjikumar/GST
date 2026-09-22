import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, toast, formatDate, formatCurrency, confirmAdminDelete } from "./utils.js";
import { initAppChrome } from "./chrome.js";

applyStoredTheme();
const session = requireSession(["admin", "staff"]);

let clients = [];
let invoices = [];
let offcanvas;
let isIgst = false; // whether GST splits as IGST (inter-state) or CGST+SGST, per Settings

async function init() {
  if (!session) return;
  initAppChrome(session);

  offcanvas = new bootstrap.Offcanvas(document.getElementById("invoiceOffcanvas"));

  const [allClients, allInvoices, settings] = await Promise.all([
    DB.getAll(DB.STORES.clients),
    DB.getAll(DB.STORES.salesInvoices),
    DB.getSettings(),
  ]);

  isIgst = settings.gstType === "IGST";
  document.getElementById("tCgstLabel").textContent = isIgst ? "IGST" : "CGST";
  document.getElementById("tSgstLabel").textContent = isIgst ? "" : "SGST";
  document.getElementById("tSgst").closest(".t-row").classList.toggle("d-none", isIgst);

  // Staff only bill parties assigned to them; admin sees everyone.
  clients = session.role === "staff" ? allClients.filter((c) => c.assignedStaffId === session.id) : allClients;
  invoices = allInvoices.filter((inv) => clients.some((c) => c.id === inv.clientId));

  populatePartySelect();
  renderTable();
  wireEvents();
}

function populatePartySelect() {
  const select = document.getElementById("invoicePartyId");
  select.innerHTML =
    `<option value="">Select party…</option>` +
    clients
      .slice()
      .sort((a, b) => a.businessName.localeCompare(b.businessName))
      .map((c) => `<option value="${c.id}">${escapeHtml(c.businessName)}</option>`)
      .join("");
}

function clientName(id) {
  return clients.find((c) => c.id === id)?.businessName || "Unknown Party";
}

/** Taxable sub-total + GST for a single item, including any extra HSN splits. */
function itemTax(it) {
  const taxable = Number(it.amount) || 0;
  const rate = Number(it.gstRate) || 0;
  let tax = (taxable * rate) / 100;
  let splitTaxable = 0;
  (it.hsnBreakup || []).forEach((s) => {
    splitTaxable += Number(s.taxableValue) || 0;
    tax += Number(s.taxAmount) || 0;
  });
  return { taxable: taxable + splitTaxable, tax };
}

/** Full totals (sub total, cgst/sgst or igst, discount, grand total) for an invoice record. */
function computeTotals(invoice) {
  let sub = 0,
    tax = 0;
  (invoice.items || []).forEach((it) => {
    const t = itemTax(it);
    sub += t.taxable;
    tax += t.tax;
  });
  const discount = Number(invoice.discount) || 0;
  const cgst = isIgst ? 0 : tax / 2;
  const sgst = isIgst ? 0 : tax / 2;
  const igst = isIgst ? tax : 0;
  const grand = sub + tax - discount;
  return { sub, cgst, sgst, igst, tax, discount, grand };
}

function computeTotal(invoice) {
  return computeTotals(invoice).grand;
}

function renderTable() {
  const search = document.getElementById("invoiceSearch").value.trim().toLowerCase();
  const statusFilter = document.getElementById("invoiceStatusFilter").value;

  let rows = invoices.slice();
  if (search) {
    rows = rows.filter(
      (inv) => clientName(inv.clientId).toLowerCase().includes(search) || (inv.invoiceNo || "").toLowerCase().includes(search)
    );
  }
  if (statusFilter) rows = rows.filter((inv) => (inv.status || "Unpaid") === statusFilter);
  rows.sort((a, b) => new Date(b.invoiceDate || 0) - new Date(a.invoiceDate || 0));

  const tbody = document.getElementById("invoiceTableBody");
  document.getElementById("invoiceCountLabel").textContent = `${rows.length} invoice${rows.length === 1 ? "" : "s"}`;
  document.getElementById("invoiceEmptyState").classList.toggle("d-none", invoices.length !== 0);

  tbody.innerHTML = rows
    .map((inv) => {
      const total = computeTotal(inv);
      const statusBadge =
        (inv.status || "Unpaid") === "Paid"
          ? `<span class="badge badge-soft-success">Paid</span>`
          : `<span class="badge badge-soft-warning">Unpaid</span>`;
      return `
        <tr>
          <td class="font-mono">${escapeHtml(inv.invoiceNo || "—")}</td>
          <td>${formatDate(inv.invoiceDate)}</td>
          <td>${escapeHtml(clientName(inv.clientId))}</td>
          <td class="text-end">${formatCurrency(total)}</td>
          <td>${statusBadge}</td>
          <td class="text-end">
            <a class="btn btn-sm btn-outline-secondary" href="invoice.html?sales=${encodeURIComponent(inv.id)}" target="_blank" title="View / Print"><i class="fa-solid fa-print"></i></a>
            <button class="btn btn-sm btn-outline-secondary edit-btn" data-id="${inv.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
            <button class="btn btn-sm btn-outline-danger delete-btn" data-id="${inv.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
          </td>
        </tr>`;
    })
    .join("");

  tbody.querySelectorAll(".edit-btn").forEach((btn) => btn.addEventListener("click", () => openEdit(btn.dataset.id)));
  tbody.querySelectorAll(".delete-btn").forEach((btn) => btn.addEventListener("click", () => onDelete(btn.dataset.id)));

  const paidTotal = invoices.filter((i) => i.status === "Paid").reduce((s, i) => s + computeTotal(i), 0);
  const unpaidTotal = invoices.filter((i) => i.status !== "Paid").reduce((s, i) => s + computeTotal(i), 0);
  document.getElementById("statInvoiceCount").textContent = invoices.length;
  document.getElementById("statInvoicePaid").textContent = formatCurrency(paidTotal);
  document.getElementById("statInvoiceUnpaid").textContent = formatCurrency(unpaidTotal);
}

function addItemRow(item = {}) {
  const tpl = document.getElementById("itemRowTemplate");
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.querySelector(".item-desc").value = item.description || "";
  node.querySelector(".item-hsn").value = item.hsn || "";
  node.querySelector(".item-qty").value = item.qty ?? 1;
  node.querySelector(".item-rate").value = item.rate ?? "";
  node.querySelector(".item-gst").value = item.gstRate ?? 18;
  node.querySelector(".item-amount").value = formatCurrency(item.amount || 0);

  const recalc = () => {
    const qty = Number(node.querySelector(".item-qty").value) || 0;
    const rate = Number(node.querySelector(".item-rate").value) || 0;
    node.querySelector(".item-amount").value = formatCurrency(qty * rate);
    updateTotalPreview();
  };
  node.querySelector(".item-qty").addEventListener("input", recalc);
  node.querySelector(".item-rate").addEventListener("input", recalc);
  node.querySelector(".item-gst").addEventListener("change", updateTotalPreview);
  node.querySelector(".item-remove-btn").addEventListener("click", () => {
    node.remove();
    updateTotalPreview();
  });

  // "+" corner button — this single item actually covers 2+ HSN codes,
  // so add another HSN/Taxable-Value/Tax split row nested under it.
  const extraContainer = node.querySelector(".item-hsn-extra");
  node.querySelector(".item-addhsn-btn").addEventListener("click", () => addHsnExtraRow(extraContainer));

  // Restore any previously saved HSN splits (edit mode).
  (item.hsnBreakup || []).forEach((split) => addHsnExtraRow(extraContainer, split));

  document.getElementById("itemRows").appendChild(node);
}

/** Adds one nested "2nd/3rd HSN" row under an item, with its own taxable value + tax %. */
function addHsnExtraRow(extraContainer, split = {}) {
  const tpl = document.getElementById("hsnExtraRowTemplate");
  const row = tpl.content.firstElementChild.cloneNode(true);
  row.querySelector(".hsn-extra-code").value = split.hsn || "";
  row.querySelector(".hsn-extra-taxable").value = split.taxableValue ?? "";
  row.querySelector(".hsn-extra-rate").value = split.taxRate ?? "";
  row.querySelector(".hsn-extra-taxamt").value = formatCurrency(split.taxAmount || 0);

  const recalcTax = () => {
    const taxable = Number(row.querySelector(".hsn-extra-taxable").value) || 0;
    const rate = Number(row.querySelector(".hsn-extra-rate").value) || 0;
    row.querySelector(".hsn-extra-taxamt").value = formatCurrency((taxable * rate) / 100);
    updateTotalPreview();
  };
  row.querySelector(".hsn-extra-taxable").addEventListener("input", recalcTax);
  row.querySelector(".hsn-extra-rate").addEventListener("input", recalcTax);
  row.querySelector(".hsn-extra-remove-btn").addEventListener("click", () => {
    row.remove();
    updateTotalPreview();
  });

  extraContainer.appendChild(row);
}

function updateTotalPreview() {
  const discount = Number(document.getElementById("invoiceDiscount").value) || 0;
  const totals = computeTotals({ items: collectItems(), discount });
  document.getElementById("tSubTotal").textContent = formatCurrency(totals.sub);
  document.getElementById("tCgst").textContent = formatCurrency(isIgst ? totals.igst : totals.cgst);
  document.getElementById("tSgst").textContent = formatCurrency(totals.sgst);
  document.getElementById("tDiscount").textContent = formatCurrency(totals.discount);
  document.getElementById("invoiceTotalPreview").textContent = formatCurrency(totals.grand);
}

function collectItems() {
  return Array.from(document.querySelectorAll("#itemRows .item-block"))
    .map((block) => {
      const row = block.querySelector(".item-row-grid");
      const description = row.querySelector(".item-desc").value.trim();
      const hsn = row.querySelector(".item-hsn").value.trim();
      const qty = Number(row.querySelector(".item-qty").value) || 0;
      const rate = Number(row.querySelector(".item-rate").value) || 0;
      const gstRate = Number(row.querySelector(".item-gst").value) || 0;

      const hsnBreakup = Array.from(block.querySelectorAll(".hsn-extra-row"))
        .map((extra) => {
          const exHsn = extra.querySelector(".hsn-extra-code").value.trim();
          const taxableValue = Number(extra.querySelector(".hsn-extra-taxable").value) || 0;
          const taxRate = Number(extra.querySelector(".hsn-extra-rate").value) || 0;
          return { hsn: exHsn, taxableValue, taxRate, taxAmount: (taxableValue * taxRate) / 100 };
        })
        .filter((s) => s.hsn || s.taxableValue > 0);

      const it = { description, hsn, qty, rate, gstRate, amount: qty * rate };
      if (hsnBreakup.length) it.hsnBreakup = hsnBreakup;
      return it;
    })
    .filter((it) => it.description || it.amount > 0);
}

function openNew() {
  document.getElementById("invoiceForm").reset();
  document.getElementById("invoiceId").value = "";
  document.getElementById("invoiceOffcanvasTitle").textContent = "New Invoice";
  document.getElementById("invoiceDate").value = new Date().toISOString().slice(0, 10);
  document.getElementById("invoiceStatus").value = "Unpaid";
  document.getElementById("invoicePaymentMode").value = "Cash";
  document.getElementById("invoiceDiscount").value = 0;
  document.getElementById("itemRows").innerHTML = "";
  addItemRow();
  updateTotalPreview();
  offcanvas.show();
}

function openEdit(id) {
  const inv = invoices.find((i) => i.id === id);
  if (!inv) return;
  document.getElementById("invoiceId").value = inv.id;
  document.getElementById("invoiceOffcanvasTitle").textContent = `Edit ${inv.invoiceNo || "Invoice"}`;
  document.getElementById("invoicePartyId").value = inv.clientId || "";
  document.getElementById("invoiceDate").value = (inv.invoiceDate || "").slice(0, 10);
  document.getElementById("invoiceStatus").value = inv.status || "Unpaid";
  document.getElementById("invoicePaymentMode").value = inv.paymentMode || "Cash";
  document.getElementById("invoiceDiscount").value = inv.discount || 0;
  document.getElementById("invoiceNotes").value = inv.notes || "";
  document.getElementById("itemRows").innerHTML = "";
  (inv.items && inv.items.length ? inv.items : [{}]).forEach((it) => addItemRow(it));
  updateTotalPreview();
  offcanvas.show();
}

async function onSave(e) {
  e.preventDefault();
  const clientId = document.getElementById("invoicePartyId").value;
  if (!clientId) {
    toast("Please select a party.", "error");
    return;
  }
  const items = collectItems();
  if (items.length === 0) {
    toast("Add at least one item.", "error");
    return;
  }

  const id = document.getElementById("invoiceId").value;
  const existing = id ? invoices.find((i) => i.id === id) : null;

  const record = {
    id: existing?.id || `si_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    invoiceNo: existing?.invoiceNo || (await DB.getNextSalesInvoiceNumber()),
    invoiceDate: document.getElementById("invoiceDate").value,
    clientId,
    items,
    paymentMode: document.getElementById("invoicePaymentMode").value,
    discount: Number(document.getElementById("invoiceDiscount").value) || 0,
    notes: document.getElementById("invoiceNotes").value.trim(),
    status: document.getElementById("invoiceStatus").value,
    createdBy: existing?.createdBy || session.id,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await DB.put(DB.STORES.salesInvoices, record);
  await DB.logActivity(
    `${existing ? "Updated" : "Raised"} sale invoice ${record.invoiceNo} for "${clientName(clientId)}"`,
    "fa-file-invoice-dollar",
    "success"
  );

  if (existing) {
    invoices = invoices.map((i) => (i.id === record.id ? record : i));
  } else {
    invoices.push(record);
  }

  toast(`Invoice ${record.invoiceNo} saved.`, "success");
  offcanvas.hide();
  renderTable();
}

async function onDelete(id) {
  const inv = invoices.find((i) => i.id === id);
  if (!inv) return;
  const ok = await confirmAdminDelete(`Delete invoice ${inv.invoiceNo}? This cannot be undone.`);
  if (!ok) return;

  await DB.delete(DB.STORES.salesInvoices, id);
  await DB.logActivity(`Deleted sale invoice ${inv.invoiceNo}`, "fa-trash", "danger");
  invoices = invoices.filter((i) => i.id !== id);
  toast("Invoice deleted.", "success");
  renderTable();
}

function wireEvents() {
  document.getElementById("addInvoiceBtn").addEventListener("click", openNew);
  document.getElementById("addItemRowBtn").addEventListener("click", () => addItemRow());
  document.getElementById("invoiceDiscount").addEventListener("input", updateTotalPreview);
  document.getElementById("invoiceForm").addEventListener("submit", onSave);
  document.getElementById("invoiceSearch").addEventListener("input", renderTable);
  document.getElementById("invoiceStatusFilter").addEventListener("change", renderTable);
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.addEventListener("DOMContentLoaded", init);
