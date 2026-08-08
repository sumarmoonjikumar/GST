import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, toast, initials, whatsappLink } from "./utils.js";
import { initAppChrome } from "./chrome.js";
import { cloudinaryConfig } from "./cloudinary-config.js";

applyStoredTheme();
const session = requireSession(["admin", "staff"]); // customers never reach this page

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

let allClients = [];
let allStaff = [];
let clientOffcanvas, credsOffcanvas, viewClientModal;
let currentViewClientId = null;

async function init() {
  if (!session) return;
  initAppChrome(session);

  clientOffcanvas = new bootstrap.Offcanvas(document.getElementById("clientOffcanvas"));
  credsOffcanvas = new bootstrap.Offcanvas(document.getElementById("credsOffcanvas"));
  viewClientModal = new bootstrap.Modal(document.getElementById("viewClientModal"));

  await loadData();
  populateStaffDropdowns();
  render();
  wireEvents();
}

async function loadData() {
  const [clients, staff] = await Promise.all([
    DB.getAll(DB.STORES.clients),
    DB.getAll(DB.STORES.staff),
  ]);
  allClients = clients;
  allStaff = staff;
}

function populateStaffDropdowns() {
  const assignSelect = document.getElementById("assignedStaffId");
  const filterSelect = document.getElementById("staffFilter"); // admin-only — removed from the DOM for staff logins

  if (allStaff.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.textContent = "No staff added yet — add staff first";
    assignSelect.appendChild(opt);
  } else {
    allStaff.forEach((s) => {
      assignSelect.add(new Option(s.name, s.id));
      filterSelect?.add(new Option(s.name, s.id));
    });
  }
}

function visibleClients() {
  // Staff only ever see clients assigned to them — enforced here, not just hidden in UI.
  if (session.role === "staff") {
    return allClients.filter((c) => c.assignedStaffId === session.id);
  }
  return allClients;
}

function applyFilters(list) {
  const q = document.getElementById("clientSearch").value.trim().toLowerCase();
  const status = document.getElementById("statusFilter").value;
  const staffFilterEl = document.getElementById("staffFilter");
  const staffId = staffFilterEl ? staffFilterEl.value : "";

  return list.filter((c) => {
    if (q && !(`${c.businessName} ${c.gstin}`.toLowerCase().includes(q))) return false;
    if (status && c.status !== status) return false;
    if (staffId === "unassigned" && c.assignedStaffId) return false;
    if (staffId && staffId !== "unassigned" && c.assignedStaffId !== staffId) return false;
    return true;
  });
}

function render() {
  const list = applyFilters(visibleClients());
  const tbody = document.getElementById("clientsTableBody");
  const emptyState = document.getElementById("clientsEmptyState");
  const countLabel = document.getElementById("clientCountLabel");

  countLabel.textContent = `${list.length} client${list.length === 1 ? "" : "s"}`;

  if (list.length === 0) {
    tbody.innerHTML = "";
    emptyState.classList.remove("d-none");
    return;
  }
  emptyState.classList.add("d-none");

  tbody.innerHTML = list
    .map((c) => {
      const staffMember = allStaff.find((s) => s.id === c.assignedStaffId);

      const waMsg = `Hi ${c.contactPerson || c.businessName}, this is regarding ${c.businessName}'s GST filing with us. Please let us know if you need anything.`;
      const waHref = whatsappLink(c.contactPhone, waMsg);
      const waBtn = waHref
        ? `<a href="${waHref}" target="_blank" rel="noopener" class="btn btn-outline-secondary btn-sm" title="Message on WhatsApp"><i class="fa-brands fa-whatsapp"></i></a>`
        : `<button class="btn btn-outline-secondary btn-sm" disabled title="No phone number on file"><i class="fa-brands fa-whatsapp"></i></button>`;

      const invoiceBtn = `<button class="btn btn-outline-secondary btn-sm" data-invoice="${c.id}" title="View invoice"><i class="fa-solid fa-file-invoice-dollar"></i></button>`;
      const viewBtn = `<button class="btn btn-outline-secondary btn-sm" data-view="${c.id}" title="View full details"><i class="fa-solid fa-eye"></i></button>`;

      const actions =
        session.role === "admin"
          ? `
          ${viewBtn}
          ${waBtn}
          ${invoiceBtn}
          <button class="btn btn-outline-secondary btn-sm" data-edit="${c.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
          <button class="btn btn-outline-danger btn-sm" data-delete="${c.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>`
          : `
          ${viewBtn}
          ${waBtn}
          ${invoiceBtn}
          <button class="btn btn-outline-secondary btn-sm" data-creds="${c.id}" title="Update portal & login credentials"><i class="fa-solid fa-key"></i> Credentials</button>`;

      return `
      <tr>
        <td>
          <div class="d-flex align-items-center gap-2 client-name-cell" data-view="${c.id}" role="button" style="cursor:pointer;">
            <span class="avatar-chip">${initials(c.businessName) || "GM"}</span>
            <div>
              <div class="cell-primary">${escapeHtml(c.businessName)}</div>
              <div class="cell-sub">${escapeHtml(c.contactPerson || "—")}</div>
            </div>
          </div>
        </td>
        <td class="font-mono">${escapeHtml(c.gstin)}</td>
        <td class="font-mono">${escapeHtml(c.gstPortalUsername || "—")}</td>
        <td class="font-mono">
          ${
            c.gstPortalPassword
              ? `<span class="pw-mask" data-pw="${escapeHtml(c.gstPortalPassword)}">••••••••</span>
                 <button type="button" class="btn btn-link btn-sm p-0 ms-1 pw-toggle" title="Show/hide password"><i class="fa-solid fa-eye"></i></button>`
              : "—"
          }
        </td>
        <td data-admin-only>${staffMember ? escapeHtml(staffMember.name) : '<span class="cell-sub">Unassigned</span>'}</td>
        <td class="text-end"><div class="row-actions">${actions}</div></td>
      </tr>`;
    })
    .join("");

  if (session.role !== "admin") {
    tbody.querySelectorAll("[data-admin-only]").forEach((el) => el.remove());
  }

  tbody.querySelectorAll("[data-view]").forEach((btn) =>
    btn.addEventListener("click", () => openViewClient(btn.dataset.view))
  );
  tbody.querySelectorAll(".client-name-cell").forEach((el) =>
    el.addEventListener("click", () => openViewClient(el.dataset.view))
  );
  tbody.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => openEditClient(btn.dataset.edit))
  );
  tbody.querySelectorAll("[data-delete]").forEach((btn) =>
    btn.addEventListener("click", () => deleteClient(btn.dataset.delete))
  );
  tbody.querySelectorAll("[data-creds]").forEach((btn) =>
    btn.addEventListener("click", () => openCreds(btn.dataset.creds))
  );
  tbody.querySelectorAll("[data-invoice]").forEach((btn) =>
    // Same window, not a new tab — a new browsing context opened from an
    // installed PWA doesn't reliably share this app's session storage,
    // which was bouncing users to the login page.
    btn.addEventListener("click", () => (window.location.href = `invoice.html?client=${btn.dataset.invoice}`))
  );
  tbody.querySelectorAll(".pw-toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      const mask = btn.previousElementSibling;
      const icon = btn.querySelector("i");
      const revealed = mask.textContent !== "••••••••";
      mask.textContent = revealed ? "••••••••" : mask.dataset.pw;
      icon.className = revealed ? "fa-solid fa-eye" : "fa-solid fa-eye-slash";
    })
  );
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wireEvents() {
  document.getElementById("clientSearch").addEventListener("input", render);
  document.getElementById("statusFilter").addEventListener("change", render);
  document.getElementById("staffFilter")?.addEventListener("change", render);

  document.getElementById("addClientBtn")?.addEventListener("click", () => {
    document.getElementById("clientForm").reset();
    document.getElementById("clientId").value = "";
    document.getElementById("clientOffcanvasTitle").textContent = "Add Client";
    document.getElementById("docsUploadWrap").classList.add("d-none");
    document.getElementById("docsNewClientNote").classList.remove("d-none");
    clientOffcanvas.show();
  });

  document.getElementById("clientForm").addEventListener("submit", onSaveClient);
  document.getElementById("credsForm").addEventListener("submit", onSaveCreds);

  document.getElementById("viewClientEditBtn")?.addEventListener("click", () => {
    if (!currentViewClientId) return;
    viewClientModal.hide();
    openEditClient(currentViewClientId);
  });

  document.getElementById("kycDocBtn")?.addEventListener("click", () => document.getElementById("kycDocInput").click());
  document.getElementById("itDocBtn")?.addEventListener("click", () => document.getElementById("itDocInput").click());
  document.getElementById("kycDocInput")?.addEventListener("change", (e) => handleDocUpload("kyc", e.target.files[0]));
  document.getElementById("itDocInput")?.addEventListener("change", (e) => handleDocUpload("it", e.target.files[0]));
  document.getElementById("kycDocRemoveBtn")?.addEventListener("click", () => handleDocRemove("kyc"));
  document.getElementById("itDocRemoveBtn")?.addEventListener("click", () => handleDocRemove("it"));
}

const DOC_LABELS = { kyc: "KYC document", it: "IT document" };
const DOC_ACCEPT = /\.(pdf|jpg|jpeg|png)$/i;

function setDocButtonBusy(docType, busy) {
  const btn = document.getElementById(`${docType}DocBtn`);
  if (!btn) return;
  btn.disabled = busy;
  btn.innerHTML = busy
    ? `<span class="spinner-border spinner-border-sm me-1"></span>Uploading…`
    : `<i class="fa-solid fa-upload me-1"></i>Upload`;
}

function refreshDocUi(docType, client) {
  const urlField = `${docType}DocUrl`;
  const nameField = `${docType}DocName`;
  const url = client?.[urlField];
  const name = client?.[nameField];
  document.getElementById(`${docType}DocInfo`).textContent = url ? name || "Uploaded" : "No file uploaded";
  document.getElementById(`${docType}DocLink`).classList.toggle("d-none", !url);
  if (url) document.getElementById(`${docType}DocLink`).href = url;
  document.getElementById(`${docType}DocRemoveBtn`).classList.toggle("d-none", !url);
}

/** Rejects if the given promise doesn't settle within `ms` — used so a stuck
 *  network call shows an error instead of leaving the button spinning
 *  forever with no feedback. */
function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Uploads a file to Cloudinary's free tier via an unsigned upload preset —
 *  no backend/API secret needed, works straight from the browser. Returns
 *  the hosted file's URL. See cloudinary-config.js for one-time setup. */
async function uploadToCloudinary(file) {
  if (cloudinaryConfig.cloudName === "YOUR_CLOUD_NAME" || cloudinaryConfig.uploadPreset === "YOUR_UNSIGNED_UPLOAD_PRESET") {
    throw new Error("CLOUDINARY_NOT_CONFIGURED");
  }
  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", cloudinaryConfig.uploadPreset);
  form.append("folder", "clients");

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/auto/upload`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(data?.error?.message || `Cloudinary upload failed (HTTP ${res.status})`);
  }
  return data.secure_url;
}

async function handleDocUpload(docType, file) {
  if (!file) return;
  const clientId = document.getElementById("clientId").value;
  if (!clientId) {
    toast("Save the client first, then attach documents.", "warning");
    return;
  }
  if (!DOC_ACCEPT.test(file.name)) {
    toast("Only PDF, JPG or PNG files are allowed.", "warning");
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    toast("File is too large — please keep it under 8 MB.", "warning");
    return;
  }

  setDocButtonBusy(docType, true);
  try {
    const client = allClients.find((c) => c.id === clientId);
    const url = await withTimeout(
      uploadToCloudinary(file),
      30000,
      "Upload timed out — check your internet connection and try again."
    );

    const updated = {
      ...client,
      [`${docType}DocUrl`]: url,
      [`${docType}DocName`]: file.name,
      updatedAt: new Date().toISOString(),
    };
    delete updated[`${docType}DocPath`]; // no longer used (was the old Firebase Storage path)
    await DB.put(DB.STORES.clients, updated);
    Object.assign(client, updated);
    refreshDocUi(docType, client);
    await DB.logActivity(`Uploaded ${DOC_LABELS[docType]} for "${client.businessName}"`, "fa-file-arrow-up", "success");
    toast(`${DOC_LABELS[docType]} uploaded.`, "success");
  } catch (err) {
    console.error(`Document upload failed (${docType}):`, err);
    let hint = "Please try again.";
    if (err?.message === "CLOUDINARY_NOT_CONFIGURED") {
      hint = "File storage isn't set up yet — add your Cloudinary cloud name and upload preset in assets/js/cloudinary-config.js.";
    } else if (err?.message?.includes("timed out")) {
      hint = err.message;
    } else if (err?.message) {
      hint = err.message;
    }
    toast(`Couldn't upload the ${DOC_LABELS[docType]}. ${hint}`, "danger");
  } finally {
    setDocButtonBusy(docType, false);
    document.getElementById(`${docType}DocInput`).value = "";
  }
}

async function handleDocRemove(docType) {
  const clientId = document.getElementById("clientId").value;
  const client = allClients.find((c) => c.id === clientId);
  if (!client) return;
  if (!confirm(`Remove the ${DOC_LABELS[docType]} for ${client.businessName}?`)) return;

  // Unsigned Cloudinary uploads can't be deleted from the browser (that
  // needs a signed request with the API secret, i.e. a backend) — so this
  // just unlinks the reference here. The file itself stays on Cloudinary,
  // comfortably within the free tier for document-sized files.
  const updated = { ...client };
  delete updated[`${docType}DocUrl`];
  delete updated[`${docType}DocName`];
  delete updated[`${docType}DocPath`];
  updated.updatedAt = new Date().toISOString();
  await DB.put(DB.STORES.clients, updated);
  Object.assign(client, updated);
  refreshDocUi(docType, client);
  toast(`${DOC_LABELS[docType]} removed.`, "success");
}

function money(v) {
  return v || v === 0 ? "₹" + Number(v).toLocaleString("en-IN") : "—";
}

function openViewClient(id) {
  const c = allClients.find((x) => x.id === id);
  if (!c) return;
  currentViewClientId = id;

  const staffMember = allStaff.find((s) => s.id === c.assignedStaffId);

  document.getElementById("viewClientTitle").textContent = c.businessName;
  document.getElementById("vBusinessName").textContent = c.businessName || "—";
  document.getElementById("vGstin").textContent = c.gstin || "—";
  document.getElementById("vContactPerson").textContent = c.contactPerson || "—";
  document.getElementById("vContactPhone").textContent = c.contactPhone || "—";
  document.getElementById("vContactEmail").textContent = c.contactEmail || "—";
  document.getElementById("vAddress").textContent = c.address || "—";
  document.getElementById("vAssignedStaff").textContent = staffMember ? staffMember.name : "Unassigned";
  document.getElementById("vStatus").textContent = c.status || "Active";
  document.getElementById("vGstFrequency").textContent = c.gstFrequency === "Quarterly" ? "Quarterly (QRMP)" : "Monthly";
  document.getElementById("vMonthlyFee").textContent = money(c.monthlyFee);
  document.getElementById("vKycDoc").innerHTML = c.kycDocUrl
    ? `<a href="${c.kycDocUrl}" target="_blank" rel="noopener"><i class="fa-solid fa-file-arrow-down me-1"></i>${escapeHtml(c.kycDocName || "View")}</a>`
    : "—";
  document.getElementById("vItDoc").innerHTML = c.itDocUrl
    ? `<a href="${c.itDocUrl}" target="_blank" rel="noopener"><i class="fa-solid fa-file-arrow-down me-1"></i>${escapeHtml(c.itDocName || "View")}</a>`
    : "—";
  document.getElementById("vGstUsername").textContent = c.gstPortalUsername || "—";
  document.getElementById("vGstPassword").textContent = c.gstPortalPassword || "—";
  document.getElementById("vCustomerUsername").textContent = c.customerUsername || "—";
  document.getElementById("vCustomerPassword").textContent = c.customerPassword || "—";
  document.getElementById("vEwayUsername").textContent = c.ewayUsername || "—";
  document.getElementById("vEwayPassword").textContent = c.ewayPassword || "—";
  document.getElementById("vRentTaxable").textContent = money(c.rentTaxable);
  document.getElementById("vRentSgst").textContent = money(c.rentSgst);
  document.getElementById("vRentCgst").textContent = money(c.rentCgst);

  const waMsg = `Hi ${c.contactPerson || c.businessName}, this is regarding ${c.businessName}'s GST filing with us. Please let us know if you need anything.`;
  const waHref = whatsappLink(c.contactPhone, waMsg);
  const waBtn = document.getElementById("viewClientWaBtn");
  waBtn.classList.toggle("d-none", !waHref);
  if (waHref) waBtn.href = waHref;

  const modalEl = document.getElementById("viewClientModal");
  if (session.role !== "admin") {
    modalEl.querySelectorAll("[data-admin-only]").forEach((el) => (el.style.display = "none"));
  }

  viewClientModal.show();
}

function openEditClient(id) {
  const c = allClients.find((x) => x.id === id);
  if (!c) return;
  document.getElementById("clientOffcanvasTitle").textContent = "Edit Client";
  document.getElementById("clientId").value = c.id;
  document.getElementById("businessName").value = c.businessName || "";
  document.getElementById("gstin").value = c.gstin || "";
  document.getElementById("contactPerson").value = c.contactPerson || "";
  document.getElementById("contactPhone").value = c.contactPhone || "";
  document.getElementById("contactEmail").value = c.contactEmail || "";
  document.getElementById("address").value = c.address || "";
  document.getElementById("assignedStaffId").value = c.assignedStaffId || "";
  document.getElementById("clientStatus").value = c.status || "Active";
  document.getElementById("gstFrequency").value = c.gstFrequency === "Quarterly" ? "Quarterly" : "Monthly";
  document.getElementById("gstPortalUsername").value = c.gstPortalUsername || "";
  document.getElementById("gstPortalPassword").value = c.gstPortalPassword || "";
  document.getElementById("customerUsername").value = c.customerUsername || "";
  document.getElementById("customerPassword").value = c.customerPassword || "";
  document.getElementById("monthlyFee").value = c.monthlyFee ?? "";
  document.getElementById("ewayUsername").value = c.ewayUsername || "";
  document.getElementById("ewayPassword").value = c.ewayPassword || "";
  document.getElementById("rentTaxable").value = c.rentTaxable ?? "";
  document.getElementById("rentSgst").value = c.rentSgst ?? "";
  document.getElementById("rentCgst").value = c.rentCgst ?? "";
  document.getElementById("docsUploadWrap").classList.remove("d-none");
  document.getElementById("docsNewClientNote").classList.add("d-none");
  refreshDocUi("kyc", c);
  refreshDocUi("it", c);
  clientOffcanvas.show();
}

async function onSaveClient(e) {
  e.preventDefault();
  const businessName = document.getElementById("businessName").value.trim();
  const gstin = document.getElementById("gstin").value.trim().toUpperCase();

  if (!businessName) {
    toast("Business name is required.", "danger");
    return;
  }
  if (!GSTIN_RE.test(gstin)) {
    toast("Please enter a valid 15-character GSTIN (e.g. 22AAAAA0000A1Z5).", "danger");
    return;
  }
  // Uniqueness check (excluding self when editing)
  const editingId = document.getElementById("clientId").value;
  const dup = allClients.find((c) => c.gstin === gstin && c.id !== editingId);
  if (dup) {
    toast("A client with this GSTIN already exists.", "danger");
    return;
  }

  const now = new Date().toISOString();
  const record = {
    id: editingId || DB.uid("cli"),
    businessName,
    gstin,
    contactPerson: document.getElementById("contactPerson").value.trim(),
    contactPhone: document.getElementById("contactPhone").value.trim(),
    contactEmail: document.getElementById("contactEmail").value.trim(),
    address: document.getElementById("address").value.trim(),
    assignedStaffId: document.getElementById("assignedStaffId").value || null,
    status: document.getElementById("clientStatus").value,
    gstFrequency: document.getElementById("gstFrequency").value === "Quarterly" ? "Quarterly" : "Monthly",
    gstPortalUsername: document.getElementById("gstPortalUsername").value.trim(),
    gstPortalPassword: document.getElementById("gstPortalPassword").value,
    customerUsername: document.getElementById("customerUsername").value.trim(),
    customerPassword: document.getElementById("customerPassword").value,
    monthlyFee: document.getElementById("monthlyFee").value ? Number(document.getElementById("monthlyFee").value) : null,
    ewayUsername: document.getElementById("ewayUsername").value.trim(),
    ewayPassword: document.getElementById("ewayPassword").value,
    rentTaxable: document.getElementById("rentTaxable").value ? Number(document.getElementById("rentTaxable").value) : null,
    rentSgst: document.getElementById("rentSgst").value ? Number(document.getElementById("rentSgst").value) : null,
    rentCgst: document.getElementById("rentCgst").value ? Number(document.getElementById("rentCgst").value) : null,
    createdAt: editingId ? allClients.find((c) => c.id === editingId)?.createdAt || now : now,
    updatedAt: now,
  };

  await DB.put(DB.STORES.clients, record);
  await DB.logActivity(
    `${editingId ? "Updated" : "Added"} client "${businessName}"`,
    editingId ? "fa-pen" : "fa-user-plus",
    "success"
  );

  toast(`Client ${editingId ? "updated" : "added"} successfully.`, "success");
  clientOffcanvas.hide();
  await loadData();
  render();
}

async function deleteClient(id) {
  const c = allClients.find((x) => x.id === id);
  if (!c) return;
  if (!confirm(`Delete client "${c.businessName}"? This cannot be undone.`)) return;

  await DB.delete(DB.STORES.clients, id);
  await DB.logActivity(`Deleted client "${c.businessName}"`, "fa-trash", "danger");
  toast("Client deleted.", "success");
  await loadData();
  render();
}

function openCreds(id) {
  const c = allClients.find((x) => x.id === id);
  if (!c) return;
  document.getElementById("credsClientId").value = c.id;
  document.getElementById("credsClientLabel").textContent = `${c.businessName} · ${c.gstin}`;
  document.getElementById("credsGstUsername").value = c.gstPortalUsername || "";
  document.getElementById("credsGstPassword").value = c.gstPortalPassword || "";
  document.getElementById("credsCustomerPassword").value = c.customerPassword || "";
  document.getElementById("credsEwayUsername").value = c.ewayUsername || "";
  document.getElementById("credsEwayPassword").value = c.ewayPassword || "";
  credsOffcanvas.show();
}

async function onSaveCreds(e) {
  e.preventDefault();
  const id = document.getElementById("credsClientId").value;
  const c = allClients.find((x) => x.id === id);
  if (!c) return;

  c.gstPortalUsername = document.getElementById("credsGstUsername").value.trim();
  c.gstPortalPassword = document.getElementById("credsGstPassword").value;
  c.customerPassword = document.getElementById("credsCustomerPassword").value;
  c.ewayUsername = document.getElementById("credsEwayUsername").value.trim();
  c.ewayPassword = document.getElementById("credsEwayPassword").value;
  c.updatedAt = new Date().toISOString();

  await DB.put(DB.STORES.clients, c);
  await DB.logActivity(`Updated portal/login credentials for "${c.businessName}"`, "fa-key", "info");
  toast("Credentials updated.", "success");
  credsOffcanvas.hide();
  await loadData();
  render();
}

document.addEventListener("DOMContentLoaded", init);
