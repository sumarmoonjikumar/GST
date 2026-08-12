import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, toast, currentFY, fyList, fyMonths, initials, whatsappLink } from "./utils.js";
import { initAppChrome } from "./chrome.js";
import { buildFilingMap, getFilingStatus, filingRecordId, periodHasStarted, isQuarterEndMonth } from "./gst-status.js";

applyStoredTheme();
const session = requireSession(["admin", "staff"]);

let allClients = [];
let allStaff = [];
let allGstRecords = [];
let filingMap = new Map();
let currentInvoiceBreakdown = [];
let statusModal;

async function init() {
  if (!session) return;
  initAppChrome(session);
  statusModal = new bootstrap.Modal(document.getElementById("filingStatusModal"));

  populateFYFilter();
  await loadData();
  applyQueryParams();
  populateMonthFilter();
  render();
  wireEvents();
}

function populateFYFilter() {
  const sel = document.getElementById("fyFilter");
  fyList(6).forEach((fy, idx) => sel.add(new Option(fy + (idx === 0 ? " (Current)" : ""), fy)));
  sel.value = currentFY();
}

function populateMonthFilter() {
  const sel = document.getElementById("monthFilter");
  sel.innerHTML = '<option value="">All Months</option>';
  fyMonths(document.getElementById("fyFilter").value).forEach((m) => sel.add(new Option(m.label, m.key)));
}

function applyQueryParams() {
  // type/status/due deep-link params no longer apply — the type dropdown
  // and pending rail they used to target have been removed.
}

async function loadData() {
  const [clients, staff, gstRecords] = await Promise.all([
    DB.getAll(DB.STORES.clients),
    DB.getAll(DB.STORES.staff),
    DB.getAll(DB.STORES.gstRecords),
  ]);
  allClients = clients;
  allStaff = staff;
  allGstRecords = gstRecords;
  filingMap = buildFilingMap(allGstRecords);
}

function visibleClients() {
  return session.role === "staff" ? allClients.filter((c) => c.assignedStaffId === session.id) : allClients;
}

function activeTypes() {
  return ["GSTR-1", "GSTR-3B"];
}

function activeMonths() {
  const fy = document.getElementById("fyFilter").value;
  const months = fyMonths(fy);
  const chosen = document.getElementById("monthFilter").value;
  return chosen ? months.filter((m) => m.key === chosen) : months;
}

/** "Monthly" (default) or "Quarterly" (QRMP) — drives due dates and how the matrix/pending list group a client's periods. */
function clientFrequency(c) {
  return c.gstFrequency === "Quarterly" ? "Quarterly" : "Monthly";
}

/** Quarterly clients only have a filing obligation on the quarter-end month (Jun/Sep/Dec/Mar) — every other month in view is filtered out. Monthly clients pass through unchanged. */
function applicablePeriods(client, months) {
  if (clientFrequency(client) !== "Quarterly") return months;
  return months.filter((m) => isQuarterEndMonth(m.month));
}

const QUARTER_RANGE_LABEL = { Jun: "Q1 (Apr–Jun)", Sep: "Q2 (Jul–Sep)", Dec: "Q3 (Oct–Dec)", Mar: "Q4 (Jan–Mar)" };
function quarterlyPeriodLabel(m) {
  return `${QUARTER_RANGE_LABEL[m.month] || m.month} ${m.year}`;
}

function render() {
  renderMatrix();
  renderSummary();
}

function renderSummary() {
  const clients = visibleClients();
  const months = activeMonths();
  const types = activeTypes();
  let total = 0, filed = 0, pending = 0, overdue = 0;
  const today = new Date().toISOString().slice(0, 10);

  clients.forEach((c) => {
    const freq = clientFrequency(c);
    applicablePeriods(c, months).forEach((m) => {
      if (!periodHasStarted(m.month, m.year)) return;
      types.forEach((type) => {
        total++;
        const rec = getFilingStatus(filingMap, c.id, m.key, type, freq);
        if (rec.status === "Filed") filed++;
        else {
          pending++;
          if (rec.dueDate && rec.dueDate < today) overdue++;
        }
      });
    });
  });

  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  set("statTotalFilings", total);
  set("statFiledCount", filed);
  set("statPendingCount", pending);
  set("statOverdueCount", overdue);

  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const bar = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.style.width = `${value}%`;
  };
  bar("statFiledBar", pct(filed));
  bar("statPendingBar", pct(pending));
  bar("statOverdueBar", pct(overdue));
}

function renderMatrix() {
  const clients = visibleClients();
  const months = activeMonths();
  const types = activeTypes();
  const head = document.getElementById("matrixHead");
  const body = document.getElementById("matrixBody");
  const empty = document.getElementById("matrixEmptyState");

  if (clients.length === 0) {
    head.innerHTML = "";
    body.innerHTML = "";
    empty.classList.remove("d-none");
    return;
  }
  empty.classList.add("d-none");

  // Fixed column widths (via colgroup) so the quarter-group header row and
  // the month header row below it always line up exactly, even with merged
  // (colspan) cells for quarterly clients.
  const colgroup = document.getElementById("matrixColgroup");
  if (colgroup) {
    colgroup.innerHTML = `<col style="width:232px">${months.map(() => `<col style="width:108px">`).join("")}`;
  }

  // Quarterly ledger divider — only meaningful once the full FY is on
  // screen; a single filtered month has nothing to group.
  const quarterRow =
    months.length === 12
      ? `<tr class="quarter-row">
          <th class="client-col">FY Quarter</th>
          ${["Q1 · Apr–Jun", "Q2 · Jul–Sep", "Q3 · Oct–Dec", "Q4 · Jan–Mar"]
            .map((label, i) => `<th colspan="3" class="${i > 0 ? "q-divider" : ""}">${label}</th>`)
            .join("")}
        </tr>`
      : "";

  head.innerHTML = `${quarterRow}<tr>
    <th class="client-col">Client</th>
    ${months.map((m, i) => `<th class="month-cell${months.length === 12 && i % 3 === 0 ? " q-divider" : ""}"><span class="month-head-label">${m.label}</span></th>`).join("")}
  </tr>`;

  const today = new Date().toISOString().slice(0, 10);

  const pillHtml = (c, monthKey, monthLabel, type, freq) => {
    const rec = getFilingStatus(filingMap, c.id, monthKey, type, freq);
    const overdue = rec.status !== "Filed" && rec.dueDate && rec.dueDate < today;
    const cls = rec.status === "Filed" ? "is-filed" : overdue ? "is-overdue" : "is-pending";
    const icon = rec.status === "Filed" ? "fa-check" : overdue ? "fa-exclamation" : "fa-clock";
    const label = type === "GSTR-1" ? "G1" : "3B";
    const statusLabel = rec.status === "Filed" ? "Filed" : overdue ? "Overdue" : "Pending";
    const valueNote = rec.taxableValue ? ` · Sales ₹${Number(rec.taxableValue).toLocaleString("en-IN")}` : "";
    const sub = freq === "Quarterly" ? `<span class="qtr-sub">QTR</span>` : "";
    return `<button type="button" class="filing-pill ${cls}" data-client="${c.id}" data-month="${monthKey}" data-type="${type}" title="${type} · ${monthLabel} · ${escapeHtml(c.businessName)} — ${statusLabel}${valueNote}"><i class="fa-solid ${icon}"></i>${label}${sub}</button>`;
  };

  body.innerHTML = clients
    .map((c) => {
      const freq = clientFrequency(c);
      let cells = "";

      if (freq === "Quarterly" && months.length === 12) {
        // Full FY view: merge each 3-month block into one quarter-end stamp.
        for (let i = 0; i < 12; i += 3) {
          const qEnd = months[i + 2];
          const qDivider = i > 0 ? " q-divider" : "";
          if (!periodHasStarted(qEnd.month, qEnd.year)) {
            cells += `<td colspan="3" class="month-cell not-due-qtr${qDivider}"><span class="not-due-cell">Not due yet</span></td>`;
            continue;
          }
          const pills = types.map((type) => pillHtml(c, qEnd.key, quarterlyPeriodLabel(qEnd), type, "Quarterly")).join("");
          cells += `<td colspan="3" class="month-cell quarterly-cell${qDivider}"><div class="filing-pill-group">${pills}</div></td>`;
        }
      } else {
        cells = months
          .map((m, i) => {
            const qDivider = months.length === 12 && i % 3 === 0 ? " q-divider" : "";
            if (freq === "Quarterly" && !isQuarterEndMonth(m.month)) {
              return `<td class="month-cell${qDivider}"><span class="not-due-cell">Quarterly</span></td>`;
            }
            if (!periodHasStarted(m.month, m.year)) {
              return `<td class="month-cell${qDivider}"><span class="small text-muted-soft">—</span></td>`;
            }
            const label = freq === "Quarterly" ? quarterlyPeriodLabel(m) : m.label;
            const pills = types.map((type) => pillHtml(c, m.key, label, type, freq)).join("");
            const qtrClass = freq === "Quarterly" ? " quarterly-cell" : "";
            return `<td class="month-cell${qDivider}${qtrClass}"><div class="filing-pill-group">${pills}</div></td>`;
          })
          .join("");
      }

      return `<tr>
        <td class="client-col">
          <div class="client-cell">
            <span class="avatar-chip">${initials(c.businessName) || "GM"}</span>
            <div>
              <div class="cell-primary">${escapeHtml(c.businessName)}${freq === "Quarterly" ? ` <span class="freq-tag" title="Quarterly filer (QRMP)">Q</span>` : ""}</div>
              <div class="cell-sub font-mono">${escapeHtml(c.gstin)}</div>
            </div>
          </div>
        </td>
        ${cells}
      </tr>`;
    })
    .join("");

  body.querySelectorAll(".filing-pill").forEach((btn) =>
    btn.addEventListener("click", () => openStatusModal(btn.dataset.client, btn.dataset.month, btn.dataset.type))
  );
}

function openStatusModal(clientId, monthKey, type, presetStatus) {
  const client = allClients.find((c) => c.id === clientId);
  const rec = getFilingStatus(filingMap, clientId, monthKey, type);
  const [monthName, year] = monthKey.split("-");

  document.getElementById("fClientId").value = clientId;
  document.getElementById("fMonthKey").value = monthKey;
  document.getElementById("fType").value = type;
  document.getElementById("fClientLabel").textContent = `${client?.businessName || "Unknown"} (${client?.gstin || ""})`;
  document.getElementById("fPeriodLabel").textContent = `${type} — ${monthName} ${year}`;
  document.getElementById("fStatus").value = presetStatus || rec.status;
  document.getElementById("fFiledDate").value = rec.filedDate ? rec.filedDate.slice(0, 10) : new Date().toISOString().slice(0, 10);
  document.getElementById("fNotes").value = rec.notes || "";
  renderInvoiceBreakdown(rec.invoiceBreakdown || []);
  toggleFiledDateVisibility();

  const waBtn = document.getElementById("fWaBtn");
  const waMsg =
    type === "GSTR-1"
      ? `Hi ${client?.contactPerson || client?.businessName}, please share your ${monthName} ${year} sales invoice details (B2B + B2C) for GSTR-1 filing at the earliest.`
      : `Hi ${client?.contactPerson || client?.businessName}, your GSTR-3B payment for ${monthName} ${year} is pending and the filing is due. Please send the tax amount at the earliest so we can complete the filing.`;
  const waHref = whatsappLink(client?.contactPhone, waMsg);
  waBtn.classList.toggle("d-none", !waHref);
  if (waHref) {
    waBtn.href = waHref;
    document.getElementById("fWaBtnLabel").textContent =
      type === "GSTR-1" ? "Ask for sales invoice details (WhatsApp)" : "Send payment reminder (WhatsApp)";
  }

  statusModal.show();
}

function formatInr(n) {
  return `₹${Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderInvoiceBreakdown(rows) {
  currentInvoiceBreakdown = rows || [];
  const wrap = document.getElementById("fInvoiceBreakdownWrap");
  const body = document.getElementById("fInvoiceBreakdownBody");

  if (!rows || rows.length === 0) {
    wrap.classList.add("d-none");
    body.innerHTML = "";
    return;
  }
  wrap.classList.remove("d-none");

  body.innerHTML = rows
    .map(
      (r) => `<tr>
        <td class="font-mono">${escapeHtml(r.invoiceNo)}</td>
        <td>${escapeHtml(r.date)}</td>
        <td>${escapeHtml(r.partyName)}</td>
        <td class="font-mono">${escapeHtml(r.gstin)}</td>
        <td class="text-end">${formatInr(r.taxable)}</td>
        <td class="text-end">${formatInr(r.igst)}</td>
        <td class="text-end">${formatInr(r.cgst)}</td>
        <td class="text-end">${formatInr(r.sgst)}</td>
        <td class="text-end">${formatInr(r.total)}</td>
      </tr>`
    )
    .join("");

  const sum = (key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
  document.getElementById("fSumTaxable").textContent = formatInr(sum("taxable"));
  document.getElementById("fSumIgst").textContent = formatInr(sum("igst"));
  document.getElementById("fSumCgst").textContent = formatInr(sum("cgst"));
  document.getElementById("fSumSgst").textContent = formatInr(sum("sgst"));
  document.getElementById("fSumTotal").textContent = formatInr(sum("total"));
}

function toggleFiledDateVisibility() {
  const isFiled = document.getElementById("fStatus").value === "Filed";
  document.getElementById("fFiledDateWrap").classList.toggle("d-none", !isFiled);
}

async function onSaveStatus(e) {
  e.preventDefault();
  const clientId = document.getElementById("fClientId").value;
  const monthKey = document.getElementById("fMonthKey").value;
  const type = document.getElementById("fType").value;
  const status = document.getElementById("fStatus").value;
  const client = allClients.find((c) => c.id === clientId);
  const wasAlreadyFiled = getFilingStatus(filingMap, clientId, monthKey, type).status === "Filed";
  const existingRec = getFilingStatus(filingMap, clientId, monthKey, type);

  const record = {
    id: filingRecordId(clientId, monthKey, type),
    clientId,
    monthKey,
    type,
    status,
    filedDate: status === "Filed" ? document.getElementById("fFiledDate").value : null,
    dueDate: existingRec.dueDate,
    notes: document.getElementById("fNotes").value.trim(),
    taxableValue: existingRec.taxableValue ?? null,
    taxAmount: existingRec.taxAmount ?? null,
    invoiceBreakdown: currentInvoiceBreakdown.length ? currentInvoiceBreakdown : null,
    updatedAt: new Date().toISOString(),
  };

  await DB.put(DB.STORES.gstRecords, record);
  await DB.logActivity(
    `${status === "Filed" ? "Marked filed" : "Marked pending"}: ${type} (${monthKey}) for "${client?.businessName || "client"}"`,
    status === "Filed" ? "fa-circle-check" : "fa-triangle-exclamation",
    status === "Filed" ? "success" : "warning"
  );

  toast(`${type} for ${monthKey} marked ${status}.`, "success");

  // GSTR-3B being filed for the first time: drop it into Payments as
  // Pending (if that client/month doesn't already have a payment record)
  // and open just this month's own invoice — not the party's whole
  // outstanding list.
  let invoiceInfo = null;
  if (type === "GSTR-3B" && status === "Filed" && !wasAlreadyFiled) {
    invoiceInfo = await ensurePendingPayment(clientId, monthKey, client);
  }

  statusModal.hide();
  await loadData();
  render();

  if (invoiceInfo) {
    // Same window, not a new tab — a new browsing context opened from an
    // installed PWA doesn't reliably share this app's session storage,
    // which was bouncing users to the login page.
    const url = `invoice.html?client=${encodeURIComponent(invoiceInfo.clientId)}&invoice=${encodeURIComponent(invoiceInfo.invoiceNo)}`;
    window.location.href = url;
  }
}

/** Billing-period label matching the payments module's format, e.g. "Jul-2026" -> "Jul 2026". */
function billingPeriodLabel(monthKey) {
  return monthKey.replace("-", " ");
}

/** Creates a Pending payment record for this client/month if one doesn't already exist, and always returns that specific record's own invoice number (minting one if it's missing) so the caller can open exactly this month's invoice — never the party's whole outstanding list. */
async function ensurePendingPayment(clientId, monthKey, client) {
  const period = billingPeriodLabel(monthKey);
  const existingPayments = await DB.getAll(DB.STORES.payments);
  let record = existingPayments.find((p) => p.clientId === clientId && p.billingPeriod === period);

  if (!record) {
    const now = new Date().toISOString();
    const fixedFee = client?.monthlyFee != null && client.monthlyFee !== "" ? Number(client.monthlyFee) : 0;
    record = {
      id: DB.uid("pay"),
      clientId,
      billingPeriod: period,
      amount: fixedFee,
      date: now.slice(0, 10),
      mode: "UPI",
      status: "Pending",
      invoiceRef: "",
      invoiceNo: await DB.getNextInvoiceNumber(),
      notes: fixedFee
        ? "Auto-created on GSTR-3B filing — amount from client's fixed fee."
        : "Auto-created on GSTR-3B filing — no fixed fee set for client, update the amount.",
      createdAt: now,
      updatedAt: now,
    };
    await DB.put(DB.STORES.payments, record);
    await DB.logActivity(
      `Payment marked Pending for "${client?.businessName || "client"}" — ${period} (GSTR-3B filed)`,
      "fa-indian-rupee-sign",
      "warning"
    );
  } else if (!record.invoiceNo) {
    record.invoiceNo = await DB.getNextInvoiceNumber();
    await DB.put(DB.STORES.payments, record);
  }

  return { clientId, invoiceNo: record.invoiceNo };
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wireEvents() {
  document.getElementById("fyFilter").addEventListener("change", () => {
    populateMonthFilter();
    render();
  });
  document.getElementById("monthFilter").addEventListener("change", render);

  document.getElementById("fStatus").addEventListener("change", toggleFiledDateVisibility);
  document.getElementById("filingStatusForm").addEventListener("submit", onSaveStatus);
}

document.addEventListener("DOMContentLoaded", init);
