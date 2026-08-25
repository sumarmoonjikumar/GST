import { seedIfEmpty } from "./db.js";
import { login } from "./auth.js";
import { applyStoredTheme, toggleTheme, toast, currentSession } from "./utils.js";
import { openForgotPasswordFlow } from "./customer-otp.js";

applyStoredTheme();

const roleMeta = {
  admin: { label: "Admin Login", idLabel: "Admin Username" },
  staff: { label: "Staff Login", idLabel: "Staff Username" },
  customer: { label: "Customer Login", idLabel: "Registered Mobile Number" },
};

const DASHBOARD_BY_ROLE = {
  admin: "dashboard.html",
  staff: "dashboard.html",
  customer: "customer-dashboard.html",
};

let activeRole = "admin";

function init() {
  seedIfEmpty();

  // If already logged in, skip straight to the right dashboard for the role.
  const session = currentSession();
  if (session) {
    window.location.href = DASHBOARD_BY_ROLE[session.role] || "dashboard.html";
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
    if (activeRole === "customer") {
      openForgotPasswordFlow();
      return;
    }
    toast(
      activeRole === "admin"
        ? "Admin password reset must be done via Settings → Backup on another admin device, or by restoring a backup."
        : "Please contact your GST Master office admin to reset this password.",
      "info"
    );
  });

  selectRole("admin");
}

function selectRole(role) {
  activeRole = role;
  document.querySelectorAll(".role-card").forEach((c) => {
    const isActive = c.dataset.role === role;
    c.classList.toggle("active", isActive);
    c.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  const meta = roleMeta[role];
  document.getElementById("activeRoleLabel").textContent = meta.label;
  document.getElementById("usernameLabel").textContent = meta.idLabel;
  const usernameInput = document.getElementById("loginUsername");
  usernameInput.placeholder = role === "customer" ? "10-digit mobile number" : "Username";
  usernameInput.setAttribute("inputmode", role === "customer" ? "numeric" : "text");
  usernameInput.focus({ preventScroll: true });
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
  const dest = DASHBOARD_BY_ROLE[result.session.role] || "dashboard.html";
  setTimeout(() => (window.location.href = dest), 400);
}

function updateThemeIcon(theme) {
  const icon = document.querySelector("#themeToggleBtn i");
  if (!icon) return;
  icon.className = theme === "dark" ? "fa-solid fa-sun" : "fa-solid fa-moon";
}

document.addEventListener("DOMContentLoaded", init);
