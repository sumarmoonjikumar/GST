/**
 * GST MASTER — Firebase bootstrap.
 *
 * Initializes the Firebase app, Firestore (with offline persistence so
 * the app keeps working — read-only — when the connection drops), and
 * signs in anonymously.
 *
 * IMPORTANT — why anonymous auth even though logins are custom:
 * GST Master's Admin/Staff/Customer login is our own username/password
 * system stored in Firestore, not Firebase Authentication. Firestore
 * Security Rules, however, have no way to see "who" that custom login
 * is — they can only see whether the *browser* holds a real Firebase
 * Auth token. Without any Firebase Auth at all, rules would have to
 * either allow every visitor on the internet to read/write the
 * database, or block everyone including this app. Signing in
 * anonymously gives every visitor of *this app* a Firebase Auth token,
 * so rules can require `request.auth != null` and reject requests that
 * didn't come through the app at all.
 *
 * This is NOT the same as real per-role security — anyone who can load
 * the app can still read/write any document, same as before. Real
 * per-role protection (e.g. only staff can see their assigned clients,
 * enforced by the server rather than just the UI) requires migrating
 * logins to real Firebase Authentication with custom claims. See
 * firestore.rules for the honest tradeoff, and README.md for notes.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  enableIndexedDbPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
// Client KYC / IT document uploads (PDF or JPG) live here, under clients/{clientId}/…
export const storage = getStorage(app);

// Offline cache: lets reads keep working (and writes queue) when offline.
// Safe to ignore failure — it just means no offline cache in this tab
// (e.g. multiple tabs open, or an unsupported browser).
enableIndexedDbPersistence(db).catch(() => {});

let _readyResolve;
export const firebaseReady = new Promise((resolve) => {
  _readyResolve = resolve;
});

onAuthStateChanged(auth, (user) => {
  if (user) _readyResolve(user);
});

signInAnonymously(auth).catch((err) => {
  console.error("Firebase anonymous sign-in failed:", err);
});
