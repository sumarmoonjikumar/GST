/**
 * GST MASTER — Shared Invoice Rendering Helpers
 * Pulled out of invoice.js so the same Tally-style layout can be reused
 * by Invoice Master's print view (invoice-master.js) without duplicating
 * markup/logic.
 */
import { formatCurrency, upiQrUrl } from "./utils.js";

/** Splits a stored (GST-inclusive) amount into taxable value + tax, per Settings. */
export function gstBreakup(amount, settings) {
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

export function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function titleBlock(label, mainHeading = "TAX INVOICE") {
  return `
    <div class="tally-title">${escapeHtml(mainHeading)}
      <span class="tally-title-sub">${escapeHtml(label)}</span>
    </div>`;
}

/** Seller (left) + invoice meta (right) bordered header row. */
export function topGrid(settings, metaBoxes) {
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

export function buyerGrid(client, settings) {
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

export function bankAndSignatoryGrid(settings, qrSrc, vpa, payeeName, amount) {
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

export function taxHeadCells(settings) {
  return settings.gstEnabled
    ? `<th class="text-end">Taxable&nbsp;Value</th>${
        settings.gstType === "IGST" ? `<th class="text-end">IGST</th>` : `<th class="text-end">CGST</th><th class="text-end">SGST</th>`
      }`
    : "";
}

export function taxDataCells(gst) {
  if (!gst.enabled) return "";
  const cell = (v) => `<td class="text-end">${formatCurrency(v)}</td>`;
  return cell(gst.taxable) + (gst.isIgst ? cell(gst.igst) : cell(gst.cgst) + cell(gst.sgst));
}

export function taxFootRows(gst) {
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

export function tallyShell(innerHtml) {
  return `<div class="tally-invoice">${innerHtml}</div>`;
}

export { upiQrUrl };
