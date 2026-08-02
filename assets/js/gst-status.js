/**
 * GST MASTER — Filing Status Helpers
 * Shared between gst-filing.js, dashboard.js and reports.js so every page
 * agrees on the same "what counts as pending" logic. Filing rows are only
 * persisted to Firestore once a staff/admin actually sets a status — until
 * then a client/period/return combo is treated as a virtual "Pending"
 * record, computed on the fly.
 */
import { filingDueDate } from "./utils.js";

const CAL_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Fiscal-quarter-end months (Apr–Mar FY). Under the QRMP scheme, a quarterly
 * client's GSTR-1/GSTR-3B for the whole quarter is filed against this month. */
const QUARTER_END_MONTHS = new Set(["Jun", "Sep", "Dec", "Mar"]);
export function isQuarterEndMonth(month) {
  return QUARTER_END_MONTHS.has(month);
}

/** Deterministic doc id so re-saving the same client/period/return upserts one record. */
export function filingRecordId(clientId, monthKey, type) {
  const safeMonth = monthKey.replace(/[^a-zA-Z0-9]/g, "");
  const safeType = type.replace(/[^a-zA-Z0-9]/g, "");
  return `gst_${clientId}_${safeMonth}_${safeType}`;
}

export function buildFilingMap(gstRecords) {
  const map = new Map();
  gstRecords.forEach((r) => map.set(`${r.clientId}|${r.monthKey}|${r.type}`, r));
  return map;
}

/** Returns the real record if one has been saved, otherwise a virtual "Pending" placeholder.
 * `frequency` ("Monthly" | "Quarterly") only affects the computed due date for virtual records. */
export function getFilingStatus(map, clientId, monthKey, type, frequency = "Monthly") {
  const rec = map.get(`${clientId}|${monthKey}|${type}`);
  if (rec) return rec;
  return {
    id: filingRecordId(clientId, monthKey, type),
    clientId,
    monthKey,
    type,
    status: "Pending",
    filedDate: null,
    dueDate: filingDueDate(monthKey, type, frequency),
    virtual: true,
  };
}

/** True once a filing period is actually due to be worked on — i.e. its own calendar month has fully ended (the next month has begun). GST returns are filed with a one-month lag (e.g. June's GSTR-3B is filed in July), so a month isn't "open" for filing the moment it starts — only once it's over. */
export function periodHasStarted(month, year) {
  const calIdx = CAL_MONTHS.indexOf(month);
  if (calIdx === -1) return false;
  const nextMonthStart = new Date(year, calIdx + 1, 1);
  return nextMonthStart <= new Date();
}

export function daysBetween(dateA, dateB) {
  const MS = 24 * 60 * 60 * 1000;
  return Math.round((new Date(dateA).setHours(0, 0, 0, 0) - new Date(dateB).setHours(0, 0, 0, 0)) / MS);
}
