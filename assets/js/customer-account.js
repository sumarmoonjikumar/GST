/**
 * GST MASTER — Customer Login Account Helpers
 * The Customer Login username is always the client's registered mobile
 * number (10 digits, no country code) — never a free-typed username.
 * These helpers keep the `users` collection (role: "customer") in sync
 * with each client's `contactPhone` + `customerPassword` fields
 * whenever a client is saved from Client Master.
 */
import DB from "./db.js";

/** Strips everything but digits and returns the last 10 (Indian mobile length). Empty string if unusable. */
export function normalizeMobile(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10) return "";
  return digits.slice(-10);
}

/** Random 8-character password: upper/lower/digits, always includes at least one of each. */
export function generatePassword(length = 8) {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O — avoids look-alike confusion
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789"; // no 0/1 — avoids look-alike confusion
  const all = upper + lower + digits;
  const pick = (set) => set[Math.floor(Math.random() * set.length)];
  let pass = pick(upper) + pick(lower) + pick(digits);
  while (pass.length < length) pass += pick(all);
  // Shuffle so the fixed upper/lower/digit prefix isn't predictable.
  return pass
    .split("")
    .sort(() => Math.random() - 0.5)
    .join("");
}

/**
 * Upserts the Customer Login account for a client, keyed on the client's
 * own id (so re-saving a client always updates the SAME login doc rather
 * than creating duplicates). Only creates/updates the login when both a
 * usable mobile number AND a password are present — otherwise leaves
 * whatever login state already existed untouched (a blank password
 * field on the client form is treated as "don't change it", not as
 * "clear it", so re-opening a client without retyping the password
 * doesn't lock them out).
 *
 * Returns { ok: true, mobile } on a synced login, or { ok: false, reason }
 * when nothing could be synced (no valid mobile, or no password yet).
 */
export async function syncCustomerLogin(client) {
  const mobile = normalizeMobile(client.contactPhone);
  if (!mobile) return { ok: false, reason: "no-mobile" };
  if (!client.customerPassword) return { ok: false, reason: "no-password" };

  const loginId = `usr_cust_${client.id}`;
  const existing = await DB.get(DB.STORES.users, loginId);

  await DB.put(DB.STORES.users, {
    id: loginId,
    username: mobile,
    password: client.customerPassword,
    role: "customer",
    name: client.contactPerson || client.businessName,
    clientId: client.id,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  return { ok: true, mobile };
}
