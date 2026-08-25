import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, toast, formatDate, formatCurrency, confirmAdminDelete } from "./utils.js";
import { initAppChrome } from "./chrome.js";

applyStoredTheme();
const session = requireSession(["admin", "staff"]);

let clients = [];
let invoices = [];
let offcanvas;

async function init() {
  if (!session) return;
  initAppChrome(session);

  offcanvas = new bootstrap.Offcanvas(document.getElementById("invoiceOffcanvas"));

  const [allClients, allInvoices] = await Promise.all([
    DB.getAll(DB.STORES.clients),
    DB.getAll(DB.STORES.salesInvoices),
  ]);

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

function computeTotal(invoice) {
  return (invoice.items || []).reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
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
  node.querySelector(".item-amount").value = formatCurrency(item.amount || 0);

  const recalc = () => {
    const qty = Number(node.querySelector(".item-qty").value) || 0;
    const rate = Number(node.querySelector(".item-rate").value) || 0;
    node.querySelector(".item-amount").value = formatCurrency(qty * rate);
    updateTotalPreview();
  };
  node.querySelector(".item-qty").addEventListener("input", recalc);
  node.querySelector(".item-rate").addEventListener("input", recalc);
  node.querySelector(".item-remove-btn").addEventListener("click", () => {
    node.remove();
    updateTotalPreview();
  });

  document.getElementById("itemRows").appendChild(node);
}

function updateTotalPreview() {
  const total = collectItems().reduce((sum, it) => sum + it.amount, 0);
  document.getElementById("invoiceTotalPreview").textContent = formatCurrency(total);
}

function collectItems() {
  return Array.from(document.querySelectorAll("#itemRows .item-row-grid"))
    .map((row) => {
      const description = row.querySelector(".item-desc").value.trim();
      const hsn = row.querySelector(".item-hsn").value.trim();
      const qty = Number(row.querySelector(".item-qty").value) || 0;
      const rate = Number(row.querySelector(".item-rate").value) || 0;
      return { description, hsn, qty, rate, amount: qty * rate };
    })
    .filter((it) => it.description || it.amount > 0);
}

function openNew() {
  document.getElementById("invoiceForm").reset();
  document.getElementById("invoiceId").value = "";
  document.getElementById("invoiceOffcanvasTitle").textContent = "New Invoice";
  document.getElementById("invoiceDate").value = new Date().toISOString().slice(0, 10);
  document.getElementById("invoiceStatus").value = "Unpaid";
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
