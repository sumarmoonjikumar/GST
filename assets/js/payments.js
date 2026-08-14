import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, toast, formatDate, formatCurrency, currentFY, fyList, fyMonths, initials, confirmAdminDelete } from "./utils.js";
import { initAppChrome } from "./chrome.js";

applyStoredTheme();
const session = requireSession(["admin", "staff"]); // customers don't manage payments here

let allPayments = [];
let allClients = [];
let paymentOffcanvas;
let activeTab = "all";

async function init() {
  if (!session) return;
  initAppChrome(session);

  paymentOffcanvas = new bootstrap.Offcanvas(document.getElementById("paymentOffcanvas"));

  await loadData();
  populateClientDropdowns();
  populatePeriodOptions();
  applyQueryParams();
  render();
  wireEvents();
}

function applyQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  if (status) document.getElementById("paymentStatusFilter").value = status;
}

/** Billing-period options: current + previous FY, newest first. */
function periodOptions() {
  const [curFY, prevFY] = fyList(2);
  return [...fyMonths(curFY).reverse(), ...fyMonths(prevFY).reverse()];
}

function populatePeriodOptions() {
  const formSelect = document.getElementById("paymentPeriod");
  const filterSelect = document.getElementById("paymentPeriodFilter");
  periodOptions().forEach((m) => {
    formSelect.add(new Option(m.label, m.label));
    filterSelect.add(new Option(m.label, m.label));
  });
}

async function loadData() {
  const [payments, clients] = await Promise.all([
    DB.getAll(DB.STORES.payments),
    DB.getAll(DB.STORES.clients),
  ]);
  allPayments = payments;
  allClients = clients;
}

function visibleClients() {
  if (session.role === "staff") {
    return allClients.filter((c) => c.assignedStaffId === session.id);
  }
  return allClients;
}

function visiblePayments() {
  const clientIds = new Set(visibleClients().map((c) => c.id));
  return allPayments.filter((p) => clientIds.has(p.clientId));
}

function populateClientDropdowns() {
  const formSelect = document.getElementById("paymentClientId");
  const filterSelect = document.getElementById("paymentClientFilter");
  const clients = visibleClients();

  if (clients.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.textContent = "No clients available — add a client first";
    formSelect.appendChild(opt);
  } else {
    clients.forEach((c) => {
      formSelect.add(new Option(`${c.businessName} (${c.gstin})`, c.id));
      filterSelect.add(new Option(c.businessName, c.id));
    });
  }
}

function applyFilters(list) {
  const q = document.getElementById("paymentSearch").value.trim().toLowerCase();
  const status = document.getElementById("paymentStatusFilter").value;
  const clientId = document.getElementById("paymentClientFilter").value;
  const period = document.getElementById("paymentPeriodFilter").value;

  return list.filter((p) => {
    const client = allClients.find((c) => c.id === p.clientId);
    const haystack = `${client?.businessName || ""} ${p.invoiceNo || p.invoiceRef || ""}`.toLowerCase();
    if (q && !haystack.includes(q)) return false;
    if (status && p.status !== status) return false;
    if (clientId && p.clientId !== clientId) return false;
    if (period && p.billingPeriod !== period) return false;
    return true;
  });
}

function renderSummary(list) {
  const paidTotal = list.filter((p) => p.status === "Paid").reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const pendingTotal = list.filter((p) => p.status === "Pending").reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const overdueCount = list.filter((p) => p.status === "Pending" && new Date(p.date).getTime() < thirtyDaysAgo).length;

  document.getElementById("statPaidTotal").textContent = formatCurrency(paidTotal);
  document.getElementById("statPendingTotal").textContent = formatCurrency(pendingTotal);
  document.getElementById("statPaymentCount").textContent = list.length;
  document.getElementById("statOverdueCount").textContent = overdueCount;
}

function render() {
  const scoped = visiblePayments();
  const list = applyFilters(scoped).sort((a, b) => new Date(b.date) - new Date(a.date));
  const container = document.getElementById("partyAccordion");
  const emptyState = document.getElementById("paymentsEmptyState");
  const countLabel = document.getElementById("paymentCountLabel");

  renderSummary(scoped);
  renderPendingByMonth(scoped);
  countLabel.textContent = `${list.length} payment${list.length === 1 ? "" : "s"}`;

  if (list.length === 0) {
    container.innerHTML = "";
    emptyState.classList.remove("d-none");
    return;
  }
  emptyState.classList.add("d-none");

  // Group into one accordion row per party. Map preserves first-seen order,
  // and `list` is already newest-payment-first, so the party with the most
  // recent activity naturally sorts to the top.
  const groups = new Map();
  list.forEach((p) => {
    if (!groups.has(p.clientId)) groups.set(p.clientId, []);
    groups.get(p.clientId).push(p);
  });

  container.innerHTML = [...groups.entries()]
    .map(([clientId, payments]) => {
      const client = allClients.find((c) => c.id === clientId);
      const paidTotal = payments.filter((p) => p.status === "Paid").reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const pendingTotal = payments.filter((p) => p.status === "Pending").reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const collapseId = `party-${clientId}`;

      const rows = payments
        .map((p) => {
          const statusBadge =
            p.status === "Paid"
              ? `<span class="badge badge-soft-success rounded-pill">Paid</span>`
              : `<span class="badge badge-soft-warning rounded-pill">Pending</span>`;
          return `<tr>
            <td>${escapeHtml(p.billingPeriod || "—")}</td>
            <td class="font-mono">${escapeHtml(p.invoiceNo || p.invoiceRef || "—")}</td>
            <td>${formatCurrency(p.amount)}</td>
            <td>${formatDate(p.date)}</td>
            <td>${escapeHtml(p.mode || "—")}</td>
            <td>${statusBadge}</td>
            <td class="text-end">
              <div class="row-actions">
                <button class="btn btn-outline-secondary btn-sm" data-edit="${p.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
                <button class="btn btn-outline-danger btn-sm" data-delete="${p.id}" title="Delete" ${session.role !== "admin" ? "disabled" : ""}><i class="fa-solid fa-trash"></i></button>
              </div>
            </td>
          </tr>`;
        })
        .join("");

      return `<div class="party-item">
        <div class="party-row" data-bs-toggle="collapse" data-bs-target="#${collapseId}" aria-expanded="false" aria-controls="${collapseId}" role="button">
          <span class="chevron"><i class="fa-solid fa-chevron-right"></i></span>
          <span class="avatar-chip">${initials(client?.businessName) || "GM"}</span>
          <div class="party-name-wrap">
            <div class="cell-primary">${escapeHtml(client?.businessName || "Unknown client")}</div>
            <div class="cell-sub font-mono">${escapeHtml(client?.gstin || "")}</div>
          </div>
          <div class="party-meta">
            ${paidTotal ? `<span class="badge badge-soft-success rounded-pill">Paid ${formatCurrency(paidTotal)}</span>` : ""}
            ${pendingTotal ? `<span class="badge badge-soft-warning rounded-pill">Pending ${formatCurrency(pendingTotal)}</span>` : ""}
            <span class="small text-muted-soft">${payments.length} record${payments.length === 1 ? "" : "s"}</span>
          </div>
        </div>
        <div class="collapse" id="${collapseId}">
          <div class="party-payments-table">
            <div class="inner-card table-responsive">
              <table class="table">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Invoice / Ref</th>
                    <th>Amount</th>
                    <th>Date</th>
                    <th>Mode</th>
                    <th>Status</th>
                    <th class="text-end">Actions</th>
                  </tr>
                </thead>
                <tbody>${rows}</tbody>
              </table>
            </div>
          </div>
        </div>
      </div>`;
    })
    .join("");

  container.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditPayment(btn.dataset.edit);
    })
  );
  container.querySelectorAll("[data-delete]:not([disabled])").forEach((btn) =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deletePayment(btn.dataset.delete);
    })
  );
}

/** Groups pending payments by billing period so staff can see which parties owe for which month. */
function renderPendingByMonth(scoped) {
  const tbody = document.getElementById("pendingByMonthBody");
  const empty = document.getElementById("pendingByMonthEmptyState");
  const tabCount = document.getElementById("pendingMonthTabCount");
  if (!tbody) return;

  const pending = scoped.filter((p) => p.status === "Pending");
  tabCount.textContent = pending.length;

  const groups = new Map();
  pending.forEach((p) => {
    const key = p.billingPeriod || "Unspecified";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  });

  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === "Unspecified") return 1;
    if (b === "Unspecified") return -1;
    return new Date(`01 ${b}`) - new Date(`01 ${a}`);
  });

  if (sortedKeys.length === 0) {
    tbody.innerHTML = "";
    empty.classList.remove("d-none");
    return;
  }
  empty.classList.add("d-none");

  tbody.innerHTML = sortedKeys
    .map((key) => {
      const records = groups.get(key);
      const total = records.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
      const parties = records
        .map((p) => {
          const client = allClients.find((c) => c.id === p.clientId);
          if (!client) {
            return `<span class="badge badge-soft-danger rounded-pill me-1 mb-1">Unknown</span>`;
          }
          // Opens in the SAME window, not a new tab: a new browsing context
          // opened from an installed PWA (target="_blank") does not
          // reliably share this app's session storage, which was bouncing
          // the user to the login page when they picked a party here.
          return `<a href="invoice.html?client=${encodeURIComponent(client.id)}" class="badge badge-soft-danger rounded-pill me-1 mb-1 text-decoration-none" title="View all pending invoices for ${escapeHtml(client.businessName)}">${escapeHtml(client.businessName)}</a>`;
        })
        .join("");
      return `<tr>
        <td class="fw-semibold">${escapeHtml(key)}</td>
        <td>${parties}</td>
        <td>${records.length}</td>
        <td class="text-end fw-semibold">${formatCurrency(total)}</td>
      </tr>`;
    })
    .join("");
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll("#paymentTabs .nav-link").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
  document.getElementById("allPaymentsPane").classList.toggle("d-none", tab !== "all");
  document.getElementById("pendingByMonthPane").classList.toggle("d-none", tab !== "pendingByMonth");
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wireEvents() {
  document.getElementById("paymentSearch").addEventListener("input", render);
  document.getElementById("paymentStatusFilter").addEventListener("change", render);
  document.getElementById("paymentClientFilter").addEventListener("change", render);
  document.getElementById("paymentPeriodFilter").addEventListener("change", render);

  document.querySelectorAll("#paymentTabs .nav-link").forEach((btn) =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab))
  );

  document.getElementById("addPaymentBtn").addEventListener("click", () => {
    if (visibleClients().length === 0) {
      toast("Add a client before recording a payment.", "danger");
      return;
    }
    document.getElementById("paymentForm").reset();
    document.getElementById("paymentId").value = "";
    document.getElementById("paymentOffcanvasTitle").textContent = "Add Payment";
    document.getElementById("paymentDate").value = new Date().toISOString().slice(0, 10);
    document.getElementById("paymentStatus").value = "Pending";
    document.getElementById("paymentBaseFee").value = "";
    document.getElementById("paymentExtraAmount").value = "0";
    document.getElementById("paymentBaseFeeHint").textContent = "Select a client to auto-fill";
    paymentOffcanvas.show();
  });

  document.getElementById("paymentClientId").addEventListener("change", () => applyBaseFeeForSelectedClient(false));
  document.getElementById("paymentExtraAmount").addEventListener("input", recalcTotalAmount);

  document.getElementById("paymentForm").addEventListener("submit", onSavePayment);
}

/**
 * Pulls the selected client's fixed monthly fee into the Fixed Fee field
 * and recomputes the total. When `preserveExtra` is false (fresh client
 * pick) the Additional Amount resets to 0 so the total lands exactly on
 * the client's configured fee unless the user deliberately adds more.
 */
function applyBaseFeeForSelectedClient(preserveExtra) {
  const clientId = document.getElementById("paymentClientId").value;
  const client = allClients.find((c) => c.id === clientId);
  const baseFeeInput = document.getElementById("paymentBaseFee");
  const hint = document.getElementById("paymentBaseFeeHint");
  const extraInput = document.getElementById("paymentExtraAmount");

  if (!client) {
    baseFeeInput.value = "";
    hint.textContent = "Select a client to auto-fill";
    if (!preserveExtra) extraInput.value = "0";
    recalcTotalAmount();
    return;
  }

  if (client.monthlyFee != null && client.monthlyFee !== "") {
    baseFeeInput.value = client.monthlyFee;
    hint.textContent = `Auto-filled from ${client.businessName}'s fixed fee`;
  } else {
    baseFeeInput.value = "";
    hint.textContent = `No fixed fee set for ${client.businessName} — set one in Clients, or enter the full amount as Additional`;
  }

  if (!preserveExtra) extraInput.value = "0";
  recalcTotalAmount();
}

/** Total Amount = Fixed Fee + Additional Amount, kept in sync as either input changes. */
function recalcTotalAmount() {
  const base = Number(document.getElementById("paymentBaseFee").value) || 0;
  const extra = Number(document.getElementById("paymentExtraAmount").value) || 0;
  document.getElementById("paymentAmount").value = base + extra;
}

function openEditPayment(id) {
  const p = allPayments.find((x) => x.id === id);
  if (!p) return;
  document.getElementById("paymentOffcanvasTitle").textContent = "Edit Payment";
  document.getElementById("paymentId").value = p.id;
  document.getElementById("paymentClientId").value = p.clientId || "";
  document.getElementById("paymentPeriod").value = p.billingPeriod || "";

  // Work out what the fixed fee would be for this client. If the record
  // already had a real amount saved, split it into fee + extra so editing
  // preserves that breakdown. If it was never actually set (₹0 placeholder,
  // e.g. auto-created from a filing), don't reverse-engineer a negative
  // "additional" — just auto-fill the total straight from the fixed fee.
  const client = allClients.find((c) => c.id === p.clientId);
  const baseFee = client?.monthlyFee != null && client.monthlyFee !== "" ? Number(client.monthlyFee) : 0;
  const savedAmount = Number(p.amount) || 0;
  document.getElementById("paymentBaseFee").value = baseFee || "";
  document.getElementById("paymentBaseFeeHint").textContent = client
    ? baseFee
      ? `Auto-filled from ${client.businessName}'s fixed fee`
      : `No fixed fee set for ${client.businessName}`
    : "Select a client to auto-fill";
  const extra = savedAmount > 0 ? savedAmount - baseFee : 0;
  document.getElementById("paymentExtraAmount").value = extra;
  document.getElementById("paymentAmount").value = savedAmount > 0 ? savedAmount : baseFee;
  document.getElementById("paymentDate").value = (p.date || "").slice(0, 10);
  document.getElementById("paymentMode").value = p.mode || "Cash";
  document.getElementById("paymentStatus").value = p.status || "Pending";
  document.getElementById("paymentNotes").value = p.notes || "";
  paymentOffcanvas.show();
}

async function onSavePayment(e) {
  e.preventDefault();
  const clientId = document.getElementById("paymentClientId").value;
  const amount = Number(document.getElementById("paymentAmount").value);
  const date = document.getElementById("paymentDate").value;
  const editingId = document.getElementById("paymentId").value;

  if (!clientId) {
    toast("Please select a client.", "danger");
    return;
  }
  // Staff can only record payments for their own assigned clients.
  if (!visibleClients().some((c) => c.id === clientId)) {
    toast("You can only record payments for your assigned clients.", "danger");
    return;
  }
  if (Number.isNaN(amount) || amount < 0 || document.getElementById("paymentAmount").value === "") {
    toast("Please enter a valid amount.", "danger");
    return;
  }
  if (!date) {
    toast("Please select a date.", "danger");
    return;
  }

  const now = new Date().toISOString();
  const client = allClients.find((c) => c.id === clientId);
  const existing = editingId ? allPayments.find((p) => p.id === editingId) : null;
  // Invoice numbers are always auto-generated (never typed in) — every
  // payment gets one fixed number the moment it's created, and keeps it
  // unchanged on every later edit.
  const invoiceNo = existing?.invoiceNo || (await DB.getNextInvoiceNumber());
  const record = {
    id: editingId || DB.uid("pay"),
    clientId,
    billingPeriod: document.getElementById("paymentPeriod").value,
    amount,
    date,
    mode: document.getElementById("paymentMode").value,
    status: document.getElementById("paymentStatus").value,
    invoiceNo,
    notes: document.getElementById("paymentNotes").value.trim(),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  await DB.put(DB.STORES.payments, record);
  await DB.logActivity(
    `${editingId ? "Updated" : "Recorded"} payment of ${formatCurrency(amount)} for "${client?.businessName || "client"}"`,
    editingId ? "fa-pen" : "fa-indian-rupee-sign",
    record.status === "Paid" ? "success" : "info"
  );

  toast(`Payment ${editingId ? "updated" : "recorded"} successfully.`, "success");
  paymentOffcanvas.hide();
  await loadData();
  render();
}

async function deletePayment(id) {
  if (session.role !== "admin") return;
  const p = allPayments.find((x) => x.id === id);
  if (!p) return;
  const ok = await confirmAdminDelete("Delete this payment record? It will move to Trash.");
  if (!ok) return;

  await DB.softDelete(DB.STORES.payments, id, session.username);
  await DB.logActivity("Deleted a payment record (moved to Trash)", "fa-trash", "danger");
  toast("Payment moved to Trash. Recoverable for 30 days.", "success");
  await loadData();
  render();
}

document.addEventListener("DOMContentLoaded", init);
