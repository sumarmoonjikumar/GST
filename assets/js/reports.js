import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, toast, formatCurrency, currentFY, fyList, fyMonths } from "./utils.js";
import { initAppChrome } from "./chrome.js";
import { buildFilingMap, getFilingStatus, periodHasStarted } from "./gst-status.js";

applyStoredTheme();
const session = requireSession(["admin"]); // consolidated cross-client report — admin only

let allClients = [], allStaff = [], allGstRecords = [], allPayments = [];
let filingMap = new Map();
let lastRows = [];

async function init() {
  if (!session) return;
  initAppChrome(session);
  populateFYFilter();
  await loadData();
  populateStaffFilter();
  render();
  wireEvents();
}

function populateFYFilter() {
  const sel = document.getElementById("fyFilter");
  fyList(6).forEach((fy, idx) => sel.add(new Option(fy + (idx === 0 ? " (Current)" : ""), fy)));
  sel.value = currentFY();
}

function populateStaffFilter() {
  const sel = document.getElementById("staffFilter");
  allStaff.forEach((s) => sel.add(new Option(s.name, s.id)));
}

async function loadData() {
  const [clients, staff, gstRecords, payments] = await Promise.all([
    DB.getAll(DB.STORES.clients),
    DB.getAll(DB.STORES.staff),
    DB.getAll(DB.STORES.gstRecords),
    DB.getAll(DB.STORES.payments),
  ]);
  allClients = clients;
  allStaff = staff;
  allGstRecords = gstRecords;
  allPayments = payments;
  filingMap = buildFilingMap(allGstRecords);
}

function filteredClients() {
  const q = document.getElementById("clientSearch").value.trim().toLowerCase();
  const staffId = document.getElementById("staffFilter").value;
  return allClients.filter((c) => {
    if (q && !`${c.businessName} ${c.gstin}`.toLowerCase().includes(q)) return false;
    if (staffId && c.assignedStaffId !== staffId) return false;
    return true;
  });
}

function buildRow(client) {
  const fy = document.getElementById("fyFilter").value;
  const months = fyMonths(fy).filter((m) => periodHasStarted(m.month, m.year));
  const staffMember = allStaff.find((s) => s.id === client.assignedStaffId);

  let g1Filed = 0, g1Pending = 0, g3bFiled = 0, g3bPending = 0;
  months.forEach((m) => {
    const r1 = getFilingStatus(filingMap, client.id, m.key, "GSTR-1");
    r1.status === "Filed" ? g1Filed++ : g1Pending++;
    const r3b = getFilingStatus(filingMap, client.id, m.key, "GSTR-3B");
    r3b.status === "Filed" ? g3bFiled++ : g3bPending++;
  });

  const clientPayments = allPayments.filter((p) => p.clientId === client.id);
  const paidTotal = clientPayments.filter((p) => p.status === "Paid").reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const pendingTotal = clientPayments.filter((p) => p.status !== "Paid").reduce((s, p) => s + (Number(p.amount) || 0), 0);

  const overallOk = g1Pending === 0 && g3bPending === 0 && pendingTotal === 0;

  return {
    client, staffName: staffMember?.name || "Unassigned",
    g1Filed, g1Pending, g3bFiled, g3bPending, paidTotal, pendingTotal, overallOk,
  };
}

function render() {
  const rows = filteredClients().map(buildRow);
  lastRows = rows;
  const tbody = document.getElementById("reportTableBody");
  const empty = document.getElementById("reportEmptyState");
  document.getElementById("reportCountLabel").textContent = `${rows.length} client${rows.length === 1 ? "" : "s"}`;

  if (rows.length === 0) {
    tbody.innerHTML = "";
    empty.classList.remove("d-none");
    return;
  }
  empty.classList.add("d-none");

  tbody.innerHTML = rows
    .map((r) => `
      <tr>
        <td>
          <div class="cell-primary">${escapeHtml(r.client.businessName)}</div>
          <div class="cell-sub font-mono">${escapeHtml(r.client.gstin)}</div>
        </td>
        <td>${escapeHtml(r.staffName)}</td>
        <td>
          <span class="badge badge-soft-success rounded-pill">${r.g1Filed} Filed</span>
          <span class="badge badge-soft-danger rounded-pill">${r.g1Pending} Pending</span>
        </td>
        <td>
          <span class="badge badge-soft-success rounded-pill">${r.g3bFiled} Filed</span>
          <span class="badge badge-soft-danger rounded-pill">${r.g3bPending} Pending</span>
        </td>
        <td>${formatCurrency(r.paidTotal)}</td>
        <td>${r.pendingTotal > 0 ? `<span class="text-danger fw-semibold">${formatCurrency(r.pendingTotal)}</span>` : formatCurrency(0)}</td>
        <td>
          ${r.overallOk
            ? `<span class="badge badge-soft-success rounded-pill">Up to date</span>`
            : `<span class="badge badge-soft-danger rounded-pill">Action needed</span>`}
        </td>
      </tr>`)
    .join("");
}

function exportCsv() {
  if (lastRows.length === 0) {
    toast("Nothing to export for the current filters.", "danger");
    return;
  }
  const fy = document.getElementById("fyFilter").value;
  const header = ["Client", "GSTIN", "Staff", "GSTR-1 Filed", "GSTR-1 Pending", "GSTR-3B Filed", "GSTR-3B Pending", "Payments Paid", "Payments Pending", "Overall Status"];
  const lines = lastRows.map((r) => [
    r.client.businessName, r.client.gstin, r.staffName,
    r.g1Filed, r.g1Pending, r.g3bFiled, r.g3bPending,
    r.paidTotal, r.pendingTotal, r.overallOk ? "Up to date" : "Action needed",
  ].map(csvCell).join(","));
  const csv = [header.map(csvCell).join(","), ...lines].join("\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gst-master-report-${fy}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wireEvents() {
  document.getElementById("fyFilter").addEventListener("change", render);
  document.getElementById("staffFilter").addEventListener("change", render);
  document.getElementById("clientSearch").addEventListener("input", render);
  document.getElementById("exportCsvBtn").addEventListener("click", exportCsv);
}

document.addEventListener("DOMContentLoaded", init);
