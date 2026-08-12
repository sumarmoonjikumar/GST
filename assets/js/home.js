import { seedIfEmpty } from "./db.js";
import DB from "./db.js";
import { login } from "./auth.js";
import { applyStoredTheme, toggleTheme, toast, currentSession } from "./utils.js";
import { cloudinaryConfig } from "./cloudinary-config.js";

applyStoredTheme();

const roleMeta = {
  admin: { label: "Admin Login", idLabel: "Admin Username", desc: "Full control over clients, staff &amp; settings" },
  staff: { label: "Staff Login", idLabel: "Staff Username", desc: "Manage your assigned clients' filings" },
};

let activeRole = "admin";
let newCustomerModal = null;
let selectedKycFile = null;

function init() {
  seedIfEmpty();

  // If already logged in, skip straight to the dashboard.
  const session = currentSession();
  if (session) {
    window.location.href = "dashboard.html";
    return;
  }

  document.querySelectorAll(".role-card").forEach((card) => {
    card.addEventListener("click", () => selectRole(card.dataset.role));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectRole(card.dataset.role);
      }
    });
  });

  document.getElementById("themeToggleBtn")?.addEventListener("click", () => {
    const next = toggleTheme();
    updateThemeIcon(next);
  });
  updateThemeIcon(document.documentElement.getAttribute("data-theme"));

  document.getElementById("loginForm").addEventListener("submit", onSubmit);

  document.getElementById("forgotPasswordLink")?.addEventListener("click", (e) => {
    e.preventDefault();
    toast(
      activeRole === "admin"
        ? "Admin password reset must be done via Settings → Backup on another admin device, or by restoring a backup."
        : "Please contact your GST Master office admin to reset this password.",
      "info"
    );
  });

  selectRole("admin");
  initNewCustomerModal();
}

function selectRole(role) {
  if (!roleMeta[role]) return;
  activeRole = role;
  document.querySelectorAll(".role-card").forEach((c) => {
    const isActive = c.dataset.role === role;
    c.classList.toggle("active", isActive);
    c.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  const meta = roleMeta[role];
  document.getElementById("activeRoleLabel").textContent = meta.label;
  document.getElementById("usernameLabel").textContent = meta.idLabel;
  document.getElementById("roleDesc").innerHTML = meta.desc;
  document.getElementById("loginUsername").focus({ preventScroll: true });
}

async function onSubmit(e) {
  e.preventDefault();
  const username = document.getElementById("loginUsername").value;
  const password = document.getElementById("loginPassword").value;
  const remember = document.getElementById("rememberMe").checked;
  const btn = document.getElementById("loginSubmitBtn");

  if (!username || !password) {
    toast("Please enter both username and password.", "danger");
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Signing in…';

  const result = await login(activeRole, username, password, remember);

  if (!result.ok) {
    toast(result.error, "danger");
    btn.disabled = false;
    btn.innerHTML = "Sign In";
    return;
  }

  toast(`Welcome back, ${result.session.name}.`, "success");
  setTimeout(() => (window.location.href = "dashboard.html"), 400);
}

function updateThemeIcon(theme) {
  const icon = document.querySelector("#themeToggleBtn i");
  if (!icon) return;
  icon.className = theme === "dark" ? "fa-solid fa-sun" : "fa-solid fa-moon";
}

/* ---------------- New Customer registration ---------------- */

function initNewCustomerModal() {
  const modalEl = document.getElementById("newCustomerModal");
  if (!modalEl) return;
  newCustomerModal = new bootstrap.Modal(modalEl);

  document.getElementById("newCustomerBtn")?.addEventListener("click", () => {
    document.getElementById("newCustomerForm").reset();
    selectedKycFile = null;
    document.getElementById("ncKycFileInfo").textContent = "No file selected";
    newCustomerModal.show();
  });

  document.getElementById("ncKycFileBtn")?.addEventListener("click", () => {
    document.getElementById("ncKycFile").click();
  });

  document.getElementById("ncKycFile")?.addEventListener("change", (e) => {
    const file = e.target.files[0];
    selectedKycFile = file || null;
    document.getElementById("ncKycFileInfo").textContent = file ? file.name : "No file selected";
  });

  document.getElementById("newCustomerForm")?.addEventListener("submit", onNewCustomerSubmit);
}

async function onNewCustomerSubmit(e) {
  e.preventDefault();

  const name = document.getElementById("ncName").value.trim();
  const mobile = document.getElementById("ncMobile").value.trim();
  const email = document.getElementById("ncEmail").value.trim();
  const kycType = document.getElementById("ncKycType").value;

  if (!name || !mobile || !email || !kycType) {
    toast("Please fill in all the required fields.", "danger");
    return;
  }
  if (!/^[0-9]{10}$/.test(mobile)) {
    toast("Please enter a valid 10-digit mobile number.", "danger");
    return;
  }

  const btn = document.getElementById("ncSubmitBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Submitting…';

  try {
    let kycDocUrl = "";
    let kycDocName = "";

    if (selectedKycFile) {
      try {
        const uploaded = await uploadToCloudinary(selectedKycFile);
        kycDocUrl = uploaded.url;
        kycDocName = selectedKycFile.name;
      } catch (err) {
        if (err.message !== "CLOUDINARY_NOT_CONFIGURED") throw err;
        // Document storage isn't set up yet — still capture the lead itself.
        toast("Details submitted, but document storage isn't configured yet — our team will collect the document separately.", "info");
      }
    }

    await DB.add(DB.STORES.leads, {
      name,
      mobile,
      email,
      kycType,
      kycDocUrl,
      kycDocName,
      status: "new",
      source: "home-page",
      createdAt: new Date().toISOString(),
    });

    toast("Thanks! Your details have been submitted — our team will reach out shortly.", "success");
    document.getElementById("newCustomerForm").reset();
    selectedKycFile = null;
    document.getElementById("ncKycFileInfo").textContent = "No file selected";
    newCustomerModal.hide();
  } catch (err) {
    console.error(err);
    toast("Something went wrong while submitting. Please try again.", "danger");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Submit Registration";
  }
}

/** Uploads a file to Cloudinary's unsigned endpoint and resolves with the
 *  hosted file's URL. See cloudinary-config.js for one-time setup. */
async function uploadToCloudinary(file) {
  if (cloudinaryConfig.cloudName === "YOUR_CLOUD_NAME" || cloudinaryConfig.uploadPreset === "YOUR_UNSIGNED_UPLOAD_PRESET") {
    throw new Error("CLOUDINARY_NOT_CONFIGURED");
  }
  const form = new FormData();
  form.append("file", file);
  form.append("upload_preset", cloudinaryConfig.uploadPreset);
  form.append("folder", "leads");

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/auto/upload`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.secure_url) {
    throw new Error(data?.error?.message || "Upload failed");
  }
  return { url: data.secure_url };
}

document.addEventListener("DOMContentLoaded", init);
