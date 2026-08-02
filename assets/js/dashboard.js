import DB from "./db.js";
import { requireSession } from "./auth.js";
import { applyStoredTheme, currentFY, fyMonths, formatCurrency } from "./utils.js";
import { initAppChrome } from "./chrome.js";
import { buildFilingMap, getFilingStatus, periodHasStarted } from "./gst-status.js";

applyStoredTheme();
const session = requireSession(); // any role may view; content narrows per role below

let filingTally = { filed: 0, pending: 0, overdue: 0 };
let cachedClients = [];
let cachedPayments = [];

let filingChart, trendChart, targetAchievedChart;

async function init() {
  if (!session) return;

  initAppChrome(session);
  initCharts();
  await renderStats();

  document.getElementById("achievementMonthFilter")?.addEventListener("change", (e) => {
    renderTargetAchieved(cachedClients, cachedPayments, e.target.value);
  });
}

function visibleClients(allClients) {
  return session.role === "staff" ? allClients.filter((c) => c.assignedStaffId === session.id) : allClients;
}

async function renderStats() {
  const [clients, gstRecords, payments, staff] = await Promise.all([
    DB.getAll(DB.STORES.clients),
    DB.getAll(DB.STORES.gstRecords),
    DB.getAll(DB.STORES.payments),
    DB.getAll(DB.STORES.staff),
  ]);

  const scopedClients = visibleClients(clients);
  const filingMap = buildFilingMap(gstRecords);
  const months = fyMonths(currentFY());
  const today = new Date().toISOString().slice(0, 10);

  let gstr1Pending = 0, gstr3bPending = 0, filed = 0, overdue = 0, todaysDue = 0;

  scopedClients.forEach((c) => {
    months.forEach((m) => {
      if (!periodHasStarted(m.month, m.year)) return;
      ["GSTR-1", "GSTR-3B"].forEach((type) => {
        const rec = getFilingStatus(filingMap, c.id, m.key, type);
        if (rec.status === "Filed") {
          filed++;
        } else {
          if (type === "GSTR-1") gstr1Pending++;
          else gstr3bPending++;
          if (rec.dueDate && rec.dueDate < today) overdue++;
          if (rec.dueDate === today) todaysDue++;
        }
      });
    });
  });

  const scopedClientIds = new Set(scopedClients.map((c) => c.id));
  const scopedPayments = payments.filter((p) => scopedClientIds.has(p.clientId));
  const paymentsPending = scopedPayments.filter((p) => p.status !== "Paid").length;

  filingTally = { filed, pending: gstr1Pending + gstr3bPending, overdue };
  updateFilingChart();

  setStat("statTotalClients", scopedClients.length);
  setStat("statGstr1Pending", gstr1Pending);
  setStat("statGstr3bPending", gstr3bPending);
  setStat("statPaymentsPending", paymentsPending);
  setStat("statTotalStaff", staff.length);
  setStat("statTodaysDue", todaysDue);

  renderPaymentsTrend(scopedPayments);
  cachedClients = scopedClients;
  cachedPayments = scopedPayments;
  populateAchievementMonthFilter();
  renderTargetAchieved(scopedClients, scopedPayments, document.getElementById("achievementMonthFilter")?.value);
}

function setStat(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function initCharts() {
  const filingCanvas = document.getElementById("filingStatusChart");
  const trendCanvas = document.getElementById("paymentsTrendChart");
  if (!filingCanvas || !trendCanvas || typeof Chart === "undefined") return;

  const gridColor = getComputedStyle(document.documentElement).getPropertyValue("--border").trim();
  const textColor = getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim();

  filingChart = new Chart(filingCanvas, {
    type: "doughnut",
    data: {
      labels: ["Filed", "Pending", "Overdue"],
      datasets: [{ data: [0, 0, 0], backgroundColor: ["#3d8462", "#bc9a54", "#b25849"], borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { color: textColor, font: { size: 11 } } } },
      cutout: "68%",
    },
  });

  trendChart = new Chart(trendCanvas, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Payments received",
          data: [],
          borderColor: "#375f7d",
          backgroundColor: "rgba(55,95,125,0.12)",
          tension: 0.35,
          fill: true,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { grid: { display: false }, ticks: { color: textColor } },
        y: { grid: { color: gridColor }, ticks: { color: textColor } },
      },
      plugins: { legend: { display: false } },
    },
  });

  const targetCanvas = document.getElementById("targetAchievedChart");
  if (targetCanvas) {
    targetAchievedChart = new Chart(targetCanvas, {
      type: "bar",
      data: {
        labels: [],
        datasets: [
          { label: "Target", data: [], backgroundColor: "rgba(55,95,125,0.28)", borderRadius: 4, maxBarThickness: 28 },
          { label: "Achieved", data: [], backgroundColor: "#3d8462", borderRadius: 4, maxBarThickness: 28 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false }, ticks: { color: textColor } },
          y: { grid: { color: gridColor }, ticks: { color: textColor } },
        },
        plugins: { legend: { position: "bottom", labels: { color: textColor, font: { size: 11 } } } },
      },
    });
  }
}

function updateFilingChart() {
  if (!filingChart) return;
  filingChart.data.datasets[0].data = [filingTally.filed, filingTally.pending, filingTally.overdue];
  filingChart.update();
}

/** Builds the last 6 calendar months' "Paid" totals from the visible payments. */
function renderPaymentsTrend(scopedPayments) {
  if (!trendChart) return;
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (5 - i), 1);
    return { label: d.toLocaleDateString("en-IN", { month: "short" }), year: d.getFullYear(), month: d.getMonth() };
  });

  const totals = months.map((m) =>
    scopedPayments
      .filter((p) => p.status === "Paid" && p.date)
      .filter((p) => {
        const d = new Date(p.date);
        return d.getFullYear() === m.year && d.getMonth() === m.month;
      })
      .reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
  );

  trendChart.data.labels = months.map((m) => m.label);
  trendChart.data.datasets[0].data = totals;
  trendChart.update();
}

/**
 * The dropdown defaults to last month, not this month: GST returns (and the
 * fee collected alongside them) are worked one month behind — June's filing
 * and payment happen in July — so "this month" isn't a completed period
 * yet. Lists the last 12 months, most recent (= last month) first.
 */
function populateAchievementMonthFilter() {
  const sel = document.getElementById("achievementMonthFilter");
  if (!sel || sel.dataset.populated) return;
  sel.dataset.populated = "true";
  const now = new Date();
  const options = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 1 - i, 1);
    const short = d.toLocaleDateString("en-IN", { month: "short" });
    return { label: `${short} ${d.getFullYear()}`, value: `${short} ${d.getFullYear()}` };
  });
  sel.innerHTML = "";
  options.forEach((o, idx) => sel.add(new Option(o.label + (idx === 0 ? " (last month)" : ""), o.value)));
}

/** Sum of every visible Active client's fixed monthly fee — the practice's monthly collection target. */
function monthlyTarget(scopedClients) {
  return scopedClients
    .filter((c) => (c.status || "Active") !== "Inactive")
    .reduce((sum, c) => sum + (Number(c.monthlyFee) || 0), 0);
}

/** Sum of Paid payments billed to a given month (e.g. "Jul 2026") — what was actually collected for that period. */
function achievedForPeriod(scopedPayments, periodLabel) {
  return scopedPayments
    .filter((p) => p.status === "Paid" && p.billingPeriod === periodLabel)
    .reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
}

/** Active clients, split into paid / pending for a given billing period — no amounts, just counts. */
function clientPaidCountForPeriod(scopedClients, scopedPayments, periodLabel) {
  const activeClients = scopedClients.filter((c) => (c.status || "Active") !== "Inactive");
  const paidClientIds = new Set(
    scopedPayments.filter((p) => p.status === "Paid" && p.billingPeriod === periodLabel).map((p) => p.clientId)
  );
  const total = activeClients.length;
  const paid = activeClients.filter((c) => paidClientIds.has(c.id)).length;
  return { total, paid, pending: total - paid };
}

/** Staff view of the achievement card: total clients vs how many have paid for the period — amounts stay hidden from staff. */
function renderClientAchievement(scopedClients, scopedPayments, periodLabel) {
  const { total, paid, pending } = clientPaidCountForPeriod(scopedClients, scopedPayments, periodLabel);
  const pct = total > 0 ? Math.round((paid / total) * 100) : 0;

  setStat("achievementCardTitle", "Monthly Client Payment Status");
  setStat("achievementPctLabel", "Paid");
  setStat("achievementPct", `${pct}%`);
  setStat("achievementTargetLabel", "Total Clients");
  setStat("achievementTarget", total);
  setStat("achievementAchievedLabel", "Paid");
  setStat("achievementAchieved", paid);
  setStat("achievementPendingLabel", "Pending");
  setStat("achievementPending", pending);

  const fill = document.getElementById("achievementBarFill");
  if (fill) {
    fill.style.width = `${Math.min(pct, 100)}%`;
    fill.classList.toggle("is-short", pct < 100);
  }
}

/** Selected month's Target vs Achieved card, plus a 6-month bar chart (ending at last month, the latest completed filing period) so each month's collection can be compared against target. */
function renderTargetAchieved(scopedClients, scopedPayments, selectedLabel) {
  const now = new Date();
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthLabel = `${lastMonthDate.toLocaleDateString("en-IN", { month: "short" })} ${lastMonthDate.getFullYear()}`;
  const periodLabel = selectedLabel || lastMonthLabel;

  // Staff dashboards never show ₹ amounts — client paid/pending counts only.
  if (session.role === "staff") {
    renderClientAchievement(scopedClients, scopedPayments, periodLabel);
    return;
  }

  const target = monthlyTarget(scopedClients);
  const achieved = achievedForPeriod(scopedPayments, periodLabel);
  const pending = Math.max(target - achieved, 0);
  const pct = target > 0 ? Math.round((achieved / target) * 100) : 0;

  setStat("achievementCardTitle", "Monthly Target vs Achieved");
  setStat("achievementPctLabel", "Achieved");
  setStat("achievementPct", `${pct}%`);
  setStat("achievementTargetLabel", "Target");
  setStat("achievementTarget", formatCurrency(target));
  setStat("achievementAchievedLabel", "Achieved");
  setStat("achievementAchieved", formatCurrency(achieved));
  setStat("achievementPendingLabel", "Pending");
  setStat("achievementPending", formatCurrency(pending));

  const fill = document.getElementById("achievementBarFill");
  if (fill) {
    fill.style.width = `${Math.min(pct, 100)}%`;
    fill.classList.toggle("is-short", pct < 100);
  }

  if (!targetAchievedChart) return;
  // Last 6 completed months, ending at last month (this month's own
  // filing/collection isn't due yet, so it isn't a fair comparison point).
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - 1 - (5 - i), 1);
    return { short: d.toLocaleDateString("en-IN", { month: "short" }), year: d.getFullYear() };
  });
  targetAchievedChart.data.labels = months.map((m) => `${m.short} '${String(m.year).slice(-2)}`);
  targetAchievedChart.data.datasets[0].data = months.map(() => target);
  targetAchievedChart.data.datasets[1].data = months.map((m) => achievedForPeriod(scopedPayments, `${m.short} ${m.year}`));
  targetAchievedChart.update();
}

document.addEventListener("DOMContentLoaded", init);
