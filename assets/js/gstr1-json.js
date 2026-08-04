import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, toast, currentFY, fyList, initials } from "./utils.js";
import { initAppChrome } from "./chrome.js";
import { buildFilingMap, getFilingStatus, periodHasStarted, isQuarterEndMonth } from "./gst-status.js";

applyStoredTheme();
const session = requireSession(["admin", "staff"]);

/* =========================================================
   State
   ========================================================= */
let allClients = [];
let allStaff = [];
let allGstRecords = [];
let filingMap = new Map();
let selectedClient = null;
let selectedPeriod = null; // { monthKey, monthLabel, dueDate, freq }
let builderModal;
let activeSection = "b2b";

const parsedRows = { b2b: [], b2cs: [], hsn: [], doc: [] };
const sectionHasErrors = { b2b: false, b2cs: false, hsn: false, doc: false };

const FY_MONTH_TO_NUM = { Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12", Jan: "01", Feb: "02", Mar: "03" };
const VALID_RATES = [0, 0.1, 0.25, 1, 1.5, 3, 5, 6, 7.5, 12, 18, 28];
const VALID_UQC = new Set([
  "BAG-BAGS","BAL-BALE","BDL-BUNDLES","BKL-BUCKLES","BOU-BILLIONS OF UNITS","BOX-BOX","BTL-BOTTLES","BUN-BUNCHES",
  "CAN-CANS","CBM-CUBIC METERS","CCM-CUBIC CENTIMETERS","CMS-CENTIMETERS","CTN-CARTONS","DOZ-DOZENS","DRM-DRUMS",
  "GGK-GREAT GROSS","GMS-GRAMMES","GRS-GROSS","GYD-GROSS YARDS","KGS-KILOGRAMS","KLR-KILOLITRE","KME-KILOMETRE",
  "MLT-MILLILITRE","MTR-METERS","MTS-METRIC TON","NOS-NUMBERS","PAC-PACKS","PCS-PIECES","PRS-PAIRS","QTL-QUINTAL",
  "ROL-ROLLS","SET-SETS","SQF-SQUARE FEET","SQM-SQUARE METERS","SQY-SQUARE YARDS","TBS-TABLETS","TGM-TEN GROSS",
  "THD-THOUSANDS","TON-TONNES","TUB-TUBES","UGS-US GALLONS","UNT-UNITS","YDS-YARDS","OTH-OTHERS","NA-NOT APPLICABLE",
]);
const DOC_NATURE_MAP = [
  { key: 1, names: ["invoices for outward supply", "outward supply invoice", "invoice", "tax invoice"] },
  { key: 2, names: ["invoices for inward supply from unregistered person", "inward supply invoice", "purchase from urd"] },
  { key: 3, names: ["revised invoice", "revised invoices"] },
  { key: 4, names: ["debit note", "debit notes"] },
  { key: 5, names: ["credit note", "credit notes"] },
  { key: 6, names: ["receipt voucher", "receipt vouchers"] },
  { key: 7, names: ["payment voucher", "payment vouchers"] },
  { key: 8, names: ["refund voucher", "refund vouchers"] },
  { key: 9, names: ["delivery challan for job work", "job work challan"] },
  { key: 10, names: ["delivery challan for supply on approval", "approval challan"] },
  { key: 11, names: ["delivery challan in case of liquid gas", "liquid gas challan"] },
  { key: 12, names: ["delivery challan in cases other than by way of supply", "other delivery challan"] },
];
const STATE_CODES = {
  "01": "Jammu and Kashmir", "02": "Himachal Pradesh", "03": "Punjab", "04": "Chandigarh", "05": "Uttarakhand",
  "06": "Haryana", "07": "Delhi", "08": "Rajasthan", "09": "Uttar Pradesh", "10": "Bihar", "11": "Sikkim",
  "12": "Arunachal Pradesh", "13": "Nagaland", "14": "Manipur", "15": "Mizoram", "16": "Tripura", "17": "Meghalaya",
  "18": "Assam", "19": "West Bengal", "20": "Jharkhand", "21": "Odisha", "22": "Chhattisgarh", "23": "Madhya Pradesh",
  "24": "Gujarat", "26": "Dadra and Nagar Haveli and Daman and Diu", "27": "Maharashtra", "28": "Andhra Pradesh (Old)",
  "29": "Karnataka", "30": "Goa", "31": "Lakshadweep", "32": "Kerala", "33": "Tamil Nadu", "34": "Puducherry",
  "35": "Andaman and Nicobar Islands", "36": "Telangana", "37": "Andhra Pradesh", "38": "Ladakh", "97": "Other Territory",
};
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;

async function init() {
  if (!session) return;
  initAppChrome(session);
  builderModal = new bootstrap.Modal(document.getElementById("gstr1BuilderModal"));

  populateFYFilter();
  await loadData();
  renderClientList();
  wireEvents();
}

function populateFYFilter() {
  const sel = document.getElementById("fyFilter");
  fyList(6).forEach((fy, idx) => sel.add(new Option(fy + (idx === 0 ? " (Current)" : ""), fy)));
  sel.value = currentFY();
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
  const base = session.role === "staff" ? allClients.filter((c) => c.assignedStaffId === session.id) : allClients;
  const q = document.getElementById("clientSearch").value.trim().toLowerCase();
  return base.filter((c) => !q || `${c.businessName} ${c.gstin}`.toLowerCase().includes(q));
}

/* =========================================================
   Client list
   ========================================================= */
function renderClientList() {
  const list = document.getElementById("clientPickList");
  const empty = document.getElementById("clientListEmpty");
  const clients = visibleClients();

  if (clients.length === 0) {
    list.innerHTML = "";
    empty.classList.remove("d-none");
    return;
  }
  empty.classList.add("d-none");

  list.innerHTML = clients
    .map((c) => {
      const freq = c.gstFrequency === "Quarterly" ? "Quarterly" : "Monthly";
      const pendingCount = countPendingForClient(c);
      return `<div class="client-pick-row${selectedClient?.id === c.id ? " active" : ""}" data-client="${c.id}">
        <span class="avatar-chip">${initials(c.businessName) || "GM"}</span>
        <div>
          <div class="cp-name">${escapeHtml(c.businessName)}</div>
          <div class="cp-sub">${escapeHtml(c.gstin)} · ${freq}</div>
        </div>
        ${pendingCount > 0 ? `<span class="badge badge-soft-danger rounded-pill cp-badge">${pendingCount} pending</span>` : `<span class="badge badge-soft-success rounded-pill cp-badge"><i class="fa-solid fa-check"></i></span>`}
      </div>`;
    })
    .join("");

  list.querySelectorAll("[data-client]").forEach((row) =>
    row.addEventListener("click", () => selectClient(row.dataset.client))
  );
}

function countPendingForClient(client) {
  const fy = document.getElementById("fyFilter").value;
  const freq = client.gstFrequency === "Quarterly" ? "Quarterly" : "Monthly";
  const months = fyMonthsForFilter(fy);
  const periods = freq === "Quarterly" ? months.filter((m) => isQuarterEndMonth(m.month)) : months;
  let n = 0;
  periods.forEach((m) => {
    if (!periodHasStarted(m.month, m.year)) return;
    const rec = getFilingStatus(filingMap, client.id, m.key, "GSTR-1", freq);
    if (rec.status !== "Filed") n++;
  });
  return n;
}

const FY_MONTH_NAMES = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];
function fyMonthsForFilter(fy) {
  const startYear = parseInt(fy.split("-")[0], 10);
  return FY_MONTH_NAMES.map((name, idx) => {
    const year = idx <= 8 ? startYear : startYear + 1;
    return { key: `${name}-${year}`, label: `${name} ${year}`, month: name, year };
  });
}

const QUARTER_RANGE_LABEL = { Jun: "Q1 (Apr–Jun)", Sep: "Q2 (Jul–Sep)", Dec: "Q3 (Oct–Dec)", Mar: "Q4 (Jan–Mar)" };

function selectClient(clientId) {
  selectedClient = allClients.find((c) => c.id === clientId) || null;
  renderClientList();
  renderPendingListForClient();
}

/* =========================================================
   Pending GSTR-1 list for the selected client
   ========================================================= */
function renderPendingListForClient() {
  document.getElementById("noClientSelected").classList.toggle("d-none", !!selectedClient);
  document.getElementById("pendingListWrap").classList.toggle("d-none", !selectedClient);
  if (!selectedClient) return;

  document.getElementById("pendingListTitle").textContent = `GSTR-1 Pending — ${selectedClient.businessName}`;

  const fy = document.getElementById("fyFilter").value;
  const freq = selectedClient.gstFrequency === "Quarterly" ? "Quarterly" : "Monthly";
  const months = fyMonthsForFilter(fy);
  const periods = freq === "Quarterly" ? months.filter((m) => isQuarterEndMonth(m.month)) : months;
  const today = new Date().toISOString().slice(0, 10);

  const rows = [];
  periods.forEach((m) => {
    if (!periodHasStarted(m.month, m.year)) return;
    const rec = getFilingStatus(filingMap, selectedClient.id, m.key, "GSTR-1", freq);
    if (rec.status === "Filed") return;
    rows.push({
      monthKey: m.key,
      label: freq === "Quarterly" ? QUARTER_RANGE_LABEL[m.month] + " " + m.year : m.label,
      dueDate: rec.dueDate,
      overdue: rec.dueDate ? rec.dueDate < today : false,
      freq,
    });
  });
  rows.sort((a, b) => (a.dueDate || "").localeCompare(b.dueDate || ""));

  const wrap = document.getElementById("gp-pending-list");
  const emptyAllFiled = document.getElementById("pendingAllFiled");
  if (rows.length === 0) {
    wrap.innerHTML = "";
    emptyAllFiled.classList.remove("d-none");
    return;
  }
  emptyAllFiled.classList.add("d-none");

  wrap.innerHTML = rows
    .map(
      (r) => `<div class="gp-pending-row" data-month="${r.monthKey}" data-label="${escapeHtml(r.label)}" data-freq="${r.freq}">
        <span class="badge ${r.overdue ? "badge-soft-danger" : "badge-soft-warning"} rounded-pill"><i class="fa-solid fa-file-invoice me-1"></i>GSTR-1</span>
        <div>
          <div class="gp-period">${escapeHtml(r.label)}</div>
          <div class="gp-due">Due ${r.dueDate || "—"}${r.overdue ? " · Overdue" : ""}</div>
        </div>
        <i class="fa-solid fa-chevron-right gp-arrow"></i>
      </div>`
    )
    .join("");

  wrap.querySelectorAll("[data-month]").forEach((row) =>
    row.addEventListener("click", () =>
      openBuilder({ monthKey: row.dataset.month, label: row.dataset.label, freq: row.dataset.freq })
    )
  );
}

/* =========================================================
   Fullscreen builder modal
   ========================================================= */
function populateB2BDefaults() {
  const posSel = document.getElementById("b2bDefaultPos");
  posSel.innerHTML = Object.entries(STATE_CODES).map(([code, name]) => `<option value="${code}">${code} — ${name}</option>`).join("");
  const clientStateCode = String(selectedClient?.gstin || "").slice(0, 2);
  if (STATE_CODES[clientStateCode]) posSel.value = clientStateCode;
  document.getElementById("b2bDefaultRchrg").value = "N";
  document.getElementById("b2bDefaultHsn").value = "";
}

function openBuilder(period) {
  selectedPeriod = period;
  Object.keys(parsedRows).forEach((k) => {
    parsedRows[k] = [];
    sectionHasErrors[k] = false;
  });
  populateB2BDefaults();
  ["pasteB2B", "pasteB2CS", "pasteHSN", "pasteDOC"].forEach((id) => (document.getElementById(id).value = ""));
  ["previewB2B", "previewB2CS", "previewHSN", "previewDOC"].forEach((id) => (document.getElementById(id).innerHTML = ""));
  ["errB2B", "errB2CS", "errHSN", "errDOC"].forEach((id) => {
    const el = document.getElementById(id);
    el.classList.remove("show");
    el.innerHTML = "";
  });
  updateCounts();
  updateSummaryStrip();
  document.getElementById("finalErrorBanner").classList.remove("show");
  document.getElementById("finalErrorBanner").innerHTML = "";

  document.getElementById("builderTitle").textContent = `GSTR-1 — ${selectedClient.businessName} — ${period.label}`;
  document.getElementById("builderSubtitle").textContent = `GSTIN ${selectedClient.gstin} · Return Period ${monthKeyToFp(period.monthKey)}`;

  switchSection("b2b");
  builderModal.show();
}

function switchSection(section) {
  activeSection = section;
  document.querySelectorAll("#g1Tabs .g1-tab-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.section === section));
  document.querySelectorAll("[data-section-card]").forEach((card) => card.classList.toggle("active", card.dataset.sectionCard === section));
}

function monthKeyToFp(monthKey) {
  const [name, year] = monthKey.split("-");
  return `${FY_MONTH_TO_NUM[name] || "01"}${year}`;
}

/* =========================================================
   Paste parsing helpers
   ========================================================= */
function splitPastedText(raw) {
  return raw
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.includes("\t") ? line.split("\t") : line.split(",")).map((cell) => cell.trim()));
}

/** Drops a header row if the first cell looks like a label rather than data. */
function stripHeaderRow(rows, firstColIsNumericLike) {
  if (rows.length === 0) return rows;
  const first = rows[0][0] || "";
  if (firstColIsNumericLike) {
    // First data column should look like a GSTIN/HSN/POS code/number — if it's clearly alphabetic text, treat as header.
    if (/^[a-zA-Z\s./#-]+$/.test(first) && !/^\d/.test(first)) return rows.slice(1);
  } else if (/gstin|invoice|hsn|place|nature|document/i.test(first)) {
    return rows.slice(1);
  }
  return rows;
}

function num(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(String(v).replace(/[₹,\s]/g, ""));
  return isNaN(n) ? NaN : n;
}

function resolvePosCode(v) {
  const raw = String(v || "").trim();
  if (/^\d{1,2}$/.test(raw)) return raw.padStart(2, "0");
  const found = Object.entries(STATE_CODES).find(([, name]) => name.toLowerCase() === raw.toLowerCase());
  return found ? found[0] : raw;
}

function normalizeDate(v) {
  const raw = String(v || "").trim();
  // Accept DD-MM-YYYY, DD/MM/YYYY, or already-correct format.
  const m = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}-${m[3]}`;
  return raw;
}

/* =========================================================
   Section parsers — each returns { rows: [...], errors: [...] }
   ========================================================= */
/** Snaps a computed tax% to the nearest official GST slab (within a small tolerance for rounding in the source sheet). */
function nearestValidRate(computed) {
  if (VALID_RATES.includes(computed)) return computed;
  let nearest = VALID_RATES[0];
  VALID_RATES.forEach((r) => {
    if (Math.abs(r - computed) < Math.abs(nearest - computed)) nearest = r;
  });
  return Math.abs(nearest - computed) <= 0.3 ? nearest : null;
}

const DATE_RE = /^\d{1,2}[/-]\d{1,2}[/-]\d{4}$/;

/**
 * Deliberately loose about what sits between the GSTIN and the numbers —
 * real ledger exports often carry a party name and/or a billing-period
 * column (e.g. "SRV ENGINEERING", "Dec-25") that this tool doesn't need.
 * It locates the actual date cell by pattern instead of by fixed position,
 * and reads the trailing numeric cells as Taxable/IGST/CGST/SGST/Invoice
 * Value — or just Taxable/CGST/SGST/Invoice Value when the sheet has no
 * separate IGST column (typical for an all-intrastate client).
 */
function parseB2B(raw) {
  let rows = splitPastedText(raw);
  rows = stripHeaderRow(rows, true);

  const defaultPos = resolvePosCode(document.getElementById("b2bDefaultPos").value);
  const defaultRchrg = document.getElementById("b2bDefaultRchrg").value === "Y" ? "Y" : "N";
  const defaultHsn = String(document.getElementById("b2bDefaultHsn").value || "").replace(/\s/g, "");
  const posValid = /^\d{2}$/.test(defaultPos) && !!STATE_CODES[defaultPos];
  const hsnValid = /^\d{4,8}$/.test(defaultHsn) && [4, 6, 8].includes(defaultHsn.length);

  const out = [];
  const errors = [];
  rows.forEach((cells, i) => {
    const rowErrors = [];
    const inum = String(cells[0] || "").trim();
    const gstin = String(cells[1] || "").trim().toUpperCase();
    if (!GSTIN_RE.test(gstin)) rowErrors.push("Invalid recipient GSTIN");
    if (!inum) rowErrors.push("Invoice No missing");

    let dateIdx = -1;
    for (let c = 2; c < cells.length; c++) {
      if (DATE_RE.test(String(cells[c] || "").trim())) { dateIdx = c; break; }
    }
    const idt = dateIdx >= 0 ? normalizeDate(cells[dateIdx]) : "";
    if (dateIdx === -1) rowErrors.push("Couldn't find an Invoice Date (DD-MM-YYYY) in this row");

    const tail = (dateIdx >= 0 ? cells.slice(dateIdx + 1) : cells.slice(2))
      .map((c) => num(c))
      .filter((n) => !isNaN(n));
    let txvalNum = 0, igstNum = 0, cgstNum = 0, sgstNum = 0, valNum = 0;
    if (tail.length >= 5) {
      [txvalNum, igstNum, cgstNum, sgstNum, valNum] = tail.slice(-5);
    } else if (tail.length === 4) {
      [txvalNum, cgstNum, sgstNum, valNum] = tail; // no IGST column on this sheet
    } else {
      rowErrors.push("Couldn't find Taxable Value / tax / Invoice Value figures in this row");
    }
    if (!valNum) valNum = round2(txvalNum + igstNum + cgstNum + sgstNum);

    if (!posValid) rowErrors.push("Pick a valid Place of Supply above");
    if (!hsnValid) rowErrors.push("Set a valid default HSN/SAC code above (numeric, 4/6/8 digits)");
    if (txvalNum < 0 || igstNum < 0 || cgstNum < 0 || sgstNum < 0) rowErrors.push("Amounts can't be negative");
    if (igstNum > 0 && (cgstNum > 0 || sgstNum > 0)) rowErrors.push("A row can't have both IGST and CGST/SGST");

    let rateNum = 0;
    if (!rowErrors.length && txvalNum > 0) {
      const computed = Math.round(((igstNum + cgstNum + sgstNum) / txvalNum) * 400) / 4; // nearest 0.25%
      const snapped = nearestValidRate(computed);
      if (snapped === null) rowErrors.push(`Tax works out to ${computed}% of taxable value — not a valid GST slab, check the figures`);
      else rateNum = snapped;
    }

    out.push({
      raw: { gstin, inum, idt, val: valNum, pos: defaultPos, rchrg: defaultRchrg, hsn: defaultHsn, txval: txvalNum, rt: rateNum, igst: igstNum, cgst: cgstNum, sgst: sgstNum },
      errors: rowErrors,
    });
    rowErrors.forEach((e) => errors.push(`Row ${i + 1}: ${e}`));
  });
  return { rows: out, errors };
}

function parseB2CS(raw) {
  let rows = splitPastedText(raw);
  rows = stripHeaderRow(rows, true);
  const out = [];
  const errors = [];
  rows.forEach((cells, i) => {
    const [pos, rt, txval, igst, cgst, sgst] = cells;
    const rowErrors = [];
    const posCode = resolvePosCode(pos);
    if (!/^\d{2}$/.test(posCode) || !STATE_CODES[posCode]) rowErrors.push("Invalid Place of Supply");
    const rateNum = num(rt);
    if (isNaN(rateNum) || !VALID_RATES.includes(rateNum)) rowErrors.push(`Rate ${rt} is not a valid GST slab`);
    const txvalNum = num(txval);
    if (isNaN(txvalNum) || txvalNum < 0) rowErrors.push("Taxable Value invalid");
    const igstNum = num(igst), cgstNum = num(cgst), sgstNum = num(sgst);
    if ([igstNum, cgstNum, sgstNum].some((n) => isNaN(n) || n < 0)) rowErrors.push("Tax amounts invalid");
    if (igstNum > 0 && (cgstNum > 0 || sgstNum > 0)) rowErrors.push("A row can't have both IGST and CGST/SGST");

    out.push({
      raw: { pos: posCode, rt: rateNum, txval: txvalNum, igst: igstNum, cgst: cgstNum, sgst: sgstNum, sply_ty: igstNum > 0 ? "INTER" : "INTRA" },
      errors: rowErrors,
    });
    rowErrors.forEach((e) => errors.push(`Row ${i + 1}: ${e}`));
  });
  return { rows: out, errors };
}

function parseHSN(raw) {
  let rows = splitPastedText(raw);
  rows = stripHeaderRow(rows, true);
  const out = [];
  const errors = [];
  rows.forEach((cells, i) => {
    const [hsn, desc, uqc, qty, val, txval, igst, cgst, sgst] = cells;
    const rowErrors = [];
    const h = String(hsn || "").replace(/\s/g, "");
    if (!/^\d{4,8}$/.test(h) || ![4, 6, 8].includes(h.length)) rowErrors.push("HSN/SAC code must be numeric, 4/6/8 digits");
    let u = String(uqc || "").trim().toUpperCase();
    if (h.startsWith("99") && (!u || u === "OTH-OTHERS")) u = "NA-NOT APPLICABLE";
    if (!u.includes("-")) {
      const match = [...VALID_UQC].find((code) => code.startsWith(u + "-"));
      if (match) u = match;
    }
    if (!VALID_UQC.has(u)) rowErrors.push(`UQC "${uqc}" is not a valid unit code`);
    const qtyNum = num(qty);
    if (isNaN(qtyNum) || qtyNum < 0) rowErrors.push("Quantity invalid");
    const valNum = num(val);
    const txvalNum = num(txval);
    if (isNaN(txvalNum) || txvalNum < 0) rowErrors.push("Taxable Value invalid");
    const igstNum = num(igst), cgstNum = num(cgst), sgstNum = num(sgst);
    if ([igstNum, cgstNum, sgstNum].some((n) => isNaN(n) || n < 0)) rowErrors.push("Tax amounts invalid");

    out.push({
      raw: { hsn_sc: h, desc: desc || "", uqc: u, qty: qtyNum, val: valNum || txvalNum + igstNum + cgstNum + sgstNum, txval: txvalNum, igst: igstNum, cgst: cgstNum, sgst: sgstNum },
      errors: rowErrors,
    });
    rowErrors.forEach((e) => errors.push(`Row ${i + 1}: ${e}`));
  });
  return { rows: out, errors };
}

function matchDocNature(text) {
  const t = String(text || "").trim().toLowerCase();
  for (const entry of DOC_NATURE_MAP) {
    if (entry.names.some((n) => t.includes(n) || n.includes(t))) return entry.key;
  }
  return null;
}

function parseDOC(raw) {
  let rows = splitPastedText(raw);
  rows = stripHeaderRow(rows, false);
  const out = [];
  const errors = [];
  rows.forEach((cells, i) => {
    const [nature, from, to, total, cancel] = cells;
    const rowErrors = [];
    const docNum = matchDocNature(nature);
    if (!docNum) rowErrors.push(`Nature "${nature}" not recognised — use e.g. "Invoices for outward supply", "Credit Note", "Debit Note"`);
    if (!from || !to) rowErrors.push("Serial From/To missing");
    const totalNum = num(total);
    const cancelNum = num(cancel) || 0;
    if (isNaN(totalNum) || totalNum <= 0) rowErrors.push("Total Number invalid");
    if (cancelNum > totalNum) rowErrors.push("Cancelled count can't exceed Total Number");

    out.push({
      raw: { doc_num: docNum || 1, nature: nature || "", from: String(from || ""), to: String(to || ""), totnum: totalNum, cancel: cancelNum, net_issue: totalNum - cancelNum },
      errors: rowErrors,
    });
    rowErrors.forEach((e) => errors.push(`Row ${i + 1}: ${e}`));
  });
  return { rows: out, errors };
}

/* =========================================================
   Preview rendering
   ========================================================= */
function renderPreview(section, parsed) {
  const previewEl = document.getElementById(`preview${section.toUpperCase()}`);
  const errEl = document.getElementById(`err${section.toUpperCase()}`);

  if (parsed.rows.length === 0) {
    previewEl.innerHTML = `<div class="p-3 small text-muted-soft">Nothing parsed yet — paste rows above and click Parse &amp; Preview.</div>`;
    errEl.classList.remove("show");
    errEl.innerHTML = "";
    return;
  }

  const headersBySection = {
    b2b: ["#", "GSTIN", "Invoice No", "Date", "POS", "HSN", "Taxable", "Rate", "IGST", "CGST", "SGST", "Status"],
    b2cs: ["#", "POS", "Rate", "Taxable", "IGST", "CGST", "SGST", "Status"],
    hsn: ["#", "HSN", "Desc", "UQC", "Qty", "Taxable", "IGST", "CGST", "SGST", "Status"],
    doc: ["#", "Nature", "From", "To", "Total", "Cancelled", "Net", "Status"],
  };

  const rowsHtml = parsed.rows
    .map((r, i) => {
      const bad = r.errors.length > 0;
      const statusCell = bad
        ? `<span class="row-err-msg" title="${escapeHtml(r.errors.join("; "))}"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(r.errors[0])}${r.errors.length > 1 ? ` +${r.errors.length - 1}` : ""}</span>`
        : `<span class="row-ok-msg"><i class="fa-solid fa-check"></i> OK</span>`;
      let cells = "";
      if (section === "b2b") {
        const d = r.raw;
        cells = `<td>${i + 1}</td><td class="font-mono">${escapeHtml(d.gstin)}</td><td>${escapeHtml(d.inum)}</td><td>${escapeHtml(d.idt)}</td><td>${escapeHtml(d.pos)}</td><td class="font-mono">${escapeHtml(d.hsn)}</td><td class="text-end">${d.txval.toLocaleString("en-IN")}</td><td class="text-end">${d.rt}%</td><td class="text-end">${d.igst.toLocaleString("en-IN")}</td><td class="text-end">${d.cgst.toLocaleString("en-IN")}</td><td class="text-end">${d.sgst.toLocaleString("en-IN")}</td>`;
      } else if (section === "b2cs") {
        const d = r.raw;
        cells = `<td>${i + 1}</td><td>${escapeHtml(d.pos)}</td><td class="text-end">${d.rt}%</td><td class="text-end">${d.txval.toLocaleString("en-IN")}</td><td class="text-end">${d.igst.toLocaleString("en-IN")}</td><td class="text-end">${d.cgst.toLocaleString("en-IN")}</td><td class="text-end">${d.sgst.toLocaleString("en-IN")}</td>`;
      } else if (section === "hsn") {
        const d = r.raw;
        cells = `<td>${i + 1}</td><td class="font-mono">${escapeHtml(d.hsn_sc)}</td><td>${escapeHtml(d.desc)}</td><td>${escapeHtml(d.uqc)}</td><td class="text-end">${d.qty}</td><td class="text-end">${d.txval.toLocaleString("en-IN")}</td><td class="text-end">${d.igst.toLocaleString("en-IN")}</td><td class="text-end">${d.cgst.toLocaleString("en-IN")}</td><td class="text-end">${d.sgst.toLocaleString("en-IN")}</td>`;
      } else if (section === "doc") {
        const d = r.raw;
        cells = `<td>${i + 1}</td><td>${escapeHtml(d.nature)}</td><td>${escapeHtml(d.from)}</td><td>${escapeHtml(d.to)}</td><td class="text-end">${d.totnum}</td><td class="text-end">${d.cancel}</td><td class="text-end">${d.net_issue}</td>`;
      }
      return `<tr class="${bad ? "row-error" : ""}">${cells}<td>${statusCell}</td></tr>`;
    })
    .join("");

  previewEl.innerHTML = `<table class="table table-sm mb-0"><thead><tr>${headersBySection[section].map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rowsHtml}</tbody></table>`;

  if (parsed.errors.length > 0) {
    errEl.classList.add("show");
    errEl.innerHTML = `<strong>${parsed.errors.length} issue(s) found — fix these rows before generating the JSON:</strong><ul>${parsed.errors
      .slice(0, 12)
      .map((e) => `<li>${escapeHtml(e)}</li>`)
      .join("")}${parsed.errors.length > 12 ? `<li>…and ${parsed.errors.length - 12} more</li>` : ""}</ul>`;
  } else {
    errEl.classList.remove("show");
    errEl.innerHTML = "";
  }
}

function handleParse(section) {
  const textareaId = { b2b: "pasteB2B", b2cs: "pasteB2CS", hsn: "pasteHSN", doc: "pasteDOC" }[section];
  const raw = document.getElementById(textareaId).value;
  if (!raw.trim()) {
    toast("Paste some rows first.", "warning");
    return;
  }
  const parserFn = { b2b: parseB2B, b2cs: parseB2CS, hsn: parseHSN, doc: parseDOC }[section];
  const parsed = parserFn(raw);
  parsedRows[section] = parsed.rows;
  sectionHasErrors[section] = parsed.errors.length > 0;
  renderPreview(section, parsed);
  updateCounts();
  updateSummaryStrip();
  toast(`${parsed.rows.length} row(s) parsed for ${section.toUpperCase()}${parsed.errors.length ? ` — ${parsed.errors.length} issue(s)` : ""}.`, parsed.errors.length ? "warning" : "success");
}

function handleClear(section) {
  const textareaId = { b2b: "pasteB2B", b2cs: "pasteB2CS", hsn: "pasteHSN", doc: "pasteDOC" }[section];
  document.getElementById(textareaId).value = "";
  parsedRows[section] = [];
  sectionHasErrors[section] = false;
  document.getElementById(`preview${section.toUpperCase()}`).innerHTML = "";
  const errEl = document.getElementById(`err${section.toUpperCase()}`);
  errEl.classList.remove("show");
  errEl.innerHTML = "";
  updateCounts();
  updateSummaryStrip();
}

function updateCounts() {
  document.getElementById("countB2B").textContent = parsedRows.b2b.length;
  document.getElementById("countB2CS").textContent = parsedRows.b2cs.length;
  document.getElementById("countHSN").textContent = parsedRows.hsn.length;
  document.getElementById("countDOC").textContent = parsedRows.doc.length;
}

function updateSummaryStrip() {
  const taxableTotal = [
    ...parsedRows.b2b.map((r) => r.raw.txval),
    ...parsedRows.b2cs.map((r) => r.raw.txval),
  ].reduce((s, n) => s + n, 0);
  const taxTotal = [
    ...parsedRows.b2b.map((r) => r.raw.igst + r.raw.cgst + r.raw.sgst),
    ...parsedRows.b2cs.map((r) => r.raw.igst + r.raw.cgst + r.raw.sgst),
  ].reduce((s, n) => s + n, 0);
  const invoiceCount = new Set(parsedRows.b2b.map((r) => `${r.raw.gstin}|${r.raw.inum}`)).size;

  document.getElementById("g1SummaryStrip").innerHTML = `
    <div class="g1-summary-chip"><span class="n">${invoiceCount}</span>B2B Invoices</div>
    <div class="g1-summary-chip"><span class="n">${parsedRows.b2cs.length}</span>B2CS Rows</div>
    <div class="g1-summary-chip"><span class="n">${parsedRows.hsn.length}</span>HSN Rows</div>
    <div class="g1-summary-chip"><span class="n">${parsedRows.doc.length}</span>Doc Ranges</div>
    <div class="g1-summary-chip"><span class="n">₹${taxableTotal.toLocaleString("en-IN")}</span>Taxable Value</div>
    <div class="g1-summary-chip"><span class="n">₹${taxTotal.toLocaleString("en-IN")}</span>Total Tax</div>
  `;
}

/* =========================================================
   Build final GSTR-1 JSON (GSTN offline-tool schema)
   ========================================================= */
function buildGstr1Json() {
  const gstin = selectedClient.gstin;
  const fp = monthKeyToFp(selectedPeriod.monthKey);
  const json = { gstin, fp, version: "GST3.2.3" };

  // B2B — grouped by recipient GSTIN, then by invoice number.
  if (parsedRows.b2b.length) {
    const byCtin = new Map();
    parsedRows.b2b.forEach((r) => {
      const d = r.raw;
      if (!byCtin.has(d.gstin)) byCtin.set(d.gstin, new Map());
      const invMap = byCtin.get(d.gstin);
      if (!invMap.has(d.inum)) {
        invMap.set(d.inum, { inum: d.inum, idt: d.idt, val: d.val, pos: d.pos, rchrg: d.rchrg, inv_typ: "R", itms: [] });
      }
      const inv = invMap.get(d.inum);
      inv.itms.push({
        num: inv.itms.length + 1,
        itm_det: { txval: round2(d.txval), rt: d.rt, iamt: round2(d.igst), camt: round2(d.cgst), samt: round2(d.sgst), csamt: 0, hsn_sc: d.hsn },
      });
    });
    json.b2b = [...byCtin.entries()].map(([ctin, invMap]) => ({ ctin, inv: [...invMap.values()] }));
  }

  // B2C Small — one consolidated entry per parsed row.
  if (parsedRows.b2cs.length) {
    json.b2cs = parsedRows.b2cs.map((r) => ({
      sply_ty: r.raw.sply_ty,
      pos: r.raw.pos,
      typ: "OE",
      rt: r.raw.rt,
      txval: round2(r.raw.txval),
      iamt: round2(r.raw.igst),
      camt: round2(r.raw.cgst),
      samt: round2(r.raw.sgst),
      csamt: 0,
    }));
  }

  // HSN Summary
  if (parsedRows.hsn.length) {
    json.hsn = {
      data: parsedRows.hsn.map((r, i) => ({
        num: i + 1,
        hsn_sc: r.raw.hsn_sc,
        desc: r.raw.desc,
        uqc: r.raw.uqc,
        qty: r.raw.qty,
        val: round2(r.raw.val),
        txval: round2(r.raw.txval),
        iamt: round2(r.raw.igst),
        camt: round2(r.raw.cgst),
        samt: round2(r.raw.sgst),
        csamt: 0,
      })),
    };
  }

  // Documents Issued
  if (parsedRows.doc.length) {
    json.doc_issue = {
      doc_det: parsedRows.doc.map((r) => ({
        doc_num: r.raw.doc_num,
        docs: [{ num: 1, from: r.raw.from, to: r.raw.to, totnum: r.raw.totnum, cancel: r.raw.cancel, net_issue: r.raw.net_issue }],
      })),
    };
  }

  return json;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function handleGenerate() {
  const anySectionFilled = Object.values(parsedRows).some((r) => r.length > 0);
  if (!anySectionFilled) {
    toast("Parse at least one section before generating.", "warning");
    return;
  }
  const anyErrors = Object.values(sectionHasErrors).some(Boolean);
  const banner = document.getElementById("finalErrorBanner");
  if (anyErrors) {
    banner.classList.add("show");
    banner.innerHTML = `<strong>Fix the highlighted rows first.</strong> The rows in red above will cause the GST portal to reject the JSON — correct them, re-parse, then generate again.`;
    toast("Some rows still have errors — fix them before downloading.", "danger");
    return;
  }
  banner.classList.remove("show");
  banner.innerHTML = "";

  const json = buildGstr1Json();
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const fp = monthKeyToFp(selectedPeriod.monthKey);
  const safeName = (selectedClient.businessName || "client").replace(/[^a-zA-Z0-9]+/g, "_");
  const a = document.createElement("a");
  a.href = url;
  a.download = `GSTR1_${safeName}_${fp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  toast("GSTR-1 JSON generated — upload it under Returns Dashboard → Prepare Offline → Upload on the GST portal.", "success");
}

/* =========================================================
   Misc
   ========================================================= */
function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wireEvents() {
  document.getElementById("clientSearch").addEventListener("input", renderClientList);
  document.getElementById("fyFilter").addEventListener("change", () => {
    renderClientList();
    renderPendingListForClient();
  });

  document.querySelectorAll("#g1Tabs .g1-tab-btn").forEach((btn) =>
    btn.addEventListener("click", () => switchSection(btn.dataset.section))
  );

  document.querySelectorAll("[data-parse]").forEach((btn) =>
    btn.addEventListener("click", () => handleParse(btn.dataset.parse))
  );
  document.querySelectorAll("[data-clear]").forEach((btn) =>
    btn.addEventListener("click", () => handleClear(btn.dataset.clear))
  );

  document.getElementById("generateJsonBtn").addEventListener("click", handleGenerate);
}

document.addEventListener("DOMContentLoaded", init);
