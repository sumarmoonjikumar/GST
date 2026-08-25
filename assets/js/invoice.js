import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, formatDate, formatCurrency, amountInWords } from "./utils.js";
import {
  gstBreakup,
  escapeHtml,
  titleBlock,
  topGrid,
  buyerGrid,
  bankAndSignatoryGrid,
  taxHeadCells,
  taxDataCells,
  taxFootRows,
  tallyShell,
  upiQrUrl,
} from "./invoice-render.js";
import { renderSalesInvoice } from "./invoice-master-render.js";

applyStoredTheme();
const session = requireSession(["admin", "staff", "customer"]);

async function init() {
  if (!session) return;

  const params = new URLSearchParams(window.location.search);
  const salesInvoiceId = params.get("sales"); // Invoice Master sale invoice, rendered separately below
  const root = document.getElementById("invoiceRoot");

  if (salesInvoiceId) {
    await initSalesInvoice(salesInvoiceId, root);
    return;
  }

  const clientId = params.get("client");
  const invoiceFilter = params.get("invoice"); // when set, show only this one invoice (e.g. opened right after filing GSTR-3B)

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

/** Invoice Master sale invoice — a manually created, line-item invoice (not tied to a GST filing fee payment). */
async function initSalesInvoice(salesInvoiceId, root) {
  const [invoice, settings] = await Promise.all([DB.get(DB.STORES.salesInvoices, salesInvoiceId), DB.getSettings()]);

  if (!invoice) {
    root.innerHTML = tallyShell(`<p class="text-center text-muted-soft py-5 mb-0">Invoice not found.</p>`);
    return;
  }

  const client = await DB.get(DB.STORES.clients, invoice.clientId);
  if (!client) {
    root.innerHTML = tallyShell(`<p class="text-center text-muted-soft py-5 mb-0">Party not found for this invoice.</p>`);
    return;
  }

  // Customers may only view their own invoices.
  if (session.role === "customer" && session.clientId !== invoice.clientId) {
    root.innerHTML = tallyShell(`<p class="text-center text-muted-soft py-5 mb-0">You don't have access to this invoice.</p>`);
    return;
  }

  document.title = `Invoice ${invoice.invoiceNo} — ${client.businessName}`;
  root.innerHTML = renderSalesInvoice(invoice, client, settings);
}

document.getElementById("printBtn")?.addEventListener("click", () => window.print());
document.addEventListener("DOMContentLoaded", init);
