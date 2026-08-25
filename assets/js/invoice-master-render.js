/**
 * GST MASTER — Invoice Master Sale Invoice Renderer
 * Renders a manually created, multi-line-item sale invoice using the
 * same Tally-style shell as the GST filing fee invoices, so both print
 * consistently.
 */
import { formatDate, formatCurrency, amountInWords } from "./utils.js";
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

export function renderSalesInvoice(invoice, client, settings) {
  const items = invoice.items || [];
  const subTotal = items.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
  const gst = gstBreakup(subTotal, settings);
  const vpa = settings.payeeVpa || "";
  const payeeName = settings.payeeName || settings.companyName || "";
  const qrSrc = upiQrUrl(vpa, payeeName, subTotal, invoice.invoiceNo);

  const rows = items
    .map((it, i) => {
      const rowGst = gstBreakup(it.amount, settings);
      return `
      <tr>
        <td class="text-center">${i + 1}</td>
        <td>${escapeHtml(it.description || "—")}
          ${it.hsn ? `<div class="cell-sub font-mono">HSN/SAC: ${escapeHtml(it.hsn)}</div>` : ""}
          <div class="cell-sub">${Number(it.qty) || 1} × ${formatCurrency(it.rate)}</div>
        </td>
        ${taxDataCells(rowGst)}
        <td class="text-end">${formatCurrency(it.amount)}</td>
      </tr>`;
    })
    .join("");

  const colspanBeforeTotal = 2 + (gst.enabled ? (gst.isIgst ? 2 : 3) : 0);

  return tallyShell(`
    ${titleBlock(invoice.invoiceNo)}
    ${topGrid(settings, [
      {
        label: "Invoice Details",
        rows: [
          ["Invoice No", invoice.invoiceNo],
          ["Invoice Date", formatDate(invoice.invoiceDate || new Date().toISOString())],
          ["Status", invoice.status || "Unpaid"],
        ],
      },
    ])}
    ${buyerGrid(client, settings)}
    <div class="tally-table-wrap">
      <table class="tally-table">
        <thead>
          <tr>
            <th class="text-center">#</th>
            <th>Description</th>
            ${taxHeadCells(settings)}
            <th class="text-end">Amount</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="3" class="text-center text-muted-soft py-3">No items.</td></tr>`}</tbody>
        <tfoot>
          ${taxFootRows(gst)}
          <tr class="tally-grand-total"><td colspan="${colspanBeforeTotal}">Total</td><td class="text-end">${formatCurrency(subTotal)}</td></tr>
        </tfoot>
      </table>
    </div>
    <div class="tally-words"><span class="tally-label">Amount in Words:</span>${escapeHtml(amountInWords(subTotal))}</div>
    ${invoice.notes ? `<div class="tally-words"><span class="tally-label">Notes:</span>${escapeHtml(invoice.notes)}</div>` : ""}
    ${vpa ? bankAndSignatoryGrid(settings, qrSrc, vpa, payeeName, subTotal) : ""}
    <div class="tally-footer-note">This is a computer-generated invoice and does not require a physical signature.</div>`);
}
