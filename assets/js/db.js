/**
 * GST MASTER — Firestore Data Layer
 * Same public shape as the original IndexedDB version (add/put/get/
 * getAll/getByIndex/delete/count/clearAll/exportAll/importAll/
 * logActivity) so auth.js, chrome.js, dashboard.js, clients.js and the
 * new staff.js / payments.js don't need to change how they call DB.
 * Under the hood, every store is now a Firestore collection.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
  query,
  where,
  writeBatch,
  getCountFromServer,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db as firestore, firebaseReady } from "./firebase.js";

const DB_VERSION = 2; // bumped: v1 was IndexedDB, v2 is Firestore

const STORES = {
  users: "users",           // login accounts: admin / staff / customer
  clients: "clients",       // GST client master records
  staff: "staff",           // staff master records
  gstRecords: "gstRecords", // GSTR-1 / GSTR-3B filing status per client/period
  gstr1Sales: "gstr1Sales", // GSTR-1 Excel Builder — saved monthly sales data per client/period
  payments: "payments",     // payment records per client
  activity: "activity",     // recent activity feed
  settings: "settings",     // app-level settings (company name, logo, etc.)
  leads: "leads",           // "New Customer" sign-up requests from the home page banner
};

function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Indian financial year label for a given date, e.g. "2025-26" (Apr–Mar). */
function currentFinancialYear(d = new Date()) {
  const startYear = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`;
}

async function ready() {
  await firebaseReady;
  return firestore;
}

const DB = {
  STORES,
  uid,

  async add(storeName, value) {
    return this.put(storeName, value);
  },

  async put(storeName, value) {
    const fs = await ready();
    const key = value.id || value.key || uid();
    await setDoc(doc(fs, storeName, key), value);
    return key;
  },

  async get(storeName, key) {
    const fs = await ready();
    const snap = await getDoc(doc(fs, storeName, key));
    return snap.exists() ? snap.data() : undefined;
  },

  async getAll(storeName) {
    const fs = await ready();
    const snap = await getDocs(collection(fs, storeName));
    return snap.docs.map((d) => d.data());
  },

  async getByIndex(storeName, indexName, value) {
    const fs = await ready();
    const q = query(collection(fs, storeName), where(indexName, "==", value));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data());
  },

  async delete(storeName, key) {
    const fs = await ready();
    await deleteDoc(doc(fs, storeName, key));
  },

  async count(storeName) {
    const fs = await ready();
    const snap = await getCountFromServer(collection(fs, storeName));
    return snap.data().count;
  },

  async clearAll() {
    const fs = await ready();
    for (const name of Object.values(STORES)) {
      const snap = await getDocs(collection(fs, name));
      if (snap.empty) continue;
      const batch = writeBatch(fs);
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    return true;
  },

  /** Full DB export for the Backup feature. */
  async exportAll() {
    const out = {};
    for (const name of Object.values(STORES)) {
      out[name] = await this.getAll(name);
    }
    return { exportedAt: new Date().toISOString(), version: DB_VERSION, data: out };
  },

  /** Restore from a JSON backup produced by exportAll(). */
  async importAll(payload) {
    if (!payload || !payload.data) throw new Error("Invalid backup file");
    const fs = await ready();
    for (const [name, records] of Object.entries(payload.data)) {
      if (!Object.values(STORES).includes(name)) continue;
      const batch = writeBatch(fs);
      records.forEach((record) => {
        const key = record.id || record.key || uid();
        batch.set(doc(fs, name, key), record);
      });
      await batch.commit();
    }
    return true;
  },

  /** App-level settings live in a single "company" doc in the settings store. */
  async getSettings() {
    const existing = await this.get(STORES.settings, "company");
    const defaults = {
      key: "company",
      companyName: "Friends Tax",
      tagline: "GST Consulting Office Management System",
      companyAddress: "",
      companyGstin: "",
      companyState: "",
      companyPhone: "",
      companyEmail: "",
      payeeVpa: "punithan.m.8-1@okhdfcbank",
      payeeName: "Friends Tax",
      invoicePrefix: "INV",
      invoiceFY: currentFinancialYear(),
      invoiceSeq: 0, // last used sequence number; next invoice = invoiceSeq + 1
      sacCode: "",
      gstEnabled: false,
      gstRate: 18,
      gstType: "CGST_SGST", // "CGST_SGST" (intra-state) or "IGST" (inter-state)
      bankName: "",
      bankAccountName: "",
      bankAccountNo: "",
      bankIfsc: "",
      bankBranch: "",
      signatoryName: "",
    };
    // Merge so older settings docs (saved before invoice numbering existed)
    // still get sensible defaults for the new fields instead of undefined.
    return existing ? { ...defaults, ...existing } : defaults;
  },

  async saveSettings(patch) {
    const current = await this.getSettings();
    const merged = { ...current, ...patch, key: "company" };
    await this.put(STORES.settings, merged);
    return merged;
  },

  /**
   * Returns the next invoice number as a fixed, persisted string
   * (e.g. "INV/2026-27/001") and advances the counter in settings.
   * If the financial year has rolled over since the counter was last
   * saved, the sequence automatically restarts at 001 for the new
   * year — no manual reset needed each April.
   * Best-effort (not a Firestore transaction) — fine for the low-
   * concurrency, single-office usage this app targets.
   */
  async getNextInvoiceNumber() {
    const settings = await this.getSettings();
    const prefix = settings.invoicePrefix || "INV";
    const liveFY = currentFinancialYear();
    const rolledOver = settings.invoiceFY && settings.invoiceFY !== liveFY;
    const fy = rolledOver ? liveFY : settings.invoiceFY || liveFY;
    const nextSeq = rolledOver ? 1 : (settings.invoiceSeq || 0) + 1;
    await this.saveSettings({ invoiceSeq: nextSeq, invoiceFY: fy });
    return `${prefix}/${fy}/${String(nextSeq).padStart(3, "0")}`;
  },

  async logActivity(text, icon = "fa-circle-info", type = "info") {
    return this.add(STORES.activity, {
      id: uid("act"),
      text,
      icon,
      type,
      at: new Date().toISOString(),
    });
  },
};

/**
 * Seeds the database on first-ever run: one default admin account and
 * app settings. Safe to call every load — it checks before writing.
 */
export async function seedIfEmpty() {
  const userCount = await DB.count(STORES.users);
  if (userCount > 0) return;

  await DB.put(STORES.users, {
    id: uid("usr"),
    username: "admin",
    // Demo-only credential store (plain text). See README security notes
    // before using this for anything beyond a local demo.
    password: "admin123",
    role: "admin",
    name: "System Administrator",
    createdAt: new Date().toISOString(),
  });

  await DB.put(STORES.settings, {
    key: "company",
    companyName: "Friends Tax",
    tagline: "GST Consulting Office Management System",
    payeeVpa: "punithan.m.8-1@okhdfcbank",
    payeeName: "Friends Tax",
    invoicePrefix: "INV",
    invoiceFY: currentFinancialYear(),
    invoiceSeq: 0,
  });

  await DB.logActivity("Default admin account created", "fa-user-shield", "info");
}

export default DB;
