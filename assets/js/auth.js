/**
 * GST MASTER — Auth Module
 * Validates credentials against IndexedDB and stores a session token
 * in sessionStorage (or localStorage when "remember me" is checked).
 * Everything is local — there is no server round-trip.
 */

import DB from "./db.js";

/**
 * @param {"admin"|"staff"|"customer"} role
 * @param {string} username
 * @param {string} password
 * @param {boolean} remember
 */
export async function login(role, username, password, remember) {
  const matches = await DB.getByIndex(DB.STORES.users, "username", username.trim().toLowerCase());
  const user = matches.find((u) => u.role === role);

  if (!user || user.password !== password) {
    return { ok: false, error: "Invalid username or password for this login type." };
  }

  // For a staff login, every client's `assignedStaffId` points at the
  // STAFF collection's doc id (e.g. "stf_..."), not this login/users doc's
  // own id (e.g. "usr_..."). session.id needs to be the staff doc's id so
  // the "assignedStaffId === session.id" checks across the app actually
  // match. session.userId keeps the login doc's own id around in case
  // anything needs to look that up later (e.g. changing a password).
  const session = {
    id: role === "staff" && user.staffId ? user.staffId : user.id,
    userId: user.id,
    username: user.username,
    role: user.role,
    name: user.name || user.username,
    clientId: user.clientId || null, // for customer logins
    loginAt: new Date().toISOString(),
  };

  // Always keep a copy in both storages. sessionStorage is per-tab, so a
  // link opened in a new tab (e.g. the invoice page from Payments) can
  // otherwise land with no session and get bounced straight to login —
  // which looks like an unexpected logout. Mirroring into localStorage
  // too means any new tab still finds a valid session.
  sessionStorage.setItem("gstm_session", JSON.stringify(session));
  localStorage.setItem("gstm_session", JSON.stringify(session));

  await DB.logActivity(`${session.name} (${role}) logged in`, "fa-right-to-bracket", "info");

  return { ok: true, session };
}

export function requireSession(allowedRoles = null) {
  let session = null;
  try {
    session = JSON.parse(sessionStorage.getItem("gstm_session") || localStorage.getItem("gstm_session") || "null");
  } catch {
    session = null;
  }

  if (!session) {
    window.location.href = "index.html";
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(session.role)) {
    window.location.href = "index.html";
    return null;
  }
  return session;
}

export async function logout() {
  const sessionRaw = sessionStorage.getItem("gstm_session") || localStorage.getItem("gstm_session");
  sessionStorage.removeItem("gstm_session");
  localStorage.removeItem("gstm_session");
  if (sessionRaw) {
    try {
      const s = JSON.parse(sessionRaw);
      await DB.logActivity(`${s.name} logged out`, "fa-right-from-bracket", "warning");
    } catch { /* noop */ }
  }
  window.location.href = "index.html";
}
