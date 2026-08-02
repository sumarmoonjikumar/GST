/**
 * GST MASTER — Shared Utilities
 */

export function formatDate(iso, opts = {}) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...opts,
  });
}

export function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function formatCurrency(n) {
  const num = Number(n) || 0;
  return num.toLocaleString("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
}

const W_ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const W_TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigitWords(n) {
  if (n < 20) return W_ONES[n];
  return W_TENS[Math.floor(n / 10)] + (n % 10 ? ` ${W_ONES[n % 10]}` : "");
}

function threeDigitWords(n) {
  const hundred = Math.floor(n / 100);
  const rest = n % 100;
  let out = hundred ? `${W_ONES[hundred]} Hundred` : "";
  if (rest) out += (out ? " " : "") + twoDigitWords(rest);
  return out;
}

/** Converts a number to Indian-style words (Crore/Lakh/Thousand grouping). */
export function numberToWordsIndian(num) {
  let n = Math.floor(Math.abs(Number(num) || 0));
  if (n === 0) return "Zero";
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const hundred = n;
  const parts = [];
  if (crore) parts.push(`${threeDigitWords(crore)} Crore`);
  if (lakh) parts.push(`${threeDigitWords(lakh)} Lakh`);
  if (thousand) parts.push(`${threeDigitWords(thousand)} Thousand`);
  if (hundred) parts.push(threeDigitWords(hundred));
  return parts.join(" ");
}

/** "Rupees <words> Only" — the amount-in-words line on a Tally-style invoice. */
export function amountInWords(num) {
  return `Rupees ${numberToWordsIndian(num)} Only`;
}

export function initials(name = "") {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("");
}

/** Lightweight, dependency-free Bootstrap toast. Container is created lazily. */
export function toast(message, variant = "success") {
  let host = document.getElementById("toastHost");
  if (!host) {
    host = document.createElement("div");
    host.id = "toastHost";
    host.className = "toast-container position-fixed bottom-0 end-0 p-3";
    host.style.zIndex = 1080;
    document.body.appendChild(host);
  }
  const iconMap = {
    success: "fa-circle-check text-success",
    danger: "fa-circle-exclamation text-danger",
    info: "fa-circle-info text-info",
    warning: "fa-triangle-exclamation text-warning",
  };
  const el = document.createElement("div");
  el.className = "toast align-items-center border-0 shadow-sm";
  el.setAttribute("role", "alert");
  el.innerHTML = `
    <div class="d-flex">
      <div class="toast-body small">
        <i class="fa-solid ${iconMap[variant] || iconMap.info} me-2"></i>${message}
      </div>
      <button type="button" class="btn-close me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
    </div>`;
  host.appendChild(el);
  const t = new bootstrap.Toast(el, { delay: 3200 });
  t.show();
  el.addEventListener("hidden.bs.toast", () => el.remove());
}

/** Applies persisted theme (light/dark) to <html data-theme>. */
export function applyStoredTheme() {
  const saved = localStorage.getItem("gstm_theme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  return saved;
}

export function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("gstm_theme", next);
  return next;
}

/** Indian financial year helpers (FY = April → March). */
export function currentFY() {
  const now = new Date();
  const y = now.getFullYear();
  const startYear = now.getMonth() >= 3 ? y : y - 1; // April = month index 3
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** Returns `count` FY labels, newest first, e.g. ["2026-27","2025-26",...]. */
export function fyList(count = 6) {
  const startYear = parseInt(currentFY().split("-")[0], 10);
  return Array.from({ length: count }, (_, i) => {
    const y = startYear - i;
    return `${y}-${String((y + 1) % 100).padStart(2, "0")}`;
  });
}

const FY_MONTH_NAMES = ["Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar"];

/** Returns the 12 {key,label,month,year} entries (Apr→Mar) for a given "YYYY-YY" FY label. */
export function fyMonths(fy) {
  const startYear = parseInt(fy.split("-")[0], 10);
  return FY_MONTH_NAMES.map((name, idx) => {
    const year = idx <= 8 ? startYear : startYear + 1;
    return { key: `${name}-${year}`, label: `${name} ${year}`, month: name, year };
  });
}

/** Indicative statutory due date for a filing period (11th for GSTR-1, 20th for GSTR-3B, month after period). Informational only — not tax advice. */
export function filingDueDate(monthKey, type, frequency = "Monthly") {
  const [name, yearStr] = monthKey.split("-");
  const idx = FY_MONTH_NAMES.indexOf(name);
  if (idx === -1) return null;
  const year = parseInt(yearStr, 10);
  const calMonthIdx = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].indexOf(name);
  const day = frequency === "Quarterly" ? (type === "GSTR-1" ? 13 : 22) : (type === "GSTR-1" ? 11 : 20);
  const due = new Date(year, calMonthIdx + 1, day);
  return due.toISOString().slice(0, 10);
}

/**
 * Builds a scannable payment QR code (as an <img> src URL) for a UPI VPA.
 * Uses a public QR-image renderer so no extra library needs to be bundled —
 * the UPI deep link itself is what any UPI app reads when it scans the code.
 */
export function upiQrUrl(vpa, payeeName, amount, note = "", size = 220) {
  const params = new URLSearchParams({ pa: vpa, pn: payeeName, cu: "INR" });
  if (amount && Number(amount) > 0) params.set("am", Number(amount).toFixed(2));
  if (note) params.set("tn", note);
  const upiUri = `upi://pay?${params.toString()}`;
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(upiUri)}`;
}

export function currentSession() {
  try {
    return JSON.parse(sessionStorage.getItem("gstm_session") || localStorage.getItem("gstm_session") || "null");
  } catch {
    return null;
  }
}

export function clearSession() {
  sessionStorage.removeItem("gstm_session");
  localStorage.removeItem("gstm_session");
}
