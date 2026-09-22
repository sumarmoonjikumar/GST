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
let settingsCache = null;
let formItems = []; // items added to the invoice currently open in the form (mirrors index.html's current.items)

async function init() {
  if (!session) return;
  initAppChrome(session);

  offcanvas = new bootstrap.Offcanvas(document.getElementById("invoiceOffcanvas"));

  const [allClients, allInvoices, settings] = await Promise.all([
    DB.getAll(DB.STORES.clients),
    DB.getAll(DB.STORES.salesInvoices),
    DB.getSettings(),
  ]);

  settingsCache = settings;
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
    `<option value="">-- Select Client --</option>` +
    clients
      .slice()
      .sort((a, b) => a.businessName.localeCompare(b.businessName))
      .map((c) => `<option value="${c.id}">${escapeHtml(c.businessName)}</option>`)
      .join("");
}

function clientName(id) {
  return clients.find((c) => c.id === id)?.businessName || "Unknown Party";
}

/** Indian financial year label, e.g. "2025-26" (Apr–Mar) — mirrors db.js's private helper. */
function currentFY() {
  const d = new Date();
  const startYear = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** Non-mutating preview of the number the next sale invoice WOULD get (does not touch the counter). */
function peekNextInvoiceNo(settings) {
  const prefix = settings.salesInvoicePrefix || "SI";
  const liveFY = currentFY();
  const rolledOver = settings.salesInvoiceFY && settings.salesInvoiceFY !== liveFY;
  const fy = rolledOver ? liveFY : settings.salesInvoiceFY || liveFY;
  const nextSeq = rolledOver ? 1 : (settings.salesInvoiceSeq || 0) + 1;
  return `${prefix}/${fy}/${String(nextSeq).padStart(3, "0")}`;
}

/** Taxable value + GST for one item, at that item's own GST %. */
function itemTax(it) {
  const taxable = (Number(it.qty) || 0) * (Number(it.rate) || 0);
  const tax = (taxable * (Number(it.gstRate) || 0)) / 100;
  return { taxable, tax };
}

/** Sub total, CGST/SGST or IGST, discount and grand total for an item list. */
function computeTotals(items, discount) {
  let sub = 0,
    tax = 0;
  items.forEach((it) => {
    const t = itemTax(it);
    sub += t.taxable;
    tax += t.tax;
  });
  const disc = Number(discount) || 0;
  const cgst = isIgst ? 0 : tax / 2;
  const sgst = isIgst ? 0 : tax / 2;
  const igst = isIgst ? tax : 0;
  const grand = sub + tax - disc;
  return { sub, cgst, sgst, igst, tax, discount: disc, grand };
}

function computeTotal(invoice) {
  return computeTotals(invoice.items || [], invoice.discount).grand;
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

/** Re-draws the item-details table from formItems — exactly the columns index.html's itemRows() renders. */
function renderItemsTable() {
  const tbody = document.getElementById("itemsTableBody");
  tbody.innerHTML =
    formItems
      .map(
        (it, n) => `
      <tr>
        <td>${n + 1}</td>
        <td>${escapeHtml(it.description)}</td>
        <td>${escapeHtml(it.hsn || "")}</td>
        <td>${it.qty}</td>
        <td>${formatCurrency(it.rate)}</td>
        <td>${it.gstRate}%</td>
        <td class="text-end">${formatCurrency(it.qty * it.rate)}</td>
        <td><button type="button" class="btn btn-sm btn-outline-danger remove-item-btn" data-index="${n}"><i class="fa-solid fa-xmark"></i></button></td>
      </tr>`
      )
      .join("") || `<tr><td colspan="8" class="text-center text-muted-soft py-2">Add items above.</td></tr>`;

  tbody.querySelectorAll(".remove-item-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      formItems.splice(Number(btn.dataset.index), 1);
      renderItemsTable();
      updateTotalPreview();
    })
  );
}

function addItemToForm() {
  const description = document.getElementById("iname").value.trim();
  const hsn = document.getElementById("ihsn").value.trim();
  const qty = Number(document.getElementById("iqty").value);
  const rate = Number(document.getElementById("irate").value);
  const gstRate = Number(document.getElementById("igst").value);

  if (!description || qty <= 0 || rate < 0) {
    toast("Enter item, quantity and rate.", "error");
    return;
  }

  formItems.push({ description, hsn, qty, rate, gstRate });
  renderItemsTable();
  updateTotalPreview();

  // Reset the entry fields for the next item, same as index.html's re-rendered blank form.
  resetEntryFields();
  document.getElementById("iname").focus();
}

function updateTotalPreview() {
  const discount = Number(document.getElementById("invoiceDiscount").value) || 0;
  const totals = computeTotals(formItems, discount);
  document.getElementById("tSubTotal").textContent = formatCurrency(totals.sub);
  document.getElementById("tCgst").textContent = formatCurrency(isIgst ? totals.igst : totals.cgst);
  document.getElementById("tSgst").textContent = formatCurrency(totals.sgst);
  document.getElementById("tDiscount").textContent = formatCurrency(totals.discount);
  document.getElementById("invoiceTotalPreview").textContent = formatCurrency(totals.grand);
}

function resetEntryFields() {
  document.getElementById("iname").value = "";
  document.getElementById("ihsn").value = "";
  document.getElementById("iqty").value = 1;
  document.getElementById("irate").value = 0;
  document.getElementById("igst").value = "18";
}

function openNew() {
  document.getElementById("invoiceForm").reset();
  document.getElementById("invoiceId").value = "";
  document.getElementById("invoiceOffcanvasTitle").textContent = "New Invoice";
  document.getElementById("invoiceNo").value = peekNextInvoiceNo(settingsCache);
  document.getElementById("invoiceNo").readOnly = false;
  document.getElementById("invoiceDate").value = new Date().toISOString().slice(0, 10);
  document.getElementById("invoicePartyId").value = "";
  document.getElementById("invoiceStatus").value = "Unpaid";
  document.getElementById("invoicePaymentMode").value = "Cash";
  document.getElementById("invoiceDiscount").value = 0;
  document.getElementById("invoiceNotes").value = "";
  formItems = [];
  resetEntryFields();
  renderItemsTable();
  updateTotalPreview();
  offcanvas.show();
}

function openEdit(id) {
  const inv = invoices.find((i) => i.id === id);
  if (!inv) return;
  document.getElementById("invoiceId").value = inv.id;
  document.getElementById("invoiceOffcanvasTitle").textContent = `Edit ${inv.invoiceNo || "Invoice"}`;
  document.getElementById("invoiceNo").value = inv.invoiceNo || "";
  document.getElementById("invoiceNo").readOnly = true; // number is fixed once an invoice has been raised
  document.getElementById("invoicePartyId").value = inv.clientId || "";
  document.getElementById("invoiceDate").value = (inv.invoiceDate || "").slice(0, 10);
  document.getElementById("invoiceStatus").value = inv.status || "Unpaid";
  document.getElementById("invoicePaymentMode").value = inv.paymentMode || "Cash";
  document.getElementById("invoiceDiscount").value = inv.discount || 0;
  document.getElementById("invoiceNotes").value = inv.notes || "";
  formItems = (inv.items || []).map((it) => ({ ...it }));
  resetEntryFields();
  renderItemsTable();
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
  if (formItems.length === 0) {
    toast("Add at least one item.", "error");
    return;
  }

  const id = document.getElementById("invoiceId").value;
  const existing = id ? invoices.find((i) => i.id === id) : null;

  let invoiceNo = document.getElementById("invoiceNo").value.trim();
  if (existing) {
    invoiceNo = existing.invoiceNo; // never changes on edit
  } else {
    // Bump the shared, persisted counter regardless (keeps future suggestions correct
    // even if staff typed a custom number over the suggested one shown).
    const suggested = await DB.getNextSalesInvoiceNumber();
    invoiceNo = invoiceNo || suggested;
    if (invoices.some((i) => i.invoiceNo === invoiceNo)) {
      toast(`Invoice number ${invoiceNo} is already in use.`, "error");
      return;
    }
  }

  const record = {
    id: existing?.id || `si_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    invoiceNo,
    invoiceDate: document.getElementById("invoiceDate").value,
    clientId,
    items: formItems.map((it) => ({ ...it })),
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
  document.getElementById("addItemBtn").addEventListener("click", addItemToForm);
  document.getElementById("invoiceDiscount").addEventListener("input", updateTotalPreview);
  document.getElementById("invoiceForm").addEventListener("submit", onSave);
  document.getElementById("invoiceSearch").addEventListener("input", renderTable);
  document.getElementById("invoiceStatusFilter").addEventListener("change", renderTable);

  // Item-entry fields live inside <form id="invoiceForm">, unlike index.html's
  // unwrapped markup — so Enter here must add the item, not submit the invoice.
  document.querySelector(".item-entry").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addItemToForm();
    }
  });
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.addEventListener("DOMContentLoaded", init);
