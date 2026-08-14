import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, toast, confirmAdminDelete } from "./utils.js";
import { initAppChrome } from "./chrome.js";

applyStoredTheme();
const session = requireSession(["admin"]);

let pendingFile = null;

async function init() {
  if (!session) return;
  initAppChrome(session);
  await renderCounts();
  wireEvents();
}

async function renderCounts() {
  const el = document.getElementById("dataCounts");
  const counts = await Promise.all(
    Object.values(DB.STORES).map(async (store) => [store, await DB.count(store)])
  );
  el.textContent = counts.map(([store, n]) => `${store}: ${n}`).join(" · ");
}

function wireEvents() {
  document.getElementById("exportBtn").addEventListener("click", onExport);
  document.getElementById("restoreFile").addEventListener("change", (e) => {
    pendingFile = e.target.files[0] || null;
    document.getElementById("restoreBtn").disabled = !pendingFile;
  });
  document.getElementById("restoreBtn").addEventListener("click", onRestore);
  document.getElementById("clearBtn").addEventListener("click", onClearAll);
}

async function onExport() {
  const payload = await DB.exportAll();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `gst-master-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  await DB.logActivity("Downloaded a full data backup", "fa-download", "info");
  toast("Backup downloaded.", "success");
}

async function onRestore() {
  if (!pendingFile) return;
  if (!confirm("Restore from this backup? Records with matching IDs will be overwritten.")) return;

  try {
    const text = await pendingFile.text();
    const payload = JSON.parse(text);
    await DB.importAll(payload);
    await DB.logActivity("Restored data from a backup file", "fa-upload", "warning");
    toast("Backup restored successfully.", "success");
    await renderCounts();
  } catch (err) {
    toast(`Restore failed: ${err.message || "invalid backup file"}`, "danger");
  }
}

async function onClearAll() {
  const ok = await confirmAdminDelete("This will PERMANENTLY delete ALL data (clients, staff, payments, filings, settings) — this full wipe skips Trash entirely and cannot be undone.");
  if (!ok) return;

  await DB.clearAll();
  toast("All data cleared.", "success");
  await renderCounts();
}

document.addEventListener("DOMContentLoaded", init);
