import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, toast, initials, formatDate } from "./utils.js";
import { initAppChrome } from "./chrome.js";

applyStoredTheme();
const session = requireSession(["admin"]); // staff master is admin-only

let allStaff = [];
let allUsers = [];
let allClients = [];
let staffOffcanvas;

async function init() {
  if (!session) return;
  initAppChrome(session);

  staffOffcanvas = new bootstrap.Offcanvas(document.getElementById("staffOffcanvas"));

  await loadData();
  render();
  wireEvents();
}

async function loadData() {
  const [staff, users, clients] = await Promise.all([
    DB.getAll(DB.STORES.staff),
    DB.getAll(DB.STORES.users),
    DB.getAll(DB.STORES.clients),
  ]);
  allStaff = staff;
  allUsers = users;
  allClients = clients;
}

function applyFilters(list) {
  const q = document.getElementById("staffSearch").value.trim().toLowerCase();
  const status = document.getElementById("staffStatusFilter").value;

  return list.filter((s) => {
    if (q && !(`${s.name} ${s.username} ${s.email || ""}`.toLowerCase().includes(q))) return false;
    if (status && s.status !== status) return false;
    return true;
  });
}

function render() {
  const list = applyFilters(allStaff);
  const tbody = document.getElementById("staffTableBody");
  const emptyState = document.getElementById("staffEmptyState");
  const countLabel = document.getElementById("staffCountLabel");

  countLabel.textContent = `${list.length} staff${list.length === 1 ? "" : ""}`;

  if (list.length === 0) {
    tbody.innerHTML = "";
    emptyState.classList.remove("d-none");
    return;
  }
  emptyState.classList.add("d-none");

  tbody.innerHTML = list
    .map((s) => {
      const assignedClients = allClients.filter((c) => c.assignedStaffId === s.id);
      const clientCount = assignedClients.length;
      const clientChips = assignedClients.length
        ? assignedClients
            .map((c) => `<span class="badge badge-soft-info rounded-pill me-1 mb-1">${escapeHtml(c.businessName)}</span>`)
            .join("")
        : `<span class="cell-sub">No clients assigned</span>`;
      const statusBadge =
        s.status === "Inactive"
          ? `<span class="badge badge-soft-danger rounded-pill">Inactive</span>`
          : `<span class="badge badge-soft-success rounded-pill">Active</span>`;

      return `
      <tr>
        <td>
          <div class="d-flex align-items-center gap-2">
            <span class="avatar-chip">${initials(s.name) || "ST"}</span>
            <div>
              <div class="cell-primary">${escapeHtml(s.name)}</div>
              <div class="cell-sub">Joined ${s.joiningDate ? formatDate(s.joiningDate) : "—"}</div>
            </div>
          </div>
        </td>
        <td class="font-mono">${escapeHtml(s.username)}</td>
        <td>
          <div>${escapeHtml(s.phone || "—")}</div>
          <div class="cell-sub">${escapeHtml(s.email || "")}</div>
        </td>
        <td>
          <div class="mb-1 small text-muted-soft">${clientCount} client${clientCount === 1 ? "" : "s"}</div>
          <div>${clientChips}</div>
        </td>
        <td>${statusBadge}</td>
        <td class="text-end">
          <div class="row-actions">
            <button class="btn btn-outline-secondary btn-sm" data-edit="${s.id}" title="Edit"><i class="fa-solid fa-pen"></i></button>
            <button class="btn btn-outline-danger btn-sm" data-delete="${s.id}" title="Delete"><i class="fa-solid fa-trash"></i></button>
          </div>
        </td>
      </tr>`;
    })
    .join("");

  tbody.querySelectorAll("[data-edit]").forEach((btn) =>
    btn.addEventListener("click", () => openEditStaff(btn.dataset.edit))
  );
  tbody.querySelectorAll("[data-delete]").forEach((btn) =>
    btn.addEventListener("click", () => deleteStaff(btn.dataset.delete))
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
  document.getElementById("staffSearch").addEventListener("input", render);
  document.getElementById("staffStatusFilter").addEventListener("change", render);

  document.getElementById("addStaffBtn").addEventListener("click", () => {
    document.getElementById("staffForm").reset();
    document.getElementById("staffId").value = "";
    document.getElementById("staffUserId").value = "";
    document.getElementById("staffOffcanvasTitle").textContent = "Add Staff";
    document.getElementById("staffPasswordOptionalHint").classList.add("d-none");
    document.getElementById("staffPassword").required = true;
    document.getElementById("staffStatus").value = "Active";
    staffOffcanvas.show();
  });

  document.getElementById("staffForm").addEventListener("submit", onSaveStaff);
}

function openEditStaff(id) {
  const s = allStaff.find((x) => x.id === id);
  if (!s) return;
  document.getElementById("staffOffcanvasTitle").textContent = "Edit Staff";
  document.getElementById("staffId").value = s.id;
  document.getElementById("staffUserId").value = s.userId || "";
  document.getElementById("staffName").value = s.name || "";
  document.getElementById("staffPhone").value = s.phone || "";
  document.getElementById("staffEmail").value = s.email || "";
  document.getElementById("staffJoiningDate").value = s.joiningDate || "";
  document.getElementById("staffStatus").value = s.status || "Active";
  document.getElementById("staffUsername").value = s.username || "";
  document.getElementById("staffPassword").value = "";
  document.getElementById("staffPassword").required = false;
  document.getElementById("staffPasswordOptionalHint").classList.remove("d-none");
  staffOffcanvas.show();
}

async function onSaveStaff(e) {
  e.preventDefault();
  const name = document.getElementById("staffName").value.trim();
  const username = document.getElementById("staffUsername").value.trim().toLowerCase();
  const password = document.getElementById("staffPassword").value;
  const editingId = document.getElementById("staffId").value;

  if (!name) {
    toast("Full name is required.", "danger");
    return;
  }
  if (!username) {
    toast("Login username is required.", "danger");
    return;
  }
  if (!editingId && !password) {
    toast("A password is required for a new staff login.", "danger");
    return;
  }

  // Username must be unique across ALL login accounts (admin/staff/customer), not just staff.
  const dupUser = allUsers.find(
    (u) => u.username === username && u.id !== document.getElementById("staffUserId").value
  );
  if (dupUser) {
    toast("This username is already in use by another login.", "danger");
    return;
  }

  const now = new Date().toISOString();
  const existingStaff = editingId ? allStaff.find((s) => s.id === editingId) : null;
  const staffId = editingId || DB.uid("stf");
  let userId = document.getElementById("staffUserId").value || DB.uid("usr");

  const staffRecord = {
    id: staffId,
    name,
    phone: document.getElementById("staffPhone").value.trim(),
    email: document.getElementById("staffEmail").value.trim(),
    joiningDate: document.getElementById("staffJoiningDate").value || null,
    status: document.getElementById("staffStatus").value,
    username,
    userId,
    createdAt: existingStaff?.createdAt || now,
    updatedAt: now,
  };

  const existingUser = allUsers.find((u) => u.id === userId);
  const userRecord = {
    id: userId,
    username,
    password: password || existingUser?.password || "",
    role: "staff",
    name,
    staffId,
    createdAt: existingUser?.createdAt || now,
  };

  await DB.put(DB.STORES.staff, staffRecord);
  await DB.put(DB.STORES.users, userRecord);
  await DB.logActivity(
    `${editingId ? "Updated" : "Added"} staff member "${name}"`,
    editingId ? "fa-pen" : "fa-user-tie",
    "success"
  );

  toast(`Staff ${editingId ? "updated" : "added"} successfully.`, "success");
  staffOffcanvas.hide();
  await loadData();
  render();
}

async function deleteStaff(id) {
  const s = allStaff.find((x) => x.id === id);
  if (!s) return;

  const assignedCount = allClients.filter((c) => c.assignedStaffId === id).length;
  const warning = assignedCount > 0
    ? ` They are currently assigned to ${assignedCount} client${assignedCount === 1 ? "" : "s"}, which will become unassigned.`
    : "";
  if (!confirm(`Delete staff member "${s.name}"? This also removes their login.${warning}`)) return;

  // Unassign any clients pointed at this staff member.
  const assignedClients = allClients.filter((c) => c.assignedStaffId === id);
  for (const c of assignedClients) {
    await DB.put(DB.STORES.clients, { ...c, assignedStaffId: null, updatedAt: new Date().toISOString() });
  }

  await DB.delete(DB.STORES.staff, id);
  if (s.userId) await DB.delete(DB.STORES.users, s.userId);

  await DB.logActivity(`Deleted staff member "${s.name}"`, "fa-trash", "danger");
  toast("Staff member deleted.", "success");
  await loadData();
  render();
}

document.addEventListener("DOMContentLoaded", init);
