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
let allSalesRecords = [];
let filingMap = new Map();
let savedSalesMap = new Map(); // key `${clientId}|${monthKey}` -> saved sales record
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
const DOC_TYP_LABELS = {
  1: "Invoices for outward supply",
  2: "Invoices for inward supply from unregistered person",
  3: "Revised Invoice",
  4: "Debit Note",
  5: "Credit Note",
  6: "Receipt voucher",
  7: "Payment Voucher",
  8: "Refund voucher",
  9: "Delivery Challan for job work",
  10: "Delivery Challan for supply on approval",
  11: "Delivery Challan in case of liquid gas",
  12: "Delivery Challan in cases other than by way of supply (excluding at S no. 9 to 11)",
};
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
  const [clients, staff, gstRecords, salesRecords] = await Promise.all([
    DB.getAll(DB.STORES.clients),
    DB.getAll(DB.STORES.staff),
    DB.getAll(DB.STORES.gstRecords),
    DB.getAll(DB.STORES.gstr1Sales),
  ]);
  allClients = clients;
  allStaff = staff;
  allGstRecords = gstRecords;
  allSalesRecords = salesRecords;
  filingMap = buildFilingMap(allGstRecords);
  savedSalesMap = new Map(allSalesRecords.map((r) => [`${r.clientId}|${r.monthKey}`, r]));
}

/** Deterministic doc id so re-saving the same client/period upserts one record. */
function salesRecordId(clientId, monthKey) {
  const safeMonth = String(monthKey).replace(/[^a-zA-Z0-9]/g, "");
  return `g1sales_${clientId}_${safeMonth}`;
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

  const showFiled = document.getElementById("showFiledToggle").checked;
  document.getElementById("pendingListTitle").textContent = `GSTR-1 ${showFiled ? "— All Periods" : "Pending"} — ${selectedClient.businessName}`;

  const fy = document.getElementById("fyFilter").value;
  const freq = selectedClient.gstFrequency === "Quarterly" ? "Quarterly" : "Monthly";
  const months = fyMonthsForFilter(fy);
  const periods = freq === "Quarterly" ? months.filter((m) => isQuarterEndMonth(m.month)) : months;
  const today = new Date().toISOString().slice(0, 10);

  const rows = [];
  periods.forEach((m) => {
    if (!periodHasStarted(m.month, m.year)) return;
    const rec = getFilingStatus(filingMap, selectedClient.id, m.key, "GSTR-1", freq);
    if (rec.status === "Filed" && !showFiled) return;
    rows.push({
      monthKey: m.key,
      label: freq === "Quarterly" ? QUARTER_RANGE_LABEL[m.month] + " " + m.year : m.label,
      dueDate: rec.dueDate,
      overdue: rec.dueDate ? rec.dueDate < today : false,
      filed: rec.status === "Filed",
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
    .map((r) => {
      const saved = savedSalesMap.has(`${selectedClient.id}|${r.monthKey}`);
      const statusBadge = r.filed
        ? `<span class="badge bg-success-subtle text-success-emphasis rounded-pill"><i class="fa-solid fa-circle-check me-1"></i>Filed</span>`
        : `<span class="badge ${r.overdue ? "badge-soft-danger" : "badge-soft-warning"} rounded-pill"><i class="fa-solid fa-file-invoice me-1"></i>GSTR-1</span>`;
      return `<div class="gp-pending-row" data-month="${r.monthKey}" data-label="${escapeHtml(r.label)}" data-freq="${r.freq}">
        ${statusBadge}
        <div>
          <div class="gp-period">${escapeHtml(r.label)}${saved ? ' <span class="badge bg-success-subtle text-success-emphasis rounded-pill ms-1"><i class="fa-solid fa-circle-check me-1"></i>Saved</span>' : ""}</div>
          <div class="gp-due">Due ${r.dueDate || "—"}${r.overdue && !r.filed ? " · Overdue" : ""}</div>
        </div>
        <i class="fa-solid fa-chevron-right gp-arrow"></i>
      </div>`;
    })
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
  lastUnregisteredB2B = [];
  populateB2BDefaults();
  initB2BGrid(8);
  initGrid("b2cs", 8);
  initGrid("hsn", 8);
  initGrid("doc", 5);
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

  const saved = savedSalesMap.get(`${selectedClient.id}|${period.monthKey}`);
  if (saved) {
    loadSavedSalesIntoBuilder(saved);
    const savedWhen = saved.updatedAt ? new Date(saved.updatedAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "";
    toast(`Loaded previously saved sales details for ${period.label}${savedWhen ? ` (saved ${savedWhen})` : ""}.`, "success");
  }

  switchSection("b2b");
  builderModal.show();
}

/** Repopulates the grids from a saved gstr1Sales record — used when reopening a period
 *  that already has data stored, so the party's sales details can be viewed/edited/exported anytime. */
function loadSavedSalesIntoBuilder(saved) {
  const sections = [
    { key: "b2b", rows: (saved.b2b || []).map((r) => ({ inum: r.inum, gstin: r.gstin, cname: r.cname, idt: r.idt, txval: r.txval, igst: r.igst, cgst: r.cgst, sgst: r.sgst, val: r.val, pos: r.pos, rchrg: r.rchrg, hsn: r.hsn })) },
    { key: "b2cs", rows: (saved.b2cs || []).map((r) => ({ pos: r.pos, rt: r.rt, txval: r.txval, igst: r.igst, cgst: r.cgst, sgst: r.sgst })) },
    { key: "hsn", rows: (saved.hsn || []).map((r) => ({ hsn: r.hsn_sc, desc: r.desc, uqc: r.uqc, qty: r.qty, val: r.val, txval: r.txval, igst: r.igst, cgst: r.cgst, sgst: r.sgst })) },
    { key: "doc", rows: (saved.doc || []).map((r) => ({ nature: r.nature, from: r.from, to: r.to, total: r.totnum, cancel: r.cancel })) },
  ];
  sections.forEach(({ key, rows }) => {
    if (rows.length) populateGridFromKeyedRows(key, rows);
  });
  lastUnregisteredB2B = saved.unregisteredB2B || [];
  handleParseB2B(true);
  handleParseGrid("b2cs", true);
  handleParseGrid("hsn", true);
  handleParseGrid("doc", true);
}

function switchSection(section) {
  activeSection = section;
  document.querySelectorAll("#g1Tabs .g1-tab-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.section === section));
  document.querySelectorAll("[data-section-card]").forEach((card) => card.classList.toggle("active", card.dataset.sectionCard === section));
  document.getElementById("sheetImportPanel").style.display = "none";

  if (section === "b2cs" && lastUnregisteredB2B.length) {
    const body = document.getElementById("b2csGridBody");
    const untouched = Array.from(body.querySelectorAll("tr")).every((tr) =>
      Array.from(tr.querySelectorAll("input[data-col]")).every((inp) => !inp.value.trim())
    );
    if (untouched) syncB2csFromUnregisteredB2B();
  }
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

/** Generic header-row detector used as a fallback when the column-based header
 *  match couldn't confidently map the sheet (e.g. a sample template whose first
 *  column is "Sr No." / "#" instead of a recognizable field name). Checks EVERY
 *  cell in the row — not just column 0 — against the section's known header
 *  vocabulary, so a header row never gets treated as a data row and pasted in
 *  as literal text like "Invoice Number" / "GSTIN" into the grid. */
function looksLikeHeaderRow(section, row) {
  if (!row) return false;
  const aliases = HEADER_ALIASES[section] || {};
  const words = Object.values(aliases).flat().map(normHeader);
  let hits = 0;
  row.forEach((cell) => {
    const nh = normHeader(cell);
    if (!nh) return;
    if (words.some((a) => a === nh || (a.length >= 4 && (nh.includes(a) || a.includes(nh))))) hits++;
  });
  return hits >= 2;
}

function num(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = Number(String(v).replace(/[₹,\s]/g, ""));
  return isNaN(n) ? NaN : n;
}

/** The official GST Excel format gives Rate + Taxable Value instead of
 *  explicit IGST/CGST/SGST amounts — the portal derives the split itself
 *  from Place of Supply vs the seller's own state. We do the same here on
 *  import, so a client's official-format Excel auto-fills correctly
 *  instead of silently landing with ₹0 tax. Only fills in what's missing —
 *  never overrides amounts the sheet already gave explicitly. */
function deriveB2BTaxSplit(vals, sellerStateCode) {
  const rate = num(vals.rt);
  const txval = num(vals.txval);
  const hasExplicitTax = ["igst", "cgst", "sgst"].some((k) => num(vals[k]) > 0);
  if (!rate || !txval || hasExplicitTax) return vals;
  const posCode = resolvePosCode(vals.pos);
  const taxAmt = round2((txval * rate) / 100);
  if (sellerStateCode && posCode === sellerStateCode) {
    vals.cgst = round2(taxAmt / 2);
    vals.sgst = round2(taxAmt / 2);
    vals.igst = 0;
  } else {
    vals.igst = taxAmt;
    vals.cgst = 0;
    vals.sgst = 0;
  }
  if (!vals.val) vals.val = round2(txval + taxAmt);
  return vals;
}

function resolvePosCode(v) {
  const raw = String(v || "").trim();
  if (/^\d{1,2}$/.test(raw)) return raw.padStart(2, "0");
  // "33-Tamil Nadu" / "33 - Tamil Nadu" (the official GST Excel format's style).
  const leading = raw.match(/^(\d{1,2})\D/);
  if (leading && STATE_CODES[leading[1].padStart(2, "0")]) return leading[1].padStart(2, "0");
  const exact = Object.entries(STATE_CODES).find(([, name]) => name.toLowerCase() === raw.toLowerCase());
  if (exact) return exact[0];
  const loose = Object.entries(STATE_CODES).find(([, name]) => raw.toLowerCase().includes(name.toLowerCase()));
  return loose ? loose[0] : raw;
}

const MONTH_NAME_TO_NUM = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function twoDigitYearTo4(y) {
  const n = parseInt(y, 10);
  return String(n <= 49 ? 2000 + n : 1900 + n);
}

/**
 * Accepts whatever date format the person's own Excel sheet happens to use —
 * DD-MM-YYYY, DD/MM/YYYY, YYYY-MM-DD, "04-Aug-2026", "Aug 4, 2026", 2-digit
 * years, even a raw Excel serial-date number (what you get when a date cell
 * wasn't formatted as a date before copying) — and always normalizes to
 * DD-MM-YYYY, which is what the GST portal's JSON schema expects.
 */
function normalizeDate(v) {
  const raw = String(v ?? "").trim();
  if (!raw) return "";

  // Excel serial date number, e.g. 45870 (days since 1899-12-30).
  if (/^\d{4,6}$/.test(raw)) {
    const serial = parseInt(raw, 10);
    if (serial > 20000 && serial < 60000) {
      const ms = Date.UTC(1899, 11, 30) + serial * 86400000;
      const d = new Date(ms);
      return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
    }
  }

  // Numeric separators: DD-MM-YYYY, DD/MM/YYYY, DD.MM.YYYY, or YYYY-MM-DD / YYYY/MM/DD (ISO), 2 or 4 digit years.
  let m = raw.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/);
  if (m) {
    let [, a, b, c] = m;
    if (a.length === 4) return `${c.padStart(2, "0")}-${b.padStart(2, "0")}-${a}`; // YYYY-MM-DD
    const year = c.length === 2 ? twoDigitYearTo4(c) : c;
    return `${a.padStart(2, "0")}-${b.padStart(2, "0")}-${year}`;
  }

  // DD-Mon-YYYY / DD Mon YY, e.g. "04-Aug-2026", "4 Aug 26".
  m = raw.match(/^(\d{1,2})[-\s]([a-zA-Z]{3,9})[-\s](\d{2,4})$/);
  if (m && MONTH_NAME_TO_NUM[m[2].slice(0, 3).toLowerCase()]) {
    const mon = MONTH_NAME_TO_NUM[m[2].slice(0, 3).toLowerCase()];
    const year = m[3].length === 2 ? twoDigitYearTo4(m[3]) : m[3];
    return `${m[1].padStart(2, "0")}-${String(mon).padStart(2, "0")}-${year}`;
  }

  // Mon-DD-YYYY / Mon DD, YYYY, e.g. "Aug-04-2026", "Aug 4, 2026".
  m = raw.match(/^([a-zA-Z]{3,9})[-\s](\d{1,2}),?[-\s](\d{2,4})$/);
  if (m && MONTH_NAME_TO_NUM[m[1].slice(0, 3).toLowerCase()]) {
    const mon = MONTH_NAME_TO_NUM[m[1].slice(0, 3).toLowerCase()];
    const year = m[3].length === 2 ? twoDigitYearTo4(m[3]) : m[3];
    return `${m[2].padStart(2, "0")}-${String(mon).padStart(2, "0")}-${year}`;
  }

  return raw; // couldn't recognize it — left as-is, row validation will flag it
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
/* ---------------------------------------------------------
   B2B editable grid — Invoice Number, GSTIN, Customer Name,
   Invoice Date, Taxable Amount, IGST, CGST, SGST, Total,
   Place of Supply, Reverse Charge, HSN/SAC — set per row,
   with Rate % worked out live. Paste from Excel fills across
   the row and adds new rows automatically.
   --------------------------------------------------------- */
const B2B_COLS = ["inum", "gstin", "cname", "idt", "txval", "igst", "cgst", "sgst", "val", "pos", "rchrg", "hsn"];

function defaultClientPos() {
  const code = String(selectedClient?.gstin || "").slice(0, 2);
  return STATE_CODES[code] ? code : "33";
}

function createB2BRow() {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td class="b2b-row-num"></td>
    <td><input type="text" class="b2b-cell-input" data-col="inum" placeholder="INV-001"></td>
    <td><input type="text" class="b2b-cell-input" data-col="gstin" placeholder="blank = unregistered" style="text-transform:uppercase;"></td>
    <td><input type="text" class="b2b-cell-input" data-col="cname" placeholder="Customer name"></td>
    <td><input type="text" class="b2b-cell-input" data-col="idt" placeholder="DD-MM-YYYY"></td>
    <td><input type="text" class="b2b-cell-input" data-col="txval" placeholder="0"></td>
    <td><input type="text" class="b2b-cell-input" data-col="igst" placeholder="0"></td>
    <td><input type="text" class="b2b-cell-input" data-col="cgst" placeholder="0"></td>
    <td><input type="text" class="b2b-cell-input" data-col="sgst" placeholder="0"></td>
    <td><input type="text" class="b2b-cell-input" data-col="val" placeholder="auto"></td>
    <td><select class="b2b-cell-select" data-col="pos"></select></td>
    <td><select class="b2b-cell-select" data-col="rchrg"><option value="N">No</option><option value="Y">Yes</option></select></td>
    <td><input type="text" class="b2b-cell-input" data-col="hsn" placeholder="998314"></td>
    <td class="b2b-rate-cell" data-rate>—</td>
    <td><button type="button" class="b2b-row-del" data-del title="Remove row"><i class="fa-solid fa-xmark"></i></button></td>
  `;
  const posSel = tr.querySelector('[data-col="pos"]');
  posSel.innerHTML = Object.entries(STATE_CODES).map(([code, name]) => `<option value="${code}">${code} — ${name}</option>`).join("");
  posSel.value = defaultClientPos();

  tr.querySelectorAll("input[data-col]").forEach((inp) => {
    inp.addEventListener("input", () => { autoFillB2BRow(tr, inp.dataset.col); updateRowRate(tr); });
    inp.addEventListener("paste", (e) => handleB2BGridPaste(e, tr, inp));
  });
  tr.querySelector('[data-col="gstin"]').addEventListener("input", (e) => {
    tr.classList.toggle("row-unregistered", !e.target.value.trim());
  });
  tr.querySelector('[data-col="gstin"]').addEventListener("blur", (e) => { e.target.value = e.target.value.toUpperCase(); });
  tr.querySelector('[data-col="idt"]').addEventListener("blur", (e) => { e.target.value = normalizeDate(e.target.value); });
  tr.querySelector("[data-del]").addEventListener("click", () => { tr.remove(); renumberB2BRows(); handleParseB2B(true); });
  return tr;
}

function renumberB2BRows() {
  document.querySelectorAll("#b2bGridBody tr").forEach((tr, i) => {
    tr.querySelector(".b2b-row-num").textContent = i + 1;
  });
}

function initB2BGrid(rowCount = 8) {
  const body = document.getElementById("b2bGridBody");
  if (!body) return;
  body.innerHTML = "";
  for (let i = 0; i < rowCount; i++) body.appendChild(createB2BRow());
  renumberB2BRows();
}

function addB2BRows(n = 5) {
  const body = document.getElementById("b2bGridBody");
  for (let i = 0; i < n; i++) body.appendChild(createB2BRow());
  renumberB2BRows();
}

function updateRowRate(tr) {
  const g = (col) => num(tr.querySelector(`[data-col="${col}"]`).value);
  const txval = g("txval"), igst = g("igst"), cgst = g("cgst"), sgst = g("sgst");
  const rateCell = tr.querySelector("[data-rate]");
  if (txval > 0 && !isNaN(txval) && !isNaN(igst) && !isNaN(cgst) && !isNaN(sgst)) {
    const computed = Math.round(((igst + cgst + sgst) / txval) * 400) / 4; // nearest 0.25%
    const snapped = nearestValidRate(computed);
    rateCell.textContent = snapped === null ? `${computed}%*` : `${snapped}%`;
    rateCell.title = snapped === null ? "Doesn't match a standard GST slab — check the amounts" : "";
  } else {
    rateCell.textContent = "—";
    rateCell.title = "";
  }
}

/** Manual-entry convenience: CGST and SGST are always equal under GST law, so
 *  typing one auto-fills the other; and Taxable + IGST + CGST + SGST is kept
 *  live in the Total box instead of leaving it for the user to add up. */
function autoFillB2BRow(tr, changedCol) {
  const cgstEl = tr.querySelector('[data-col="cgst"]');
  const sgstEl = tr.querySelector('[data-col="sgst"]');
  const valEl = tr.querySelector('[data-col="val"]');
  const txvalEl = tr.querySelector('[data-col="txval"]');
  const igstEl = tr.querySelector('[data-col="igst"]');

  if (changedCol === "cgst") {
    const v = cgstEl.value.trim();
    if (v !== "" && sgstEl.value.trim() !== v) sgstEl.value = v;
  } else if (changedCol === "sgst") {
    const v = sgstEl.value.trim();
    if (v !== "" && cgstEl.value.trim() !== v) cgstEl.value = v;
  }

  if (["txval", "igst", "cgst", "sgst"].includes(changedCol)) {
    const txval = num(txvalEl.value) || 0;
    const igst = num(igstEl.value) || 0;
    const cgst = num(cgstEl.value) || 0;
    const sgst = num(sgstEl.value) || 0;
    if (txval || igst || cgst || sgst) valEl.value = round2(txval + igst + cgst + sgst);
  }
}

function setB2BCell(tr, colName, rawVal) {
  const val = String(rawVal ?? "").trim();
  if (colName === "pos") {
    const code = resolvePosCode(val);
    if (STATE_CODES[code]) tr.querySelector('[data-col="pos"]').value = code;
    return;
  }
  if (colName === "rchrg") {
    tr.querySelector('[data-col="rchrg"]').value = /^y/i.test(val) ? "Y" : "N";
    return;
  }
  if (colName === "idt") {
    tr.querySelector('[data-col="idt"]').value = normalizeDate(val);
    return;
  }
  if (colName === "gstin") {
    tr.querySelector('[data-col="gstin"]').value = val.toUpperCase();
    return;
  }
  const el = tr.querySelector(`[data-col="${colName}"]`);
  if (el) el.value = val;
}

/** Excel-style paste: fills across the row from the pasted-into cell and adds new rows as needed. */
function handleB2BGridPaste(e, tr, inputEl) {
  const text = (e.clipboardData || window.clipboardData).getData("text");
  if (!text || !/\t|\r|\n/.test(text)) return; // single-cell paste — let the browser handle it normally
  e.preventDefault();

  const gridRows = splitPastedText(text);
  const body = document.getElementById("b2bGridBody");
  let rowsArr = Array.from(body.children);
  const startRowIdx = rowsArr.indexOf(tr);
  const startColIdx = B2B_COLS.indexOf(inputEl.dataset.col);
  if (startRowIdx === -1 || startColIdx === -1) return;

  gridRows.forEach((cells, rOffset) => {
    let targetRow = rowsArr[startRowIdx + rOffset];
    if (!targetRow) {
      targetRow = createB2BRow();
      body.appendChild(targetRow);
      rowsArr.push(targetRow);
    }
    cells.forEach((cellVal, cOffset) => {
      const colName = B2B_COLS[startColIdx + cOffset];
      if (!colName) return; // pasted more columns than the grid has — ignore the rest
      setB2BCell(targetRow, colName, cellVal);
    });
    updateRowRate(targetRow);
  });
  renumberB2BRows();
}

/** Reads and validates every non-empty row directly from the grid.
 *  A row with no GSTIN filled in is treated as an unregistered / walk-in
 *  customer, not an error — it's pulled out into `unregistered` so the
 *  B2C tab can consolidate it, instead of being counted as a B2B invoice. */
/** Converts a return-period monthKey like "Aug-2026" into { m, y } so an
 *  invoice date can be checked against the period it's being filed in. */
function periodMonthYear(monthKey) {
  const [name, year] = String(monthKey || "").split("-");
  return { m: FY_MONTH_TO_NUM[name] ? parseInt(FY_MONTH_TO_NUM[name], 10) : 0, y: parseInt(year, 10) || 0 };
}

function parseB2BFromGrid() {
  const rows = Array.from(document.querySelectorAll("#b2bGridBody tr"));
  const out = [];
  const unregistered = [];
  const errors = [];
  const dateWarnings = [];
  const sellerStateCode = String(selectedClient?.gstin || "").slice(0, 2);
  const period = periodMonthYear(selectedPeriod?.monthKey);
  let anyData = false;

  rows.forEach((tr, i) => {
    const g = (col) => tr.querySelector(`[data-col="${col}"]`).value.trim();
    const inum = g("inum");
    const gstin = g("gstin").toUpperCase();
    const cname = g("cname");
    const idt = normalizeDate(g("idt"));
    const txvalNum = num(g("txval"));
    const igstNum = num(g("igst")) || 0;
    const cgstNum = num(g("cgst")) || 0;
    const sgstNum = num(g("sgst")) || 0;
    let valNum = num(g("val"));
    const pos = resolvePosCode(tr.querySelector('[data-col="pos"]').value);
    const rchrg = tr.querySelector('[data-col="rchrg"]').value === "Y" ? "Y" : "N";
    const hsn = g("hsn").replace(/[,\s]/g, "");

    tr.classList.remove("row-error", "row-unregistered", "row-date-warn");
    const rowIsBlank = !inum && !gstin && !txvalNum && !igstNum && !cgstNum && !sgstNum;
    if (rowIsBlank) return; // skip fully empty rows silently
    anyData = true;

    // No GSTIN filled in at all → unregistered customer, route to B2C instead of erroring.
    if (!gstin) {
      tr.classList.add("row-unregistered");
      if (!/^\d{2}$/.test(pos) || !STATE_CODES[pos]) {
        tr.classList.add("row-error");
        errors.push(`Row ${i + 1}: Invalid Place of Supply`);
      } else if (txvalNum > 0) {
        const computed = Math.round(((igstNum + cgstNum + sgstNum) / txvalNum) * 400) / 4;
        const snapped = nearestValidRate(computed) ?? 0;
        unregistered.push({ pos, rt: snapped, txval: txvalNum, igst: igstNum, cgst: cgstNum, sgst: sgstNum });
      }
      return;
    }

    const rowErrors = [];
    if (!inum) rowErrors.push("Invoice No missing");
    if (!GSTIN_RE.test(gstin)) rowErrors.push("Invalid recipient GSTIN");
    if (!DATE_RE.test(idt)) rowErrors.push("Invoice Date not recognized — check the day/month/year");
    if (isNaN(txvalNum) || txvalNum < 0) rowErrors.push("Taxable Amount invalid");
    if ([igstNum, cgstNum, sgstNum].some((n) => isNaN(n) || n < 0)) rowErrors.push("Tax amounts can't be negative");
    if (igstNum > 0 && (cgstNum > 0 || sgstNum > 0)) rowErrors.push("A row can't have both IGST and CGST/SGST");
    if (!/^\d{2}$/.test(pos) || !STATE_CODES[pos]) rowErrors.push("Invalid Place of Supply");
    if (!/^\d{4,8}$/.test(hsn) || ![4, 6, 8].includes(hsn.length)) rowErrors.push("HSN/SAC must be numeric, 4/6/8 digits");

    // GSTIN-based state check: recipient's GSTIN state code (first 2 digits) tells us
    // whether this is an interstate or intrastate sale, so CGST/SGST vs IGST can be
    // flagged as wrong even if the amounts otherwise look fine.
    const recipientStateCode = gstin.slice(0, 2);
    if (/^\d{2}$/.test(recipientStateCode) && sellerStateCode) {
      if (recipientStateCode !== sellerStateCode && (cgstNum > 0 || sgstNum > 0)) {
        rowErrors.push(`Recipient GSTIN is from ${STATE_CODES[recipientStateCode] || "another state"} (interstate) — use IGST, not CGST/SGST`);
      } else if (recipientStateCode === sellerStateCode && igstNum > 0) {
        rowErrors.push("Recipient GSTIN is from the same state (intrastate) — use CGST/SGST, not IGST");
      }
    }

    // Invoice date outside the return period being filed — not a hard error (backdated /
    // late-booked invoices do happen), but highlighted so it needs explicit confirmation to save.
    if (DATE_RE.test(idt) && period.y) {
      const dparts = idt.split("-");
      const invMonth = parseInt(dparts[1], 10);
      const invYear = parseInt(dparts[2], 10);
      if (invMonth !== period.m || invYear !== period.y) {
        tr.classList.add("row-date-warn");
        dateWarnings.push(`Row ${i + 1}: Invoice date ${idt} is not in the return period ${selectedPeriod.label}`);
      }
    }

    if (!valNum) valNum = round2(txvalNum + igstNum + cgstNum + sgstNum);

    let rateNum = 0;
    if (!rowErrors.length && txvalNum > 0) {
      const computed = Math.round(((igstNum + cgstNum + sgstNum) / txvalNum) * 400) / 4; // nearest 0.25%
      const snapped = nearestValidRate(computed);
      if (snapped === null) rowErrors.push(`Tax works out to ${computed}% of taxable value — not a valid GST slab, check the figures`);
      else rateNum = snapped;
    }

    if (rowErrors.length) {
      tr.classList.add("row-error");
      errors.push(`Row ${i + 1}: ${rowErrors.join("; ")}`);
    }

    out.push({
      raw: { gstin, inum, cname, idt, val: valNum, pos, rchrg, hsn, txval: txvalNum, rt: rateNum, igst: igstNum, cgst: cgstNum, sgst: sgstNum },
      errors: rowErrors,
    });
  });

  return { rows: out, unregistered, errors, dateWarnings, anyData };
}

let lastUnregisteredB2B = [];
let lastB2BDateWarnings = [];

function handleParseB2B(silent = false) {
  const parsed = parseB2BFromGrid();
  const errEl = document.getElementById("errB2B");
  lastUnregisteredB2B = parsed.unregistered;
  lastB2BDateWarnings = parsed.dateWarnings || [];
  if (!parsed.anyData) {
    if (!silent) toast("Fill in at least one invoice row first.", "warning");
    parsedRows.b2b = [];
    sectionHasErrors.b2b = false;
    errEl.classList.remove("show");
    errEl.innerHTML = "";
    updateCounts();
    updateSummaryStrip();
    return;
  }
  parsedRows.b2b = parsed.rows;
  sectionHasErrors.b2b = parsed.errors.length > 0;
  if (parsed.errors.length) {
    errEl.classList.add("show");
    errEl.innerHTML = `<strong>${parsed.errors.length} issue(s) found — the rows highlighted in red need fixing:</strong><ul>${parsed.errors
      .slice(0, 12)
      .map((e) => `<li>${escapeHtml(e)}</li>`)
      .join("")}${parsed.errors.length > 12 ? `<li>…and ${parsed.errors.length - 12} more</li>` : ""}</ul>`;
  } else if (lastB2BDateWarnings.length) {
    errEl.classList.add("show");
    errEl.innerHTML = `<strong style="color: var(--gold-600, #96660a);">${lastB2BDateWarnings.length} invoice(s) dated outside this return period (highlighted in yellow) — you'll be asked to confirm before saving:</strong><ul>${lastB2BDateWarnings
      .slice(0, 12)
      .map((w) => `<li>${escapeHtml(w)}</li>`)
      .join("")}${lastB2BDateWarnings.length > 12 ? `<li>…and ${lastB2BDateWarnings.length - 12} more</li>` : ""}</ul>`;
  } else {
    errEl.classList.remove("show");
    errEl.innerHTML = "";
  }
  updateCounts();
  updateSummaryStrip();
  if (!silent) {
    const unregNote = parsed.unregistered.length ? ` · ${parsed.unregistered.length} unregistered row(s) → use "Sync from B2B" on the B2C tab` : "";
    const dateNote = lastB2BDateWarnings.length ? ` · ${lastB2BDateWarnings.length} invoice date(s) outside this return period` : "";
    toast(`${parsed.rows.length} invoice row(s) validated${parsed.errors.length ? ` — ${parsed.errors.length} issue(s)` : ""}.${unregNote}${dateNote}`, parsed.errors.length ? "warning" : "success");
  }
}

/* =========================================================
   Generic editable grid engine — used for B2C Small, HSN
   Summary and Documents Issued (same "paste fills across the
   row, adds rows automatically" behaviour as the B2B grid).
   ========================================================= */
function optionsHtml(list) {
  return list.map(([v, l]) => `<option value="${escapeHtml(v)}">${escapeHtml(l)}</option>`).join("");
}

function matchDocNature(text) {
  const t = String(text || "").trim().toLowerCase();
  for (const entry of DOC_NATURE_MAP) {
    if (entry.names.some((n) => t.includes(n) || n.includes(t))) return entry.key;
  }
  return null;
}

const GRID_DEFS = {
  b2cs: {
    bodyId: "b2csGridBody",
    cols: [
      { key: "pos", label: "Place of Supply", type: "select", options: () => Object.entries(STATE_CODES).map(([c, n]) => [c, `${c} — ${n}`]) },
      { key: "rt", label: "Rate %", type: "select", options: () => VALID_RATES.map((r) => [String(r), `${r}%`]) },
      { key: "txval", label: "Taxable Value", type: "text", placeholder: "0" },
      { key: "igst", label: "IGST", type: "text", placeholder: "0" },
      { key: "cgst", label: "CGST", type: "text", placeholder: "0" },
      { key: "sgst", label: "SGST", type: "text", placeholder: "0" },
    ],
    isRowBlank: (v) => !num(v.txval) && !num(v.igst) && !num(v.cgst) && !num(v.sgst),
    validateRow: (v) => {
      const errors = [];
      const posCode = resolvePosCode(v.pos);
      if (!/^\d{2}$/.test(posCode) || !STATE_CODES[posCode]) errors.push("Invalid Place of Supply");
      const rateNum = num(v.rt);
      if (isNaN(rateNum) || !VALID_RATES.includes(rateNum)) errors.push(`Rate ${v.rt} is not a valid GST slab`);
      const txvalNum = num(v.txval);
      if (isNaN(txvalNum) || txvalNum < 0) errors.push("Taxable Value invalid");
      const igstNum = num(v.igst), cgstNum = num(v.cgst), sgstNum = num(v.sgst);
      if ([igstNum, cgstNum, sgstNum].some((n) => isNaN(n) || n < 0)) errors.push("Tax amounts invalid");
      if (igstNum > 0 && (cgstNum > 0 || sgstNum > 0)) errors.push("A row can't have both IGST and CGST/SGST");
      return { errors, raw: { pos: posCode, rt: rateNum, txval: txvalNum, igst: igstNum, cgst: cgstNum, sgst: sgstNum, sply_ty: igstNum > 0 ? "INTER" : "INTRA" } };
    },
  },
  hsn: {
    bodyId: "hsnGridBody",
    cols: [
      { key: "hsn", label: "HSN/SAC Code", type: "text", placeholder: "998314" },
      { key: "desc", label: "Description", type: "text", placeholder: "e.g. Accounting services" },
      { key: "uqc", label: "UQC", type: "text", placeholder: "NA / NOS / KGS" },
      { key: "qty", label: "Total Quantity", type: "text", placeholder: "0" },
      { key: "val", label: "Total Value", type: "text", placeholder: "auto" },
      { key: "txval", label: "Taxable Value", type: "text", placeholder: "0" },
      { key: "igst", label: "IGST", type: "text", placeholder: "0" },
      { key: "cgst", label: "CGST", type: "text", placeholder: "0" },
      { key: "sgst", label: "SGST", type: "text", placeholder: "0" },
    ],
    isRowBlank: (v) => !v.hsn && !num(v.txval) && !num(v.igst) && !num(v.cgst) && !num(v.sgst),
    validateRow: (v) => {
      const errors = [];
      const h = String(v.hsn || "").replace(/[,\s]/g, "");
      if (!/^\d{4,8}$/.test(h) || ![4, 6, 8].includes(h.length)) errors.push("HSN/SAC code must be numeric, 4/6/8 digits");
      let u = String(v.uqc || "").trim().toUpperCase();
      if (h.startsWith("99") && (!u || u === "OTH-OTHERS")) u = "NA-NOT APPLICABLE";
      if (u && !u.includes("-")) {
        const match = [...VALID_UQC].find((code) => code.startsWith(u + "-"));
        if (match) u = match;
      }
      if (!VALID_UQC.has(u)) errors.push(`UQC "${v.uqc}" is not a valid unit code`);
      const qtyNum = num(v.qty);
      if (isNaN(qtyNum) || qtyNum < 0) errors.push("Quantity invalid");
      const valNum = num(v.val);
      const txvalNum = num(v.txval);
      if (isNaN(txvalNum) || txvalNum < 0) errors.push("Taxable Value invalid");
      const igstNum = num(v.igst), cgstNum = num(v.cgst), sgstNum = num(v.sgst);
      if ([igstNum, cgstNum, sgstNum].some((n) => isNaN(n) || n < 0)) errors.push("Tax amounts invalid");
      return { errors, raw: { hsn_sc: h, desc: v.desc || "", uqc: u, qty: qtyNum, val: valNum || round2(txvalNum + igstNum + cgstNum + sgstNum), txval: txvalNum, igst: igstNum, cgst: cgstNum, sgst: sgstNum } };
    },
  },
  doc: {
    bodyId: "docGridBody",
    cols: [
      { key: "nature", label: "Nature of Document", type: "select", options: () => DOC_NATURE_MAP.map((d) => [d.names[0], d.names[0].replace(/\b\w/g, (c) => c.toUpperCase())]) },
      { key: "from", label: "Serial From", type: "text", placeholder: "INV/001" },
      { key: "to", label: "Serial To", type: "text", placeholder: "INV/050" },
      { key: "total", label: "Total Number", type: "text", placeholder: "0" },
      { key: "cancel", label: "Cancelled", type: "text", placeholder: "0" },
    ],
    isRowBlank: (v) => !v.from && !v.to && !num(v.total),
    validateRow: (v) => {
      const errors = [];
      const docNum = matchDocNature(v.nature);
      if (!docNum) errors.push(`Nature "${v.nature}" not recognised`);
      if (!v.from || !v.to) errors.push("Serial From/To missing");
      const totalNum = num(v.total);
      const cancelNum = num(v.cancel) || 0;
      if (isNaN(totalNum) || totalNum <= 0) errors.push("Total Number invalid");
      if (cancelNum > totalNum) errors.push("Cancelled count can't exceed Total Number");
      return { errors, raw: { doc_num: docNum || 1, nature: v.nature || "", from: String(v.from || ""), to: String(v.to || ""), totnum: totalNum, cancel: cancelNum, net_issue: totalNum - cancelNum } };
    },
  },
};

function createGridRow(defKey) {
  const def = GRID_DEFS[defKey];
  const tr = document.createElement("tr");
  const cellsHtml = def.cols
    .map((col) =>
      col.type === "select"
        ? `<td><select class="b2b-cell-select" data-col="${col.key}">${optionsHtml(col.options())}</select></td>`
        : `<td><input type="text" class="b2b-cell-input" data-col="${col.key}" placeholder="${escapeHtml(col.placeholder || "")}"></td>`
    )
    .join("");
  tr.innerHTML = `<td class="b2b-row-num"></td>${cellsHtml}<td><button type="button" class="b2b-row-del" data-del title="Remove row"><i class="fa-solid fa-xmark"></i></button></td>`;
  tr.querySelectorAll("input[data-col]").forEach((inp) => inp.addEventListener("paste", (e) => handleGenericGridPaste(e, defKey, tr, inp)));
  tr.querySelector("[data-del]").addEventListener("click", () => { tr.remove(); renumberGridRows(defKey); handleParseGrid(defKey, true); });
  return tr;
}

function renumberGridRows(defKey) {
  document.querySelectorAll(`#${GRID_DEFS[defKey].bodyId} tr`).forEach((tr, i) => {
    tr.querySelector(".b2b-row-num").textContent = i + 1;
  });
}

function initGrid(defKey, rowCount) {
  const body = document.getElementById(GRID_DEFS[defKey].bodyId);
  if (!body) return;
  body.innerHTML = "";
  for (let i = 0; i < rowCount; i++) body.appendChild(createGridRow(defKey));
  renumberGridRows(defKey);
}

function addGridRows(defKey, n = 5) {
  const body = document.getElementById(GRID_DEFS[defKey].bodyId);
  for (let i = 0; i < n; i++) body.appendChild(createGridRow(defKey));
  renumberGridRows(defKey);
}

function setGridCell(defKey, tr, colKey, rawVal) {
  const col = GRID_DEFS[defKey].cols.find((c) => c.key === colKey);
  const val = String(rawVal ?? "").trim();
  if (!col) return;
  if (col.type === "select") {
    const sel = tr.querySelector(`[data-col="${colKey}"]`);
    const opts = col.options();
    let match = opts.find(([v]) => v.toLowerCase() === val.toLowerCase());
    if (!match) match = opts.find(([, l]) => l.toLowerCase() === val.toLowerCase());
    if (!match && colKey === "pos") {
      const code = resolvePosCode(val);
      match = opts.find(([v]) => v === code);
    }
    if (!match) match = opts.find(([, l]) => l.toLowerCase().includes(val.toLowerCase()));
    if (match) sel.value = match[0];
    return;
  }
  const el = tr.querySelector(`[data-col="${colKey}"]`);
  if (el) el.value = colKey === "hsn" ? val.replace(/[,\s]/g, "") : val;
}

function handleGenericGridPaste(e, defKey, tr, inputEl) {
  const text = (e.clipboardData || window.clipboardData).getData("text");
  if (!text || !/\t|\r|\n/.test(text)) return; // single-cell paste — let the browser handle it normally
  e.preventDefault();

  const colKeys = GRID_DEFS[defKey].cols.map((c) => c.key);
  const gridRows = splitPastedText(text);
  const body = document.getElementById(GRID_DEFS[defKey].bodyId);
  let rowsArr = Array.from(body.children);
  const startRowIdx = rowsArr.indexOf(tr);
  const startColIdx = colKeys.indexOf(inputEl.dataset.col);
  if (startRowIdx === -1 || startColIdx === -1) return;

  gridRows.forEach((cells, rOffset) => {
    let targetRow = rowsArr[startRowIdx + rOffset];
    if (!targetRow) {
      targetRow = createGridRow(defKey);
      body.appendChild(targetRow);
      rowsArr.push(targetRow);
    }
    cells.forEach((cellVal, cOffset) => {
      const colKey = colKeys[startColIdx + cOffset];
      if (!colKey) return; // pasted more columns than the grid has — ignore the rest
      setGridCell(defKey, targetRow, colKey, cellVal);
    });
  });
  renumberGridRows(defKey);
}

function parseGridSection(defKey) {
  const def = GRID_DEFS[defKey];
  const rows = Array.from(document.querySelectorAll(`#${def.bodyId} tr`));
  const out = [];
  const errors = [];
  let anyData = false;

  rows.forEach((tr, i) => {
    const v = {};
    def.cols.forEach((col) => { v[col.key] = tr.querySelector(`[data-col="${col.key}"]`).value.trim(); });
    tr.classList.remove("row-error");
    if (def.isRowBlank(v)) return;
    anyData = true;
    const { errors: rowErrors, raw } = def.validateRow(v);
    if (rowErrors.length) {
      tr.classList.add("row-error");
      errors.push(`Row ${i + 1}: ${rowErrors.join("; ")}`);
    }
    out.push({ raw, errors: rowErrors });
  });

  return { rows: out, errors, anyData };
}

function handleParseGrid(defKey, silent = false) {
  const parsed = parseGridSection(defKey);
  const errEl = document.getElementById(`err${defKey.toUpperCase()}`);
  if (!parsed.anyData) {
    if (!silent) toast("Fill in at least one row first.", "warning");
    parsedRows[defKey] = [];
    sectionHasErrors[defKey] = false;
    errEl.classList.remove("show");
    errEl.innerHTML = "";
    updateCounts();
    updateSummaryStrip();
    return;
  }
  parsedRows[defKey] = parsed.rows;
  sectionHasErrors[defKey] = parsed.errors.length > 0;
  if (parsed.errors.length) {
    errEl.classList.add("show");
    errEl.innerHTML = `<strong>${parsed.errors.length} issue(s) found — the rows highlighted in red need fixing:</strong><ul>${parsed.errors
      .slice(0, 12)
      .map((e) => `<li>${escapeHtml(e)}</li>`)
      .join("")}${parsed.errors.length > 12 ? `<li>…and ${parsed.errors.length - 12} more</li>` : ""}</ul>`;
  } else {
    errEl.classList.remove("show");
    errEl.innerHTML = "";
  }
  updateCounts();
  updateSummaryStrip();
  if (!silent) {
    toast(`${parsed.rows.length} row(s) validated${parsed.errors.length ? ` — ${parsed.errors.length} issue(s)` : ""}.`, parsed.errors.length ? "warning" : "success");
  }
}

/** B2C Small tab: consolidate the month's B2B rows left with no GSTIN (unregistered / walk-in customers) by Place of Supply + Rate, and drop them in as editable rows. */
function syncB2csFromUnregisteredB2B() {
  if (!lastUnregisteredB2B.length) {
    toast('No unregistered B2B rows yet — leave GSTIN blank for those invoices on the B2B tab and click "Validate rows" there first.', "warning");
    return;
  }
  const grouped = new Map(); // key = pos|rt
  lastUnregisteredB2B.forEach((r) => {
    const key = `${r.pos}|${r.rt}`;
    if (!grouped.has(key)) grouped.set(key, { pos: r.pos, rt: r.rt, txval: 0, igst: 0, cgst: 0, sgst: 0 });
    const g = grouped.get(key);
    g.txval = round2(g.txval + r.txval);
    g.igst = round2(g.igst + r.igst);
    g.cgst = round2(g.cgst + r.cgst);
    g.sgst = round2(g.sgst + r.sgst);
  });

  const body = document.getElementById("b2csGridBody");
  body.querySelectorAll('tr[data-auto="1"]').forEach((tr) => tr.remove());
  grouped.forEach((g) => {
    const tr = createGridRow("b2cs");
    tr.dataset.auto = "1";
    tr.querySelector('[data-col="pos"]').value = g.pos;
    tr.querySelector('[data-col="rt"]').value = String(g.rt);
    tr.querySelector('[data-col="txval"]').value = g.txval || "";
    tr.querySelector('[data-col="igst"]').value = g.igst || "";
    tr.querySelector('[data-col="cgst"]').value = g.cgst || "";
    tr.querySelector('[data-col="sgst"]').value = g.sgst || "";
    body.appendChild(tr);
  });
  renumberGridRows("b2cs");
  toast(`Pulled in ${grouped.size} consolidated row(s) from ${lastUnregisteredB2B.length} unregistered B2B invoice(s) this month.`, "success");
}

/* =========================================================
   Excel workbook import — one .xlsx with separate sheets for
   B2B / B2C / HSN / Document. Columns are matched by their
   HEADER TEXT (not position), so the sheet's own column order
   doesn't need to match the grid's — "Invoice Date" lands in
   the date field no matter which column it's actually in.
   ========================================================= */
function matchSheetToSection(sheetName) {
  const n = String(sheetName || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (n.includes("b2b")) return "b2b";
  if (n.includes("b2c")) return "b2cs";
  if (n.includes("hsn")) return "hsn";
  if (n.includes("doc")) return "doc";
  return null;
}

const HEADER_ALIASES = {
  b2b: {
    inum: ["invoice number", "invoice no", "inv no", "bill no", "bill number", "invoice num"],
    gstin: ["gstin", "customer gstin", "recipient gstin", "party gstin", "buyer gstin"],
    cname: ["customer name", "party name", "buyer name", "customer", "client name", "name"],
    idt: ["invoice date", "bill date", "inv date", "date"],
    txval: ["taxable amount", "taxable value", "taxable", "assessable value"],
    igst: ["igst", "igst amount"],
    cgst: ["cgst", "cgst amount"],
    sgst: ["sgst", "sgst amount"],
    val: ["total", "invoice value", "total value", "total amount", "grand total"],
    pos: ["place of supply", "pos"],
    rchrg: ["reverse charge", "rcm"],
    hsn: ["hsn/sac code", "hsn sac code", "hsn code", "hsn/sac", "hsn", "sac code", "sac"],
    rt: ["rate", "rate %", "gst rate", "tax rate"],
  },
  b2cs: {
    pos: ["place of supply", "pos"],
    rt: ["rate %", "rate", "gst rate", "tax rate"],
    txval: ["taxable amount", "taxable value", "taxable"],
    igst: ["igst", "igst amount"],
    cgst: ["cgst", "cgst amount"],
    sgst: ["sgst", "sgst amount"],
    sply_ty: ["type", "supply type"],
  },
  hsn: {
    hsn: ["hsn/sac code", "hsn sac code", "hsn code", "hsn/sac", "hsn", "sac code", "sac"],
    desc: ["description", "desc", "item description"],
    uqc: ["uqc", "unit"],
    qty: ["quantity", "qty", "total quantity"],
    val: ["total value", "total"],
    txval: ["taxable value", "taxable amount", "taxable"],
    igst: ["igst", "igst amount", "integrated tax amount"],
    cgst: ["cgst", "cgst amount", "central tax amount"],
    sgst: ["sgst", "sgst amount", "state/ut tax amount", "state ut tax amount"],
  },
  doc: {
    nature: ["nature of document", "nature", "document type", "doc type"],
    from: ["serial from", "sr. no. from", "sr no from", "from", "sr from", "from no"],
    to: ["serial to", "sr. no. to", "sr no to", "to", "sr to", "to no"],
    total: ["total number", "total no", "total"],
    cancel: ["cancelled", "canceled", "cancel", "cancelled no"],
  },
};

function normHeader(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Maps each header-row cell to one of our internal column keys by matching header TEXT (exact, then partial). Returns { colIndex: key }. */
function buildHeaderMap(section, headerRow) {
  const aliases = HEADER_ALIASES[section];
  const map = {};
  headerRow.forEach((cell, idx) => {
    const nh = normHeader(cell);
    if (!nh) return;
    for (const [key, list] of Object.entries(aliases)) {
      if (list.some((a) => normHeader(a) === nh)) { map[idx] = key; return; }
    }
  });
  // Second pass: partial match for anything still unmapped, so close variants ("HSN Code (Goods)") still land.
  headerRow.forEach((cell, idx) => {
    if (map[idx]) return;
    const nh = normHeader(cell);
    if (!nh) return;
    for (const [key, list] of Object.entries(aliases)) {
      if (list.some((a) => { const na = normHeader(a); return na.length >= 4 && (nh.includes(na) || na.includes(nh)); })) {
        map[idx] = key;
        return;
      }
    }
  });
  return map;
}

/** Clears any blank starter rows, then appends one grid row per imported row (each row given as a {colKey: value} object). Returns rows filled. */
/** A B2B row counts as empty only by its data fields — Place of Supply / Reverse Charge dropdowns always carry a default value, so they don't count. */
function isB2BRowBlank(tr) {
  const g = (col) => tr.querySelector(`[data-col="${col}"]`).value.trim();
  return !g("inum") && !g("gstin") && !num(g("txval")) && !num(g("igst")) && !num(g("cgst")) && !num(g("sgst"));
}

/** Same idea for the generic grid sections — uses each section's own isRowBlank so dropdown defaults (Rate %, Nature of Document, ...) don't count as "filled in". */
function isGridRowBlank(defKey, tr) {
  const def = GRID_DEFS[defKey];
  const v = {};
  def.cols.forEach((col) => { v[col.key] = tr.querySelector(`[data-col="${col.key}"]`).value.trim(); });
  return def.isRowBlank(v);
}

/** Same idea as deriveB2BTaxSplit, but for B2CS rows — the official format
 *  gives Rate + Taxable Value only; split into IGST vs CGST+SGST using
 *  each row's own "Type" (Inter/Intra) when given, else Place of Supply
 *  vs the seller's state. */
function deriveB2CSTaxSplit(vals, sellerStateCode) {
  const rate = num(vals.rt);
  const txval = num(vals.txval);
  const hasExplicitTax = ["igst", "cgst", "sgst"].some((k) => num(vals[k]) > 0);
  if (!rate || !txval || hasExplicitTax) return vals;
  const typeRaw = String(vals.sply_ty || "").trim().toUpperCase();
  const posCode = resolvePosCode(vals.pos);
  const isInter = typeRaw.startsWith("INTER") || typeRaw === "E" ? true : typeRaw.startsWith("INTRA") || typeRaw === "OE" ? false : sellerStateCode ? posCode !== sellerStateCode : null;
  const taxAmt = round2((txval * rate) / 100);
  if (isInter === false) {
    vals.cgst = round2(taxAmt / 2);
    vals.sgst = round2(taxAmt / 2);
    vals.igst = 0;
  } else {
    vals.igst = taxAmt;
    vals.cgst = 0;
    vals.sgst = 0;
  }
  return vals;
}

function populateGridFromKeyedRows(section, keyedRows) {
  if (!keyedRows.length) return 0;
  if (section === "b2b") {
    const sellerStateCode = (selectedClient?.gstin || "").slice(0, 2);
    const body = document.getElementById("b2bGridBody");
    Array.from(body.querySelectorAll("tr")).forEach((tr) => {
      if (isB2BRowBlank(tr)) tr.remove();
    });
    keyedRows.forEach((vals) => {
      deriveB2BTaxSplit(vals, sellerStateCode);
      const tr = createB2BRow();
      body.appendChild(tr);
      B2B_COLS.forEach((key) => { if (vals[key] !== undefined && vals[key] !== "") setB2BCell(tr, key, vals[key]); });
      updateRowRate(tr);
      tr.classList.toggle("row-unregistered", !tr.querySelector('[data-col="gstin"]').value.trim());
    });
    if (!body.children.length) body.appendChild(createB2BRow());
    renumberB2BRows();
    return keyedRows.length;
  }

  const def = GRID_DEFS[section];
  const colKeys = def.cols.map((c) => c.key);
  const body = document.getElementById(def.bodyId);
  Array.from(body.querySelectorAll("tr")).forEach((tr) => {
    if (isGridRowBlank(section, tr)) tr.remove();
  });
  keyedRows.forEach((vals) => {
    if (section === "b2cs") deriveB2CSTaxSplit(vals, (selectedClient?.gstin || "").slice(0, 2));
    const tr = createGridRow(section);
    body.appendChild(tr);
    colKeys.forEach((key) => { if (vals[key] !== undefined && vals[key] !== "") setGridCell(section, tr, key, vals[key]); });
  });
  if (!body.children.length) body.appendChild(createGridRow(section));
  renumberGridRows(section);
  return keyedRows.length;
}

/** Turns a sheet's raw rows into {colKey: value} rows — by header text when the sheet has a recognisable header row, or by left-to-right position otherwise. */
function keyRowsForSection(section, rawRows) {
  if (!rawRows.length) return [];
  const headerMap = buildHeaderMap(section, rawRows[0]);
  if (Object.keys(headerMap).length >= 2) {
    return rawRows.slice(1).map((r) => {
      const o = {};
      Object.entries(headerMap).forEach(([idx, key]) => { o[key] = r[Number(idx)] ?? ""; });
      return o;
    });
  }
  // No usable header found via column matching — but the row might still be a
  // header using wording we don't map 1:1 (e.g. "Sr No", "S.No."). Detect that
  // generically across the whole row before falling back to column order, so a
  // header row is never mistaken for the first data row.
  const colKeys = section === "b2b" ? B2B_COLS : GRID_DEFS[section].cols.map((c) => c.key);
  const dataRows = looksLikeHeaderRow(section, rawRows[0]) ? rawRows.slice(1) : stripHeaderRow(rawRows, false);
  return dataRows.map((r) => {
    const o = {};
    colKeys.forEach((k, i) => { o[k] = r[i] ?? ""; });
    return o;
  });
}

/* =========================================================
   Downloadable sample/template workbook — header row filled in
   (and matched exactly to our own alias vocabulary so it's
   recognized instantly on re-upload), every row under it left
   blank for the user to type or paste their own data into.
   ========================================================= */
const B2B_SAMPLE_LABELS = ["Invoice Number", "GSTIN", "Customer Name", "Invoice Date", "Taxable Amount", "IGST", "CGST", "SGST", "Total", "Place of Supply", "Reverse Charge", "HSN/SAC Code"];

function buildSampleSheet(headers, blankRowCount = 25) {
  const aoa = [headers];
  for (let i = 0; i < blankRowCount; i++) aoa.push(headers.map(() => ""));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  // Best-effort header emphasis (bold white-on-navy) — harmlessly ignored if the
  // loaded xlsx build doesn't support cell styles on write, values still land fine.
  headers.forEach((_, c) => {
    const addr = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[addr]) ws[addr].s = { font: { bold: true, color: { rgb: "FFFFFF" } }, fill: { fgColor: { rgb: "1A3049" } } };
  });
  ws["!cols"] = headers.map(() => ({ wch: 20 }));
  ws["!rows"] = [{ hpx: 22 }];
  return ws;
}

function downloadSampleExcel() {
  if (typeof XLSX === "undefined") {
    toast("The Excel reader didn't load — check your internet connection and try again.", "danger");
    return;
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildSampleSheet(B2B_SAMPLE_LABELS), "B2B");
  XLSX.utils.book_append_sheet(wb, buildSampleSheet(GRID_DEFS.b2cs.cols.map((c) => c.label)), "B2C");
  XLSX.utils.book_append_sheet(wb, buildSampleSheet(GRID_DEFS.hsn.cols.map((c) => c.label)), "HSN");
  XLSX.utils.book_append_sheet(wb, buildSampleSheet(GRID_DEFS.doc.cols.map((c) => c.label)), "Document");
  XLSX.writeFile(wb, "GSTR1_Sample_Template.xlsx");
  toast("Sample downloaded — row 1 on each tab is the header, start typing your data from row 2 and upload it back here.", "success");
}

async function handleExcelUpload(e) {
  const file = e.target.files[0];
  e.target.value = ""; // allow re-uploading the same file after fixing it
  if (!file) return;
  if (typeof XLSX === "undefined") {
    toast("The Excel reader didn't load — check your internet connection and try again.", "danger");
    return;
  }

  try {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });

    const filled = { b2b: 0, b2cs: 0, hsn: 0, doc: 0 };
    const unmatched = [];

    wb.SheetNames.forEach((sheetName) => {
      const section = matchSheetToSection(sheetName);
      if (!section) { unmatched.push(sheetName); return; }
      let rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, dateNF: "dd-mm-yyyy", defval: "" });
      rows = rows.map((r) => r.map((c) => String(c ?? "").trim())).filter((r) => r.some((c) => c !== ""));
      if (!rows.length) return;
      let keyedRows = keyRowsForSection(section, rows);
      keyedRows = keyedRows.filter((o) => Object.values(o).some((v) => String(v).trim() !== ""));
      if (!keyedRows.length) return;
      filled[section] += populateGridFromKeyedRows(section, keyedRows);
    });

    const importedParts = Object.entries(filled).filter(([, n]) => n > 0);
    if (!importedParts.length) {
      toast(`Couldn't find a B2B / B2C / HSN / Document sheet in that file. Sheet(s) in the file: ${wb.SheetNames.join(", ") || "none"}.`, "warning");
      return;
    }

    // Auto-validate every section that received rows so counts/errors show immediately.
    importedParts.forEach(([section]) => (section === "b2b" ? handleParseB2B() : handleParseGrid(section)));

    let msg = `Imported ${importedParts.map(([s, n]) => `${n} row(s) into ${s === "b2cs" ? "B2C Small" : s.toUpperCase()}`).join(", ")}.`;
    if (unmatched.length) msg += ` Skipped sheet(s) that didn't look like B2B/B2C/HSN/Document: ${unmatched.join(", ")}.`;
    toast(msg, "success");
    switchSection(importedParts[0][0]);
  } catch (err) {
    console.error("Excel import failed:", err);
    toast(`Couldn't read that file — make sure it's a valid .xlsx/.xls workbook. (${err.message || err})`, "danger");
  }
}

/* =========================================================
   Import from a Google Sheet published as CSV
   ========================================================= */
function toGvizCsvExportUrl(url) {
  // Accept either a "Publish to web" CSV link, or a regular
  // .../edit#gid=... link — normalize the latter into a fetchable CSV
  // export URL for that specific tab (gid).
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m && !/\/pub\?/.test(url) && !/output=csv/.test(url)) {
    const gidMatch = url.match(/[?#&]gid=(\d+)/);
    const gid = gidMatch ? gidMatch[1] : "0";
    return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
  }
  return url;
}

async function handleSheetImportFetch() {
  const urlInput = document.getElementById("sheetImportUrl");
  const url = urlInput.value.trim();
  if (!url) {
    toast("Paste the Google Sheet's published link first.", "warning");
    return;
  }
  if (typeof XLSX === "undefined") {
    toast("The sheet reader didn't load — check your internet connection and try again.", "danger");
    return;
  }
  const btn = document.getElementById("sheetImportFetchBtn");
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
  try {
    const fetchUrl = toGvizCsvExportUrl(url);
    const res = await fetch(fetchUrl);
    if (!res.ok) throw new Error(`Google Sheets returned HTTP ${res.status} — make sure the sheet is published/shared as "Anyone with the link can view".`);
    const csvText = await res.text();
    if (/^<!DOCTYPE html/i.test(csvText.trim())) {
      throw new Error('Got a login/sharing page instead of CSV — publish this sheet (File → Share → Publish to web → CSV) or set sharing to "Anyone with the link".');
    }

    const wb = XLSX.read(csvText, { type: "string" });
    const sheetName = wb.SheetNames[0];
    let rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false, defval: "" });
    rows = rows.map((r) => r.map((c) => String(c ?? "").trim())).filter((r) => r.some((c) => c !== ""));
    if (!rows.length) throw new Error("That sheet looks empty.");

    let keyedRows = keyRowsForSection(activeSection, rows);
    keyedRows = keyedRows.filter((o) => Object.values(o).some((v) => String(v).trim() !== ""));
    if (!keyedRows.length) {
      throw new Error("Couldn't match any columns in that sheet to this tab's fields — check the column headers.");
    }

    const filled = populateGridFromKeyedRows(activeSection, keyedRows);
    activeSection === "b2b" ? handleParseB2B() : handleParseGrid(activeSection);
    toast(`Imported ${filled} row(s) from Google Sheets into ${activeSection === "b2cs" ? "B2C Small" : activeSection.toUpperCase()}.`, "success");
    document.getElementById("sheetImportPanel").style.display = "none";
    urlInput.value = "";
  } catch (err) {
    console.error("Google Sheet import failed:", err);
    toast(err.message || "Couldn't import from that Google Sheet link.", "danger");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

/* =========================================================
   Preview rendering
   ========================================================= */
function handleParse(section) {
  if (section === "b2b") {
    handleParseB2B();
    return;
  }
  handleParseGrid(section);
}

function handleClear(section) {
  parsedRows[section] = [];
  sectionHasErrors[section] = false;
  if (section === "b2b") {
    initB2BGrid(8);
    lastUnregisteredB2B = [];
  } else {
    initGrid(section, 8);
  }
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
  const b2bInvoiceCount = new Set(parsedRows.b2b.map((r) => `${r.raw.gstin}|${r.raw.inum}`)).size;
  const unregCount = lastUnregisteredB2B.length;
  const totalInvoices = b2bInvoiceCount + unregCount;

  document.getElementById("g1SummaryStrip").innerHTML = `
    <div class="g1-summary-chip"><span class="n">${totalInvoices}</span>Total Invoices this month</div>
    <div class="g1-summary-chip"><span class="n">${b2bInvoiceCount}</span>Registered (B2B)</div>
    <div class="g1-summary-chip"><span class="n">${unregCount}</span>Unregistered (B2C)</div>
    <div class="g1-summary-chip"><span class="n">${parsedRows.b2cs.length}</span>B2CS Rows</div>
    <div class="g1-summary-chip"><span class="n">${parsedRows.hsn.length}</span>HSN Rows</div>
    <div class="g1-summary-chip"><span class="n">${parsedRows.doc.length}</span>Doc Ranges</div>
    <div class="g1-summary-chip"><span class="n">₹${taxableTotal.toLocaleString("en-IN")}</span>Taxable Value</div>
    <div class="g1-summary-chip"><span class="n">₹${taxTotal.toLocaleString("en-IN")}</span>Total Tax</div>
  `;
}

/* =========================================================
   Save this month's sales data (Firestore) + Export to Excel
   ========================================================= */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Persists the current parsed rows for this client/period so the party's
 *  sales details can be looked up and viewed again anytime — not just once a year. */
async function saveSalesRecord() {
  const record = {
    id: salesRecordId(selectedClient.id, selectedPeriod.monthKey),
    clientId: selectedClient.id,
    clientName: selectedClient.businessName,
    monthKey: selectedPeriod.monthKey,
    monthLabel: selectedPeriod.label,
    freq: selectedPeriod.freq,
    fp: monthKeyToFp(selectedPeriod.monthKey),
    updatedAt: new Date().toISOString(),
    b2b: parsedRows.b2b.map((r) => r.raw),
    b2cs: parsedRows.b2cs.map((r) => r.raw),
    hsn: parsedRows.hsn.map((r) => r.raw),
    doc: parsedRows.doc.map((r) => r.raw),
    unregisteredB2B: lastUnregisteredB2B,
  };
  await DB.put(DB.STORES.gstr1Sales, record);
  savedSalesMap.set(`${record.clientId}|${record.monthKey}`, record);
  const idx = allSalesRecords.findIndex((r) => r.id === record.id);
  if (idx === -1) allSalesRecords.push(record);
  else allSalesRecords[idx] = record;
}

/** Builds a sheet that replicates the official GST Offline Tool template's
 *  exact row layout — title row, summary-labels row, summary-values row,
 *  THEN the real column headers on row 4 — because the tool's importer
 *  validates the header row by position, not just by name. A header on
 *  row 1 (which is what a plain json_to_sheet export would give) fails
 *  its "Column Headers Missing/Mismatch" check even with the right names. */
function buildOfficialSheet(title, summaryLabels, summaryValues, headers, dataRows) {
  const aoa = [[title, "HELP"], summaryLabels, summaryValues, headers, ...dataRows];
  return XLSX.utils.aoa_to_sheet(aoa);
}

/** Builds a multi-sheet .xlsx workbook of the current month's sales details
 *  for this party, laid out to match the official GST Offline Tool's own
 *  template exactly (sheet names, header row position, column order) so
 *  it can be fed straight into the tool's "Import Excel Workbook" option,
 *  which then generates the portal-ready JSON itself. */
function exportSalesToExcel() {
  const wb = XLSX.utils.book_new();
  const safeName = (selectedClient.businessName || "client").replace(/[^a-zA-Z0-9]+/g, "_");
  const fp = monthKeyToFp(selectedPeriod.monthKey);
  const sum = (rows, key) => round2(rows.reduce((t, r) => t + (Number(r.raw[key]) || 0), 0));

  if (parsedRows.b2b.length) {
    const rows = parsedRows.b2b;
    const recipients = new Set(rows.map((r) => r.raw.gstin)).size;
    const invoices = new Set(rows.map((r) => r.raw.inum)).size;
    const sheet = buildOfficialSheet(
      "Summary For B2B, SEZ, DE (4A, 4B, 6B, 6C)",
      ["No. of Recipients", "No. of Invoices", "Total Invoice Value", "Total Taxable Value", "Total Cess"],
      [recipients, invoices, sum(rows, "val"), sum(rows, "txval"), 0],
      ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount"],
      rows.map((r) => [
        r.raw.gstin,
        r.raw.cname || "",
        r.raw.inum,
        r.raw.idt,
        r.raw.val,
        STATE_CODES[r.raw.pos] ? `${r.raw.pos}-${STATE_CODES[r.raw.pos]}` : r.raw.pos,
        r.raw.rchrg,
        "",
        "Regular B2B",
        "",
        r.raw.rt,
        r.raw.txval,
        0,
      ])
    );
    XLSX.utils.book_append_sheet(wb, sheet, "b2b,sez,de");
  }

  if (parsedRows.b2cs.length) {
    const rows = parsedRows.b2cs;
    const sheet = buildOfficialSheet(
      "Summary For B2CS(7)",
      ["Total Taxable  Value", "Total Cess"],
      [sum(rows, "txval"), 0],
      ["Type", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
      rows.map((r) => [
        r.raw.sply_ty === "INTER" ? "E" : "OE",
        STATE_CODES[r.raw.pos] ? `${r.raw.pos}-${STATE_CODES[r.raw.pos]}` : r.raw.pos,
        "",
        r.raw.rt,
        r.raw.txval,
        0,
        "",
      ])
    );
    XLSX.utils.book_append_sheet(wb, sheet, "b2cs");
  }

  if (parsedRows.hsn.length) {
    const rows = parsedRows.hsn;
    const sheet = buildOfficialSheet(
      "Summary For HSN(12)",
      ["No. of HSN", "Total Value", "Total Taxable Value", "Total Integrated Tax", "Total Central Tax", "Total State/UT Tax", "Total Cess"],
      [rows.length, sum(rows, "val"), sum(rows, "txval"), sum(rows, "igst"), sum(rows, "cgst"), sum(rows, "sgst"), 0],
      ["HSN", "Description", "UQC", "Total Quantity", "Total Value", "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"],
      rows.map((r) => {
        const taxTotal = round2(Number(r.raw.igst) + Number(r.raw.cgst) + Number(r.raw.sgst));
        const rate = r.raw.txval > 0 ? round2((taxTotal / r.raw.txval) * 100) : 0;
        return [r.raw.hsn_sc, r.raw.desc, r.raw.uqc, r.raw.qty, r.raw.val, rate, r.raw.txval, r.raw.igst, r.raw.cgst, r.raw.sgst, 0];
      })
    );
    // The official tool splits HSN into two sheets (hsn(b2b) / hsn(b2c)) since
    // release 3.2.2. We keep one combined HSN section for simplicity, so this
    // exports as hsn(b2b) — the more common case. If a client's HSN entries
    // are mostly B2C, rename this tab to "hsn(b2c)" before importing.
    XLSX.utils.book_append_sheet(wb, sheet, "hsn(b2b)");
  }

  if (parsedRows.doc.length) {
    const rows = parsedRows.doc;
    const sheet = buildOfficialSheet(
      "Summary of documents issued during the tax period (13)",
      ["Total Number", "Total Cancelled"],
      [sum(rows, "totnum"), sum(rows, "cancel")],
      ["Nature of Document", "Sr. No. From", "Sr. No. To", "Total Number", "Cancelled"],
      rows.map((r) => [r.raw.nature, r.raw.from, r.raw.to, r.raw.totnum, r.raw.cancel])
    );
    XLSX.utils.book_append_sheet(wb, sheet, "docs");
  }

  XLSX.writeFile(wb, `GSTR1_${safeName}_${fp}.xlsx`);
}

/* =========================================================
   Generate GSTR-1 JSON (GSTN offline-tool schema) — rebuilt
   against the official GST Offline Tool's own Excel/CSV column
   structure, so the output matches what the tool itself expects.
   ========================================================= */
function buildGstr1Json() {
  const gstin = selectedClient.gstin;
  const fp = monthKeyToFp(selectedPeriod.monthKey);
  const json = { gstin, fp };

  // B2B — grouped by recipient GSTIN, then by invoice number.
  if (parsedRows.b2b.length) {
    const byCtin = new Map();
    parsedRows.b2b.forEach((r) => {
      const d = r.raw;
      if (!byCtin.has(d.gstin)) byCtin.set(d.gstin, new Map());
      const invMap = byCtin.get(d.gstin);
      if (!invMap.has(d.inum)) {
        invMap.set(d.inum, { inum: d.inum, idt: d.idt, val: round2(d.val), pos: d.pos, rchrg: d.rchrg, inv_typ: "R", itms: [] });
      }
      const inv = invMap.get(d.inum);
      inv.itms.push({
        num: inv.itms.length + 1,
        itm_det: { txval: round2(d.txval), rt: d.rt, iamt: round2(d.igst), camt: round2(d.cgst), samt: round2(d.sgst), csamt: 0 },
      });
    });
    json.b2b = [...byCtin.entries()].map(([ctin, invMap]) => ({ ctin, inv: [...invMap.values()] }));
  }

  // B2C Small — one consolidated entry per parsed row.
  if (parsedRows.b2cs.length) {
    json.b2cs = parsedRows.b2cs.map((r) => ({
      sply_ty: r.raw.sply_ty === "INTER" ? "INTER" : "INTRA",
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

  // HSN Summary — real Tally/portal exports nest the array under "hsn_b2b"
  // (not "data"), never include a "val" (total incl. tax) field, and put
  // the description text in "user_desc" — "desc" itself stays blank.
  if (parsedRows.hsn.length) {
    json.hsn = {
      hsn_b2b: parsedRows.hsn.map((r, i) => ({
        num: i + 1,
        hsn_sc: r.raw.hsn_sc,
        txval: round2(r.raw.txval),
        iamt: round2(r.raw.igst),
        camt: round2(r.raw.cgst),
        samt: round2(r.raw.sgst),
        csamt: 0,
        desc: "",
        user_desc: r.raw.desc || "",
        uqc: r.raw.uqc,
        qty: r.raw.qty,
        rt: r.raw.rt,
      })),
    };
  }

  // Documents Issued — no "doc_typ" field in the real export; each doc_num
  // group's docs[] entries carry from/to/totnum/cancel/net_issue only.
  if (parsedRows.doc.length) {
    json.doc_issue = {
      doc_det: parsedRows.doc.map((r) => ({
        doc_num: r.raw.doc_num,
        docs: [{ cancel: r.raw.cancel, from: r.raw.from, net_issue: r.raw.net_issue, num: 1, to: r.raw.to, totnum: r.raw.totnum }],
      })),
    };
  }

  return json;
}

function handleGenerateJson() {
  const anySectionFilled = Object.values(parsedRows).some((r) => r.length > 0);
  if (!anySectionFilled) {
    toast("Validate at least one section before generating.", "warning");
    return;
  }
  const anyErrors = Object.values(sectionHasErrors).some(Boolean);
  const banner = document.getElementById("finalErrorBanner");
  if (anyErrors) {
    banner.classList.add("show");
    banner.innerHTML = `<strong>Fix the highlighted rows first.</strong> The rows in red above will cause the GST portal to reject the JSON — correct them, re-validate, then generate again.`;
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

async function handleSave() {
  const anySectionFilled = Object.values(parsedRows).some((r) => r.length > 0);
  if (!anySectionFilled) {
    toast("Validate at least one section before saving.", "warning");
    return;
  }
  const anyErrors = Object.values(sectionHasErrors).some(Boolean);
  const banner = document.getElementById("finalErrorBanner");
  if (anyErrors) {
    banner.classList.add("show");
    banner.innerHTML = `<strong>Fix the highlighted rows first.</strong> Correct them, re-validate, then save again.`;
    toast("Some rows still have errors — fix them before saving.", "danger");
    return;
  }
  banner.classList.remove("show");
  banner.innerHTML = "";

  if (lastB2BDateWarnings.length) {
    const ok = window.confirm(
      `${lastB2BDateWarnings.length} B2B invoice(s) are dated outside ${selectedPeriod.label} (the return period you're filing).\n\n` +
      `This is allowed (backdated / late-booked invoices happen) but needs your confirmation.\n\nSave anyway?`
    );
    if (!ok) {
      toast("Save cancelled — fix the invoice date(s), or confirm to save anyway.", "warning");
      return;
    }
  }

  const btn = document.getElementById("saveBtn");
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin me-1"></i>Saving…`;
  try {
    await saveSalesRecord();
    renderPendingListForClient();
    toast(`Sales details saved for ${selectedPeriod.label} — you can come back and view or export this anytime.`, "success");
  } catch (err) {
    console.error("Failed to save sales record:", err);
    toast("Couldn't save this period's data — check your connection and try again.", "danger");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
}

function handleExport() {
  const anySectionFilled = Object.values(parsedRows).some((r) => r.length > 0);
  if (!anySectionFilled) {
    toast("Validate at least one section before exporting.", "warning");
    return;
  }
  const anyErrors = Object.values(sectionHasErrors).some(Boolean);
  const banner = document.getElementById("finalErrorBanner");
  if (anyErrors) {
    banner.classList.add("show");
    banner.innerHTML = `<strong>Fix the highlighted rows first.</strong> Correct them, re-validate, then export again.`;
    toast("Some rows still have errors — fix them before exporting.", "danger");
    return;
  }
  banner.classList.remove("show");
  banner.innerHTML = "";
  exportSalesToExcel();
  toast(`Exported ${selectedPeriod.label} sales details to Excel.`, "success");
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
  document.getElementById("showFiledToggle").addEventListener("change", renderPendingListForClient);

  document.querySelectorAll("#g1Tabs .g1-tab-btn").forEach((btn) =>
    btn.addEventListener("click", () => switchSection(btn.dataset.section))
  );

  document.getElementById("sampleExcelBtn").addEventListener("click", downloadSampleExcel);

  document.getElementById("excelUploadBtn").addEventListener("click", () => {
    if (typeof XLSX === "undefined") {
      toast("The Excel reader is still loading — wait a second and try again, or check your internet connection.", "warning");
      return;
    }
    document.getElementById("excelUploadInput").click();
  });
  document.getElementById("excelUploadInput").addEventListener("change", handleExcelUpload);

  const SECTION_LABELS = { b2b: "B2B", b2cs: "B2C Small", hsn: "HSN", doc: "Documents" };
  document.getElementById("sheetImportBtn").addEventListener("click", () => {
    document.getElementById("sheetImportSectionLabel").textContent = SECTION_LABELS[activeSection] || activeSection;
    document.getElementById("sheetImportSectionHint").textContent = SECTION_LABELS[activeSection] || activeSection;
    document.getElementById("sheetImportPanel").style.display = "block";
    document.getElementById("sheetImportUrl").focus();
  });
  document.getElementById("sheetImportCancelBtn").addEventListener("click", () => {
    document.getElementById("sheetImportPanel").style.display = "none";
  });
  document.getElementById("sheetImportFetchBtn").addEventListener("click", handleSheetImportFetch);

  document.getElementById("b2bApplyDefaults").addEventListener("click", () => {
    const pos = document.getElementById("b2bDefaultPos").value;
    const rchrg = document.getElementById("b2bDefaultRchrg").value;
    const hsn = document.getElementById("b2bDefaultHsn").value.trim();
    document.querySelectorAll("#b2bGridBody tr").forEach((tr) => {
      tr.querySelector('[data-col="pos"]').value = pos;
      tr.querySelector('[data-col="rchrg"]').value = rchrg;
      if (hsn) tr.querySelector('[data-col="hsn"]').value = hsn;
    });
    toast("Applied to all rows — you can still edit any row individually.", "success");
  });
  document.getElementById("b2bAddRows").addEventListener("click", () => addB2BRows(5));
  document.getElementById("b2csAddRows").addEventListener("click", () => addGridRows("b2cs", 5));
  document.getElementById("hsnAddRows").addEventListener("click", () => addGridRows("hsn", 5));
  document.getElementById("docAddRows").addEventListener("click", () => addGridRows("doc", 5));
  document.getElementById("b2csSyncBtn").addEventListener("click", syncB2csFromUnregisteredB2B);

  document.querySelectorAll("[data-parse]").forEach((btn) =>
    btn.addEventListener("click", () => handleParse(btn.dataset.parse))
  );
  document.querySelectorAll("[data-clear]").forEach((btn) =>
    btn.addEventListener("click", () => handleClear(btn.dataset.clear))
  );

  document.getElementById("saveBtn").addEventListener("click", handleSave);
  document.getElementById("exportExcelBtn").addEventListener("click", handleExport);
  document.getElementById("generateJsonBtn").addEventListener("click", handleGenerateJson);
}

document.addEventListener("DOMContentLoaded", init);
