/**
 * GST MASTER — Service Worker
 * Network-first: always tries to fetch the latest file first, so a new
 * deploy shows up immediately on the next reload. The cache is only used
 * as a fallback when the network request fails (offline use).
 * Note: this deliberately does NOT cache CDN libraries with a
 * "cache forever" strategy other than network-first, so Bootstrap /
 * Chart.js / Font Awesome updates still come through when online.
 */

const CACHE_NAME = "gst-master-shell-v10";

const APP_SHELL = [
  "./",
  "./index.html",
  "./dashboard.html",
  "./clients.html",
  "./staff.html",
  "./payments.html",
  "./gst-filing.html",
  "./reports.html",
  "./manifest.json",
  "./assets/css/theme.css",
  "./assets/css/login.css",
  "./assets/css/dashboard.css",
  "./assets/js/firebase-config.js",
  "./assets/js/firebase.js",
  "./assets/js/db.js",
  "./assets/js/utils.js",
  "./assets/js/auth.js",
  "./assets/js/chrome.js",
  "./assets/js/login.js",
  "./assets/js/dashboard.js",
  "./assets/js/clients.js",
  "./assets/js/staff.js",
  "./assets/js/payments.js",
  "./assets/js/gst-filing.js",
  "./assets/js/gst-status.js",
  "./assets/js/reports.js",
  "./assets/icons/logo-icon.svg",
];

// Note: since data now lives in Firestore (not IndexedDB), the app shell
// (HTML/CSS/JS) still loads offline via this cache, but client/staff/
// payment data itself needs network the first time — Firestore keeps its
// own separate offline cache (see enableIndexedDbPersistence in firebase.js)
// for previously-fetched documents.

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  // Network-first: fetch fresh content, cache a copy for offline fallback.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200 && event.request.url.startsWith(self.location.origin)) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
