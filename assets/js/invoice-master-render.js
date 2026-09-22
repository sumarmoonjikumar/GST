/**
 * GST MASTER — Invoice Master Sale Invoice Renderer
 * Renders a manually created, multi-line-item sale invoice using the
 * same Tally-style shell as the GST filing fee invoices, so both print
 * consistently. Mirrors the item shape used by invoice-master.js:
 * { description, hsn, qty, rate, gstRate }.
 */
import { formatDate, formatCurrency, amountInWords } from "./utils.js";
import { escapeHtml, titleBlock, topGrid, buyerGrid, bankAndSignatoryGrid, tallyShell, upiQrUrl } from "./invoice-render.js";

export function renderSalesInvoice(invoice, client, settings) {
  const items = invoice.items || [];
  const isIgst = settings.gstType === "IGST";
  const vpa = settings.payeeVpa || "";
  const payeeName = settings.payeeName || settings.companyName || "";

  let subTotal = 0;
  let taxTotal = 0;

  const rows = items
    .map((it, i) => {
      const taxable = (Number(it.qty) || 0) * (Number(it.rate) || 0);
      const rate = Number(it.gstRate) || 0;
      const tax = (taxable * rate) / 100;
      subTotal += taxable;
      taxTotal += tax;

      return `
      <tr>
        <td class="text-center">${i + 1}</td>
        <td>${escapeHtml(it.description || "—")}
          ${it.hsn ? `<div class="cell-sub font-mono">HSN/SAC: ${escapeHtml(it.hsn)}</div>` : ""}
        </td>
        <td class="text-center">${Number(it.qty) || 0}</td>
        <td class="text-end">${formatCurrency(it.rate)}</td>
        <td class="text-center">${rate}%</td>
        <td class="text-end">${formatCurrency(taxable)}</td>
      </tr>`;
    })
    .join("");

  const discount = Number(invoice.discount) || 0;
  const grandTotal = subTotal + taxTotal - discount;
  const qrSrc = upiQrUrl(vpa, payeeName, grandTotal, invoice.invoiceNo);
  const cgst = isIgst ? 0 : taxTotal / 2;
  const sgst = isIgst ? 0 : taxTotal / 2;
  const igst = isIgst ? taxTotal : 0;

  const colspanBeforeTotal = 5; // #, Description, Qty, Rate, GST

  const footRows = [
    `<tr><td colspan="${colspanBeforeTotal}">Sub Total</td><td class="text-end">${formatCurrency(subTotal)}</td></tr>`,
    isIgst
      ? `<tr><td colspan="${colspanBeforeTotal}">IGST</td><td class="text-end">${formatCurrency(igst)}</td></tr>`
      : `<tr><td colspan="${colspanBeforeTotal}">CGST</td><td class="text-end">${formatCurrency(cgst)}</td></tr>
         <tr><td colspan="${colspanBeforeTotal}">SGST</td><td class="text-end">${formatCurrency(sgst)}</td></tr>`,
    `<tr><td colspan="${colspanBeforeTotal}">Discount</td><td class="text-end">-${formatCurrency(discount)}</td></tr>`,
  ].join("");

  return tallyShell(`
    ${titleBlock(invoice.invoiceNo)}
    ${topGrid(settings, [
      {
        label: "Invoice Details",
        rows: [
          ["Invoice No", invoice.invoiceNo],
          ["Invoice Date", formatDate(invoice.invoiceDate || new Date().toISOString())],
          ["Payment", invoice.paymentMode || "Cash"],
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
            <th class="text-center">Qty</th>
            <th class="text-end">Rate</th>
            <th class="text-center">GST</th>
            <th class="text-end">Amount</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="6" class="text-center text-muted-soft py-3">No items.</td></tr>`}</tbody>
        <tfoot>
          ${footRows}
          <tr class="tally-grand-total"><td colspan="${colspanBeforeTotal}">Grand Total</td><td class="text-end">${formatCurrency(grandTotal)}</td></tr>
        </tfoot>
      </table>
    </div>
    <div class="tally-words"><span class="tally-label">Amount in Words:</span>${escapeHtml(amountInWords(grandTotal))}</div>
    ${invoice.notes ? `<div class="tally-words"><span class="tally-label">Notes:</span>${escapeHtml(invoice.notes)}</div>` : ""}
    ${vpa ? bankAndSignatoryGrid(settings, qrSrc, vpa, payeeName, grandTotal) : ""}
    <div class="tally-footer-note">This is a computer-generated invoice and does not require a physical signature.</div>`);
}
