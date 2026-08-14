/**
 * GST MASTER — Shared App Chrome
 * Wires the sidebar / topbar behaviour common to every authenticated
 * page: user info, role-based nav visibility, theme toggle, mobile
 * sidebar drawer, logout. Import once per page after requireSession().
 */

import { logout } from "./auth.js";
import { toggleTheme, initials } from "./utils.js";
import DB from "./db.js";

export function initAppChrome(session) {
  if (!session) return;

  // Best-effort, non-blocking: permanently clear anything that's been
  // sitting in Trash past its 30-day hold. Cheap no-op most loads.
  DB.purgeExpiredTrash().catch(() => {});

  const nameEl = document.getElementById("sidebarUserName");
  const roleEl = document.getElementById("sidebarUserRole");
  const avatarEl = document.getElementById("sidebarUserAvatar");
  const welcomeEl = document.getElementById("topbarWelcome");

  if (nameEl) nameEl.textContent = session.name;
  if (roleEl) roleEl.textContent = session.role.charAt(0).toUpperCase() + session.role.slice(1);
  if (avatarEl) avatarEl.textContent = initials(session.name) || "GM";
  if (welcomeEl) welcomeEl.textContent = `Welcome, ${session.name.split(" ")[0]}`;

  if (session.role !== "admin") {
    document.querySelectorAll("[data-admin-only]").forEach((el) => el.remove());
  }
  if (session.role === "customer") {
    document.querySelectorAll("[data-staff-plus]").forEach((el) => el.remove());
  }
  if (session.role !== "staff") {
    document.querySelectorAll("[data-staff-only]").forEach((el) => el.remove());
  }

  document.getElementById("logoutBtn")?.addEventListener("click", (e) => {
    e.preventDefault();
    logout();
  });

  document.getElementById("themeToggleBtn")?.addEventListener("click", () => {
    const next = toggleTheme();
    const icon = document.querySelector("#themeToggleBtn i");
    if (icon) icon.className = next === "dark" ? "fa-solid fa-sun" : "fa-solid fa-moon";
  });

  const sidebar = document.getElementById("appSidebar");
  const backdrop = document.getElementById("sidebarBackdrop");
  document.getElementById("sidebarBurger")?.addEventListener("click", () => {
    sidebar?.classList.add("open");
    backdrop?.classList.add("show");
  });
  backdrop?.addEventListener("click", () => {
    sidebar?.classList.remove("open");
    backdrop?.classList.remove("show");
  });

  // Highlight the current page's nav link.
  const here = window.location.pathname.split("/").pop() || "dashboard.html";
  document.querySelectorAll(".sidebar-nav .nav-link").forEach((link) => {
    const href = link.getAttribute("href");
    link.classList.toggle("active", href === here);
  });
}
