/**
 * GST MASTER — Invoice Master Sale Invoice Renderer
 * Renders a manually created, multi-line-item sale invoice using the
 * same Tally-style shell as the GST filing fee invoices, so both print
 * consistently.
 */
import { formatDate, formatCurrency, amountInWords } from "./utils.js";
import { escapeHtml, titleBlock, topGrid, buyerGrid, bankAndSignatoryGrid, tallyShell, upiQrUrl } from "./invoice-render.js";

/**
 * Per-item tax split, at that item's OWN gst % (unlike the GST-filing-fee
 * invoices, Invoice Master items carry their own rate rather than one
 * shared Settings rate) — plus any extra HSN splits nested under it.
 */
function lineGst(taxable, rate, isIgst) {
  const tax = (Number(taxable) * Number(rate)) / 100;
  return {
    taxable: Number(taxable) || 0,
    rate: Number(rate) || 0,
    cgst: isIgst ? 0 : tax / 2,
    sgst: isIgst ? 0 : tax / 2,
    igst: isIgst ? tax : 0,
    tax,
  };
}

function taxCell(g, isIgst) {
  const cell = (v) => `<td class="text-end">${formatCurrency(v)}</td>`;
  return cell(g.taxable) + (isIgst ? cell(g.igst) : cell(g.cgst) + cell(g.sgst));
}

export function renderSalesInvoice(invoice, client, settings) {
  const items = invoice.items || [];
  const isIgst = settings.gstType === "IGST";
  const vpa = settings.payeeVpa || "";
  const payeeName = settings.payeeName || settings.companyName || "";

  let subTotal = 0;
  let taxTotal = 0;

  const rows = items
    .map((it, i) => {
      const main = lineGst(it.amount, it.gstRate, isIgst);
      subTotal += main.taxable;
      taxTotal += main.tax;

      const splitRows = (it.hsnBreakup || [])
        .map((s) => {
          const g = lineGst(s.taxableValue, s.taxRate, isIgst);
          subTotal += g.taxable;
          taxTotal += g.tax;
          return `
          <tr>
            <td></td>
            <td class="cell-sub">${s.hsn ? `HSN/SAC: ${escapeHtml(s.hsn)} · ` : ""}${g.rate}% GST</td>
            ${taxCell(g, isIgst)}
            <td class="text-end cell-sub">—</td>
          </tr>`;
        })
        .join("");

      return `
      <tr>
        <td class="text-center">${i + 1}</td>
        <td>${escapeHtml(it.description || "—")}
          ${it.hsn ? `<div class="cell-sub font-mono">HSN/SAC: ${escapeHtml(it.hsn)}</div>` : ""}
          <div class="cell-sub">${Number(it.qty) || 1} × ${formatCurrency(it.rate)} · ${main.rate}% GST</div>
        </td>
        ${taxCell(main, isIgst)}
        <td class="text-end">${formatCurrency(it.amount)}</td>
      </tr>${splitRows}`;
    })
    .join("");

  const discount = Number(invoice.discount) || 0;
  const grandTotal = subTotal + taxTotal - discount;
  const qrSrc = upiQrUrl(vpa, payeeName, grandTotal, invoice.invoiceNo);
  const cgst = isIgst ? 0 : taxTotal / 2;
  const sgst = isIgst ? 0 : taxTotal / 2;
  const igst = isIgst ? taxTotal : 0;

  const colspanBeforeTotal = isIgst ? 3 : 4; // #, Description, Taxable [+ CGST/SGST or IGST]

  const footRows = [
    `<tr><td colspan="${colspanBeforeTotal}">Taxable Value</td><td class="text-end">${formatCurrency(subTotal)}</td></tr>`,
    isIgst
      ? `<tr><td colspan="${colspanBeforeTotal}">IGST</td><td class="text-end">${formatCurrency(igst)}</td></tr>`
      : `<tr><td colspan="${colspanBeforeTotal}">CGST</td><td class="text-end">${formatCurrency(cgst)}</td></tr>
         <tr><td colspan="${colspanBeforeTotal}">SGST</td><td class="text-end">${formatCurrency(sgst)}</td></tr>`,
    discount > 0
      ? `<tr><td colspan="${colspanBeforeTotal}">Discount</td><td class="text-end">-${formatCurrency(discount)}</td></tr>`
      : "",
  ].join("");

  return tallyShell(`
    ${titleBlock(invoice.invoiceNo)}
    ${topGrid(settings, [
      {
        label: "Invoice Details",
        rows: [
          ["Invoice No", invoice.invoiceNo],
          ["Invoice Date", formatDate(invoice.invoiceDate || new Date().toISOString())],
          ["Payment Mode", invoice.paymentMode || "Cash"],
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
            <th class="text-end">Taxable&nbsp;Value</th>
            ${isIgst ? `<th class="text-end">IGST</th>` : `<th class="text-end">CGST</th><th class="text-end">SGST</th>`}
            <th class="text-end">Amount</th>
          </tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="${isIgst ? 4 : 5}" class="text-center text-muted-soft py-3">No items.</td></tr>`}</tbody>
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
