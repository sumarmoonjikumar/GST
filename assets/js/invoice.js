import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, formatDate, formatCurrency, upiQrUrl, amountInWords } from "./utils.js";

applyStoredTheme();
const session = requireSession(["admin", "staff", "customer"]);

async function init() {
  if (!session) return;

  const params = new URLSearchParams(window.location.search);
  const clientId = params.get("client");
  const invoiceFilter = params.get("invoice"); // when set, show only this one invoice (e.g. opened right after filing GSTR-3B)
  const root = document.getElementById("invoiceRoot");

  if (!clientId) {
    root.innerHTML = tallyShell(`<p class="text-center text-muted-soft py-5 mb-0">No client specified.</p>`);
    return;
  }

  const [client, allPayments, settings] = await Promise.all([
    DB.get(DB.STORES.clients, clientId),
    DB.getAll(DB.STORES.payments),
    DB.getSettings(),
  ]);

  if (!client) {
    root.innerHTML = tallyShell(`<p class="text-center text-muted-soft py-5 mb-0">Client not found.</p>`);
    return;
  }

  // Customers may only view their own invoice.
  if (session.role === "customer" && session.clientId !== clientId) {
    root.innerHTML = tallyShell(`<p class="text-center text-muted-soft py-5 mb-0">You don't have access to this invoice.</p>`);
    return;
  }

  // Every month the party hasn't paid yet — sorted oldest billing period first.
  let pending = allPayments
    .filter((p) => p.clientId === clientId && p.status !== "Paid")
    .sort((a, b) => {
      const da = a.billingPeriod ? new Date(`01 ${a.billingPeriod}`) : new Date(a.date || 0);
      const db = b.billingPeriod ? new Date(`01 ${b.billingPeriod}`) : new Date(b.date || 0);
      return da - db;
    });

  if (invoiceFilter) {
    pending = pending.filter((p) => p.invoiceNo === invoiceFilter);
  }

  const vpa = settings.payeeVpa || "punithan.m.8-1@okhdfcbank";
  const payeeName = settings.payeeName || settings.companyName || "Friends Tax";

  if (pending.length === 0) {
    document.title = `Invoice — ${client.businessName}`;
    root.innerHTML = tallyShell(`
      ${titleBlock(invoiceFilter ? "Invoice" : "Outstanding Statement", invoiceFilter ? "TAX INVOICE" : "STATEMENT")}
      ${topGrid(settings, [
        { label: invoiceFilter ? "Invoice" : "Statement", rows: [["Date", formatDate(new Date().toISOString())]] },
      ])}
      <div class="all-paid-box">
        <i class="fa-solid fa-circle-check"></i>
        <h5>All caught up</h5>
        <p class="text-muted-soft small mb-0">${escapeHtml(client.businessName)} has no pending payments right now.</p>
      </div>`);
    return;
  }

  // A specific invoice number was requested (e.g. right after filing a
  // month's GSTR-3B) — show that one month only, its own invoice.
  if (invoiceFilter) {
    await assignMissingInvoiceNumbers(pending);
    const p = pending[0];
    document.title = `Invoice ${p.invoiceNo} — ${client.businessName}`;
    root.innerHTML = renderSingleInvoice(p, client, settings, vpa, payeeName);
    return;
  }

  // No specific invoice requested — this is the party's outstanding
  // statement: every pending month listed together in one bill, each
  // keeping its own invoice number and amount, with a combined total.
  await assignMissingInvoiceNumbers(pending);
  document.title = `Outstanding — ${client.businessName}`;
  root.innerHTML = renderOutstandingStatement(pending, client, settings, vpa, payeeName);
}

/** Splits a stored (GST-inclusive) amount into taxable value + tax, per Settings. */
function gstBreakup(amount, settings) {
  const total = Number(amount) || 0;
  if (!settings.gstEnabled) return { enabled: false, taxable: total, cgst: 0, sgst: 0, igst: 0, total };
  const rate = Number(settings.gstRate) || 0;
  const taxable = rate > 0 ? total / (1 + rate / 100) : total;
  const tax = total - taxable;
  const isIgst = settings.gstType === "IGST";
  return {
    enabled: true,
    taxable,
    cgst: isIgst ? 0 : tax / 2,
    sgst: isIgst ? 0 : tax / 2,
    igst: isIgst ? tax : 0,
    isIgst,
    total,
  };
}

function titleBlock(label, mainHeading = "TAX INVOICE") {
  return `
    <div class="tally-title">${escapeHtml(mainHeading)}
      <span class="tally-title-sub">${escapeHtml(label)}</span>
    </div>`;
}

/** Seller (left) + invoice meta (right) bordered header row. */
function topGrid(settings, metaBoxes) {
  const seller = `
    <div class="tally-box">
      <div class="tally-name">${escapeHtml(settings.companyName || "Friends Tax")}</div>
      ${settings.companyAddress ? `<div class="tally-line">${escapeHtml(settings.companyAddress).replace(/\n/g, "<br>")}</div>` : ""}
      ${settings.companyGstin ? `<div class="tally-line">GSTIN: <span class="font-mono">${escapeHtml(settings.companyGstin)}</span></div>` : ""}
      ${settings.companyState ? `<div class="tally-line">State: ${escapeHtml(settings.companyState)}</div>` : ""}
      ${settings.companyPhone || settings.companyEmail ? `<div class="tally-line">${escapeHtml([settings.companyPhone, settings.companyEmail].filter(Boolean).join(" · "))}</div>` : ""}
    </div>`;

  const metaHtml = metaBoxes
    .map(
      (box) => `
      <div class="tally-box">
        <div class="tally-label">${escapeHtml(box.label)}</div>
        ${box.rows.map(([k, v]) => `<div class="tally-meta-row"><span class="k">${escapeHtml(k)}</span><span class="v font-mono">${escapeHtml(String(v))}</span></div>`).join("")}
      </div>`
    )
    .join("");

  return `<div class="tally-grid">${seller}${metaHtml}</div>`;
}

function buyerGrid(client, settings) {
  return `
    <div class="tally-grid">
      <div class="tally-box">
        <div class="tally-label">Bill To</div>
        <div class="tally-name">${escapeHtml(client.businessName)}</div>
        ${client.address ? `<div class="tally-line">${escapeHtml(client.address).replace(/\n/g, "<br>")}</div>` : ""}
        <div class="tally-line">GSTIN: <span class="font-mono">${escapeHtml(client.gstin || "—")}</span></div>
        ${client.contactPerson || client.contactPhone ? `<div class="tally-line">${escapeHtml([client.contactPerson, client.contactPhone].filter(Boolean).join(" · "))}</div>` : ""}
      </div>
      <div class="tally-box">
        <div class="tally-label">Place of Supply</div>
        <div class="tally-line">${escapeHtml(settings.companyState || "—")}</div>
      </div>
    </div>`;
}

function bankAndSignatoryGrid(settings, qrSrc, vpa, payeeName, amount) {
  const hasBank = settings.bankName || settings.bankAccountNo;
  return `
    <div class="tally-bottom-grid">
      ${
        hasBank
          ? `<div class="tally-box">
              <div class="tally-label">Bank Details</div>
              ${settings.bankName ? `<div class="tally-line">Bank: ${escapeHtml(settings.bankName)}</div>` : ""}
              ${settings.bankAccountName ? `<div class="tally-line">A/c Name: ${escapeHtml(settings.bankAccountName)}</div>` : ""}
              ${settings.bankAccountNo ? `<div class="tally-line">A/c No: <span class="font-mono">${escapeHtml(settings.bankAccountNo)}</span></div>` : ""}
              ${settings.bankIfsc ? `<div class="tally-line">IFSC: <span class="font-mono">${escapeHtml(settings.bankIfsc)}</span></div>` : ""}
              ${settings.bankBranch ? `<div class="tally-line">Branch: ${escapeHtml(settings.bankBranch)}</div>` : ""}
            </div>`
          : ""
      }
      <div class="tally-box tally-qr-box">
        <div class="tally-label">Scan to Pay (UPI)</div>
        <img src="${qrSrc}" width="118" height="118" alt="Scan to pay via UPI">
        <div class="tally-line font-mono">${escapeHtml(vpa)}</div>
        <div class="tally-line">${formatCurrency(amount)}</div>
      </div>
    </div>`;
}

function taxHeadCells(settings) {
  return settings.gstEnabled
    ? `<th class="text-end">Taxable&nbsp;Value</th>${
        settings.gstType === "IGST" ? `<th class="text-end">IGST</th>` : `<th class="text-end">CGST</th><th class="text-end">SGST</th>`
      }`
    : "";
}

function taxDataCells(gst) {
  if (!gst.enabled) return "";
  const cell = (v) => `<td class="text-end">${formatCurrency(v)}</td>`;
  return cell(gst.taxable) + (gst.isIgst ? cell(gst.igst) : cell(gst.cgst) + cell(gst.sgst));
}

function taxFootRows(gst) {
  if (!gst.enabled) return "";
  const colspanBefore = 2; // #, Description
  const rows = [`<tr><td colspan="${colspanBefore}">Taxable Value</td><td class="text-end">${formatCurrency(gst.taxable)}</td></tr>`];
  if (gst.isIgst) {
    rows.push(`<tr><td colspan="${colspanBefore}">IGST</td><td class="text-end">${formatCurrency(gst.igst)}</td></tr>`);
  } else {
    rows.push(`<tr><td colspan="${colspanBefore}">CGST</td><td class="text-end">${formatCurrency(gst.cgst)}</td></tr>`);
    rows.push(`<tr><td colspan="${colspanBefore}">SGST</td><td class="text-end">${formatCurrency(gst.sgst)}</td></tr>`);
  }
  return rows.join("");
}

/** Renders one payment record as a fully standalone Tally-style tax invoice. */
function renderSingleInvoice(p, client, settings, vpa, payeeName) {
  const amount = Number(p.amount) || 0;
  const gst = gstBreakup(amount, settings);
  const qrSrc = upiQrUrl(vpa, payeeName, amount, `${p.invoiceNo}`);

  const row = `
    <tr>
      <td class="text-center">1</td>
      <td>GST Filing &amp; Consulting Fee — ${escapeHtml(p.billingPeriod || "—")}
        <div class="cell-sub">Status: ${escapeHtml(p.status)}</div>
      </td>
      ${taxDataCells(gst)}
      <td class="text-end">${formatCurrency(gst.enabled ? gst.taxable : amount)}</td>
    </tr>`;

  const colspanBeforeTotal = 2 + (gst.enabled ? (gst.isIgst ? 2 : 3) : 0);

  return tallyShell(`
    ${titleBlock(p.invoiceNo)}
    ${topGrid(settings, [
      {
        label: "Invoice Details",
        rows: [
          ["Invoice No", p.invoiceNo],
          ["Invoice Date", formatDate(p.date || new Date().toISOString())],
        ],
      },
    ])}
    ${buyerGrid(client, settings)}
    <div class="tally-table-wrap">
      <table class="tally-table">
        <thead>
          <tr>
            <th class="text-center">#</th>
            <th>Description of Services</th>
            ${taxHeadCells(settings)}
            <th class="text-end">Amount</th>
          </tr>
        </thead>
        <tbody>${row}</tbody>
        <tfoot>
          ${taxFootRows(gst)}
          <tr class="tally-grand-total"><td colspan="${colspanBeforeTotal}">Total Due</td><td class="text-end">${formatCurrency(amount)}</td></tr>
        </tfoot>
      </table>
    </div>
    <div class="tally-words"><span class="tally-label">Amount in Words:</span>${escapeHtml(amountInWords(amount))}</div>
    ${bankAndSignatoryGrid(settings, qrSrc, vpa, payeeName, amount)}
    <div class="tally-footer-note">This is a computer-generated invoice and does not require a physical signature.</div>`);
}

/** Renders every pending month for a party in ONE combined "Outstanding" statement — each row keeps its own invoice number and amount; only the total is combined. */
function renderOutstandingStatement(pending, client, settings, vpa, payeeName) {
  const total = pending.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  const gst = gstBreakup(total, settings);
  const qrSrc = upiQrUrl(vpa, payeeName, total, "OUTSTANDING");

  const rows = pending
    .map((p, i) => {
      const rowGst = gstBreakup(p.amount, settings);
      return `
      <tr>
        <td class="text-center">${i + 1}</td>
        <td>GST Filing &amp; Consulting Fee — ${escapeHtml(p.billingPeriod || "—")}
          <div class="cell-sub font-mono">${escapeHtml(p.invoiceNo || "—")} · <span class="text-uppercase">${escapeHtml(p.status)}</span></div>
        </td>
        ${taxDataCells(rowGst)}
        <td class="text-end">${formatCurrency(p.amount)}</td>
      </tr>`;
    })
    .join("");

  const colspanBeforeTotal = 2 + (gst.enabled ? (gst.isIgst ? 2 : 3) : 0);

  return tallyShell(`
    ${titleBlock("Statement of Outstanding", "STATEMENT")}
    ${topGrid(settings, [
      {
        label: "Statement Details",
        rows: [
          ["Date", formatDate(new Date().toISOString())],
          ["Pending Months", pending.length],
        ],
      },
    ])}
    ${buyerGrid(client, settings)}
    <div class="tally-table-wrap">
      <table class="tally-table">
        <thead>
          <tr>
            <th class="text-center">#</th>
            <th>Description of Services</th>
            ${taxHeadCells(settings)}
            <th class="text-end">Amount</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          ${taxFootRows(gst)}
          <tr class="tally-grand-total"><td colspan="${colspanBeforeTotal}">Total Outstanding</td><td class="text-end">${formatCurrency(total)}</td></tr>
        </tfoot>
      </table>
    </div>
    <div class="tally-words"><span class="tally-label">Amount in Words:</span>${escapeHtml(amountInWords(total))}</div>
    ${bankAndSignatoryGrid(settings, qrSrc, vpa, payeeName, total)}
    <div class="tally-footer-note">This is a computer-generated statement and does not require a physical signature.</div>`);
}

function tallyShell(innerHtml) {
  return `<div class="tally-invoice">${innerHtml}</div>`;
}

/**
 * Every pending payment gets its own invoice number the moment it's
 * created (see gst-filing.js), so this normally does nothing. It only
 * fills a gap for older records that predate that change — each such
 * record gets its own freshly minted number, never one shared with
 * another month.
 */
async function assignMissingInvoiceNumbers(pending) {
  const unnumbered = pending.filter((p) => !p.invoiceNo);
  for (const p of unnumbered) {
    p.invoiceNo = await DB.getNextInvoiceNumber();
    await DB.put(DB.STORES.payments, p);
  }
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

document.getElementById("printBtn")?.addEventListener("click", () => window.print());
document.addEventListener("DOMContentLoaded", init);
