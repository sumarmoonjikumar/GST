import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, currentFY, fyMonths, formatCurrency, formatDate } from "./utils.js";
import { initAppChrome } from "./chrome.js";
import { buildFilingMap, getFilingStatus, periodHasStarted } from "./gst-status.js";

applyStoredTheme();
const session = requireSession(["customer"]);

async function init() {
  if (!session || !session.clientId) return;
  initAppChrome(session);

  const [client, gstRecords, payments] = await Promise.all([
    DB.get(DB.STORES.clients, session.clientId),
    DB.getByIndex(DB.STORES.gstRecords, "clientId", session.clientId),
    DB.getByIndex(DB.STORES.payments, "clientId", session.clientId),
  ]);

  if (!client) return;

  renderClientHeader(client);
  renderFiling(client, gstRecords);
  renderPayments(client, payments);
}

function renderClientHeader(client) {
  document.getElementById("cdBusinessName").textContent = client.businessName || "—";
  document.getElementById("cdGstin").textContent = client.gstin || "—";
  document.getElementById("cdFrequency").textContent = client.gstFrequency === "Quarterly" ? "Quarterly (QRMP)" : "Monthly";
  document.getElementById("cdStatus").textContent = client.status || "Active";

  const statementBtn = document.getElementById("cdViewStatementBtn");
  if (statementBtn) statementBtn.href = `invoice.html?client=${encodeURIComponent(client.id)}`;
}

function setStat(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value;
  el.classList.remove("skeleton");
}

function renderFiling(client, gstRecords) {
  const fy = currentFY();
  document.getElementById("cdFyLabel").textContent = fy;

  const filingMap = buildFilingMap(gstRecords);
  const months = fyMonths(fy).filter((m) => periodHasStarted(m.month, m.year));
  const freq = client.gstFrequency === "Quarterly" ? "Quarterly" : "Monthly";

  let gstr1Pending = 0;
  let gstr3bPending = 0;

  const rows = months
    .slice()
    .reverse()
    .map((m) => {
      const r1 = getFilingStatus(filingMap, client.id, m.key, "GSTR-1", freq);
      const r3b = getFilingStatus(filingMap, client.id, m.key, "GSTR-3B", freq);
      if (r1.status !== "Filed") gstr1Pending++;
      if (r3b.status !== "Filed") gstr3bPending++;
      return `
        <tr>
          <td>${m.label}</td>
          <td>${statusPill(r1.status)}</td>
          <td>${statusPill(r3b.status)}</td>
        </tr>`;
    })
    .join("");

  document.getElementById("cdFilingBody").innerHTML =
    rows || `<tr><td colspan="3" class="text-center text-muted-soft py-4">No filing periods due yet this FY.</td></tr>`;

  setStat("statGstr1Pending", gstr1Pending);
  setStat("statGstr3bPending", gstr3bPending);
}

function statusPill(status) {
  if (status === "Filed") {
    return `<span class="badge badge-soft-success"><i class="fa-solid fa-circle-check me-1"></i>Filed</span>`;
  }
  return `<span class="badge badge-soft-warning"><i class="fa-solid fa-clock me-1"></i>Pending</span>`;
}

function renderPayments(client, payments) {
  const pending = payments
    .filter((p) => p.status !== "Paid")
    .sort((a, b) => {
      const da = a.billingPeriod ? new Date(`01 ${a.billingPeriod}`) : new Date(a.date || 0);
      const db = b.billingPeriod ? new Date(`01 ${b.billingPeriod}`) : new Date(b.date || 0);
      return da - db;
    });

  const paid = payments
    .filter((p) => p.status === "Paid")
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))
    .slice(0, 5);

  const totalDue = pending.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  setStat("statPaymentsPendingCount", pending.length);
  setStat("statPaymentsPendingAmount", formatCurrency(totalDue));

  const listEl = document.getElementById("cdPaymentsList");
  if (pending.length === 0) {
    listEl.innerHTML = `<p class="text-center text-muted-soft py-4 mb-0"><i class="fa-solid fa-circle-check text-success me-1"></i>All caught up — nothing pending.</p>`;
  } else {
    listEl.innerHTML = pending
      .map(
        (p) => `
        <div class="d-flex justify-content-between align-items-center py-2 border-bottom">
          <div>
            <div class="fw-semibold small">${escapeHtml(p.billingPeriod || "—")}</div>
            <div class="text-muted-soft" style="font-size:10.5px;">${escapeHtml(p.invoiceNo || "")}</div>
          </div>
          <div class="text-end">
            <div class="fw-semibold small">${formatCurrency(p.amount)}</div>
            <a class="small" href="invoice.html?client=${encodeURIComponent(client.id)}${p.invoiceNo ? `&invoice=${encodeURIComponent(p.invoiceNo)}` : ""}">View Invoice</a>
          </div>
        </div>`
      )
      .join("");
  }

  const historyEl = document.getElementById("cdPaymentHistory");
  if (paid.length === 0) {
    historyEl.innerHTML = `<p class="text-center text-muted-soft py-3 mb-0">No payments recorded yet.</p>`;
  } else {
    historyEl.innerHTML = paid
      .map(
        (p) => `
        <div class="d-flex justify-content-between align-items-center py-2 border-bottom">
          <div>
            <div class="fw-semibold small">${escapeHtml(p.billingPeriod || formatDate(p.date))}</div>
            <div class="text-muted-soft" style="font-size:10.5px;">${escapeHtml(p.mode || "")}</div>
          </div>
          <div class="fw-semibold small">${formatCurrency(p.amount)}</div>
        </div>`
      )
      .join("");
  }
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.addEventListener("DOMContentLoaded", init);
