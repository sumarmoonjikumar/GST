import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, toast } from "./utils.js";
import { initAppChrome } from "./chrome.js";

applyStoredTheme();
const session = requireSession(["admin"]);

async function init() {
  if (!session) return;
  initAppChrome(session);

  const settings = await DB.getSettings();
  document.getElementById("companyName").value = settings.companyName || "";
  document.getElementById("companyTagline").value = settings.tagline || "";
  document.getElementById("companyAddress").value = settings.companyAddress || "";
  document.getElementById("companyGstin").value = settings.companyGstin || "";
  document.getElementById("companyState").value = settings.companyState || "";
  document.getElementById("companyPhone").value = settings.companyPhone || "";
  document.getElementById("companyEmail").value = settings.companyEmail || "";
  document.getElementById("payeeVpa").value = settings.payeeVpa || "";
  document.getElementById("payeeName").value = settings.payeeName || "";

  document.getElementById("bankName").value = settings.bankName || "";
  document.getElementById("bankBranch").value = settings.bankBranch || "";
  document.getElementById("bankAccountName").value = settings.bankAccountName || "";
  document.getElementById("bankAccountNo").value = settings.bankAccountNo || "";
  document.getElementById("bankIfsc").value = settings.bankIfsc || "";
  document.getElementById("signatoryName").value = settings.signatoryName || "";

  document.getElementById("gstEnabled").checked = !!settings.gstEnabled;
  document.getElementById("gstRate").value = settings.gstRate ?? 18;
  document.getElementById("gstType").value = settings.gstType || "CGST_SGST";
  document.getElementById("sacCode").value = settings.sacCode || "";

  document.getElementById("invoicePrefix").value = settings.invoicePrefix || "INV";
  document.getElementById("invoiceFY").value = settings.invoiceFY || "";
  document.getElementById("invoiceNextNo").value = (settings.invoiceSeq || 0) + 1;
  updateInvoicePreview();

  document.getElementById("companyForm").addEventListener("submit", onSaveCompany);
  document.getElementById("bankForm").addEventListener("submit", onSaveBank);
  document.getElementById("gstForm").addEventListener("submit", onSaveGst);
  document.getElementById("passwordForm").addEventListener("submit", onChangePassword);
  document.getElementById("invoiceNumberingForm").addEventListener("submit", onSaveInvoiceNumbering);
  ["invoicePrefix", "invoiceFY", "invoiceNextNo"].forEach((id) =>
    document.getElementById(id).addEventListener("input", updateInvoicePreview)
  );
}

function updateInvoicePreview() {
  const prefix = document.getElementById("invoicePrefix").value.trim() || "INV";
  const fy = document.getElementById("invoiceFY").value.trim() || "2026-27";
  const next = parseInt(document.getElementById("invoiceNextNo").value, 10) || 1;
  document.getElementById("invoiceNumberPreview").textContent = `${prefix}/${fy}/${String(next).padStart(3, "0")}`;
}

async function onSaveInvoiceNumbering(e) {
  e.preventDefault();
  const prefix = document.getElementById("invoicePrefix").value.trim() || "INV";
  const fy = document.getElementById("invoiceFY").value.trim();
  const nextNo = parseInt(document.getElementById("invoiceNextNo").value, 10);

  if (!fy) {
    toast("Financial year is required (e.g. 2026-27).", "danger");
    return;
  }
  if (!nextNo || nextNo < 1) {
    toast("Next number must be 1 or greater.", "danger");
    return;
  }

  await DB.saveSettings({
    invoicePrefix: prefix,
    invoiceFY: fy,
    invoiceSeq: nextNo - 1, // getNextInvoiceNumber() adds 1 back on the next invoice
  });
  await DB.logActivity("Updated invoice numbering settings", "fa-hashtag", "info");
  toast("Invoice numbering saved.", "success");
  updateInvoicePreview();
}

async function onSaveCompany(e) {
  e.preventDefault();
  const companyName = document.getElementById("companyName").value.trim();
  const payeeVpa = document.getElementById("payeeVpa").value.trim();
  const payeeName = document.getElementById("payeeName").value.trim();

  if (!companyName || !payeeVpa || !payeeName) {
    toast("Company name, UPI ID and payee name are required.", "danger");
    return;
  }

  await DB.saveSettings({
    companyName,
    tagline: document.getElementById("companyTagline").value.trim(),
    companyAddress: document.getElementById("companyAddress").value.trim(),
    companyGstin: document.getElementById("companyGstin").value.trim().toUpperCase(),
    companyState: document.getElementById("companyState").value.trim(),
    companyPhone: document.getElementById("companyPhone").value.trim(),
    companyEmail: document.getElementById("companyEmail").value.trim(),
    payeeVpa,
    payeeName,
  });
  await DB.logActivity("Updated company & invoice settings", "fa-gear", "info");
  toast("Settings saved.", "success");
}

async function onSaveBank(e) {
  e.preventDefault();
  await DB.saveSettings({
    bankName: document.getElementById("bankName").value.trim(),
    bankBranch: document.getElementById("bankBranch").value.trim(),
    bankAccountName: document.getElementById("bankAccountName").value.trim(),
    bankAccountNo: document.getElementById("bankAccountNo").value.trim(),
    bankIfsc: document.getElementById("bankIfsc").value.trim().toUpperCase(),
    signatoryName: document.getElementById("signatoryName").value.trim(),
  });
  await DB.logActivity("Updated bank account details", "fa-building-columns", "info");
  toast("Bank details saved.", "success");
}

async function onSaveGst(e) {
  e.preventDefault();
  const rate = parseFloat(document.getElementById("gstRate").value);
  await DB.saveSettings({
    gstEnabled: document.getElementById("gstEnabled").checked,
    gstRate: Number.isFinite(rate) && rate >= 0 ? rate : 18,
    gstType: document.getElementById("gstType").value,
    sacCode: document.getElementById("sacCode").value.trim(),
  });
  await DB.logActivity("Updated GST invoice settings", "fa-percent", "info");
  toast("GST settings saved.", "success");
}

async function onChangePassword(e) {
  e.preventDefault();
  const current = document.getElementById("currentPassword").value;
  const next = document.getElementById("newPassword").value;
  const confirm = document.getElementById("confirmPassword").value;

  const user = await DB.get(DB.STORES.users, session.id);
  if (!user || user.password !== current) {
    toast("Current password is incorrect.", "danger");
    return;
  }
  if (next.length < 4) {
    toast("New password must be at least 4 characters.", "danger");
    return;
  }
  if (next !== confirm) {
    toast("New password and confirmation don't match.", "danger");
    return;
  }

  user.password = next;
  user.updatedAt = new Date().toISOString();
  await DB.put(DB.STORES.users, user);
  await DB.logActivity("Password changed", "fa-key", "info");
  toast("Password updated. Use it next time you log in.", "success");
  document.getElementById("passwordForm").reset();
}

document.addEventListener("DOMContentLoaded", init);
