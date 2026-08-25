# GST Master v1.1

GST Consulting Office Management System — front-end only, no PHP/Node/
custom backend to run. Data now lives in **Cloud Firestore** (Firebase
project `gst-master-16d99`) instead of the browser's IndexedDB, so the
same data is shared across every device/browser that logs in — the
original v1.0 was single-browser only. Still hosts for free on GitHub
Pages.

## Folder structure

```
gst-master/
├── index.html              → Login page (Admin / Staff / Customer)
├── dashboard.html           → Dashboard shell (sidebar + topbar + stats + charts)
├── clients.html              → Client Master
├── staff.html                → Staff Master (admin only)
├── payments.html              → Payments module
├── manifest.json             → PWA manifest (installable on mobile)
├── service-worker.js         → Offline caching of the app shell
├── firestore.rules            → Firestore Security Rules — paste into Firebase Console
├── storage.rules              → Storage Security Rules — paste into Firebase Console
├── README.md
└── assets/
    ├── css/
    │   ├── theme.css         → Design tokens: colors, type, shared components
    │   ├── login.css         → Login page styles
    │   └── dashboard.css     → Sidebar / topbar / cards / table styles
    ├── js/
    │   ├── firebase-config.js → Your Firebase project config
    │   ├── firebase.js        → Firebase app / Firestore / anonymous-auth bootstrap
    │   ├── db.js               → Firestore data layer (clients, staff, GST, payments…)
    │   ├── auth.js              → Login / session / logout logic
    │   ├── chrome.js            → Shared sidebar/topbar behaviour
    │   ├── utils.js             → Shared helpers (dates, currency, toasts, theme)
    │   ├── login.js             → Login page controller
    │   ├── dashboard.js         → Dashboard page controller
    │   ├── clients.js           → Client Master controller
    │   ├── staff.js             → Staff Master controller
    │   └── payments.js          → Payments controller
    └── icons/
        └── logo-icon.svg      → Placeholder brand mark (swap anytime)
```

## Firestore setup (one-time, in Firebase Console)

1. **Create the database.** Firebase Console → your project
   (`gst-master-16d99`) → Firestore Database → Create database →
   start in **production mode** → pick a region close to your users.
2. **Enable Anonymous sign-in.** Console → Authentication → Sign-in
   method → enable **Anonymous**. GST Master uses this silently, under
   the hood, just so Firestore rules can tell "a request from this app"
   apart from a random stranger on the internet — your Admin/Staff/
   Customer login is unrelated and still works exactly as before. See
   the comment block at the top of `firestore.rules` for the full
   explanation and its limits.
3. **Publish the rules.** Console → Firestore Database → Rules → paste
   the contents of `firestore.rules` → Publish.
4. **Enable Storage + publish its rules** (needed for client KYC / IT
   document uploads). Console → Storage → Get started → same region as
   Firestore. Then Storage → Rules → paste the contents of
   `storage.rules` → Publish.
5. Deploy the files as before (GitHub Pages, keeping `assets/` next to
   the HTML files) — no build step needed.

**Security note:** `clients.js` stores GST portal and customer login
passwords as plain fields on the client record, and staff logins store
plain-text passwords too. That was a reasonable shortcut when everything
stayed inside one browser's IndexedDB; now that it's in Firestore, it's
worth treating as sensitive: keep the rules in `firestore.rules`
published, don't share the project's config beyond people who should
have full read/write access to every client's credentials, and consider
moving to hashed passwords / real Firebase Authentication with custom
claims if this goes into real use beyond a small trusted team.

## How to publish on GitHub Pages (free)

1. Create a new GitHub repository (e.g. `gst-master`).
2. Upload every file in this folder, **keeping the folder structure intact**
   (the `assets/` folder must stay next to `index.html`).
3. Go to **Settings → Pages** in your repo.
4. Under "Build and deployment", choose **Deploy from a branch**,
   branch **main**, folder **/(root)**. Save.
5. GitHub will give you a URL like:
   `https://<your-username>.github.io/gst-master/`
6. Open it — the Login page loads first. Works on mobile browsers too,
   and can be "Added to Home Screen" like an app (PWA-ready).

No build step, no npm install — it's plain HTML/CSS/JS, so it runs exactly
as uploaded.

## Demo login (first run)

The very first time the app runs in a browser, it seeds one admin account:

- **Role:** Admin
- **Username:** `admin`
- **Password:** `admin123`

Change this later from Settings once the Client/Staff/Settings modules are
built (see roadmap below). All data lives in that browser's IndexedDB —
clearing site data / browser storage will reset the app.

## What's built so far

- Full folder/module structure, now backed by **Cloud Firestore**
- Login page: 3 role cards (Admin / Staff / Customer), dark mode toggle,
  remember-me, forgot-password stub
- Dashboard shell: sidebar (role-aware — Staff/Customer see fewer items),
  topbar with quick search, 6 summary cards, 2 charts (Chart.js), recent
  activity feed
- **Client Master (`clients.html`)**:
  - Admin: add / edit / delete clients, assign each client to a staff member,
    set Active/Inactive status, set GST portal + customer login credentials
  - Staff: sees only their assigned clients (enforced in code, not just
    hidden in the UI), can update GST portal username/password and the
    customer login password via a "Credentials" action — matches their
    permission list exactly (no delete, no full record edit)
  - Search by name/GSTIN, filter by status, filter by staff (admin)
  - GSTIN format validated (15-character pattern) and checked for duplicates
- **Staff Master (`staff.html`, admin only)**:
  - Add / edit / delete staff — name, phone, email, joining date, status
  - Each staff record has a linked login (username + password, role
    `staff`) so they can sign in from the Staff Login tab immediately
  - Deleting a staff member also removes their login and unassigns them
    from any clients they were assigned to (client stays, just goes
    back to "Unassigned")
  - Shows how many clients are currently assigned to each staff member
- **Payments (`payments.html`)**:
  - Record a payment against a client: amount, date, mode (Cash / Bank
    Transfer / UPI / Cheque / Other), status (Paid / Pending), invoice
    or reference number, notes
  - Admin sees and manages all payments; staff only see and record
    payments for their own assigned clients (same enforcement pattern
    as Client Master); only admin can delete a payment record
  - Summary strip: total paid, total pending, record count, and count
    of pending payments older than 30 days
  - Feeds the dashboard's "Payments Pending" stat and the Payments
    Trend chart's underlying data
- **GST Filing (`gst-filing.html`)**:
  - Client × month matrix for GSTR-1 and GSTR-3B, one FY (April→March) at
    a time — green pill = Filed, red pill = Pending, click any pill to
    update it (optional filed date + notes)
  - A period is only shown as due once its calendar month has begun, so
    future months in the FY don't falsely show as pending
  - **Pending List** tab: every not-yet-filed return across the selected
    FY/month/type, one row per client/period, sorted soonest-due first,
    with a one-click "Mark Filed" action
  - Filters: Financial Year, month, GSTR-1/GSTR-3B, staff (admin), and a
    client/GSTIN search — staff only ever see their assigned clients
  - Nothing is written to Firestore until a status is actually set —
    until then a client/period/return is treated as a virtual "Pending"
    record (kept in sync via `assets/js/gst-status.js`)
- **Payments — billing period & pending-by-month**:
  - Each payment can optionally be tagged with a "for month" billing
    period (current + previous FY)
  - **Pending by Month** tab groups pending payments by that period so
    you can see which parties owe for which month at a glance
- **Reports (`reports.html`, admin only)**: one row per client —
  GSTR-1/GSTR-3B filed vs pending counts for the selected FY, payments
  paid vs pending totals, and an overall "Up to date / Action needed"
  status; filter by staff or search, export the current view to CSV
- **Dashboard**: the summary boxes are now clickable — GSTR-1/GSTR-3B
  Pending and Payments Pending link straight into the matching
  pre-filtered list, and the Filing Status doughnut / Payments Trend
  line chart are now driven by real Firestore data instead of zeros
- Firestore schema in use: `users`, `clients`, `staff`, `gstRecords`,
  `payments`, `activity`, `settings` — plus backup/restore export-import
  helpers in `db.js`

## How to add a client

1. Log in as **admin** (`admin` / `admin123`).
2. Open **Clients** in the sidebar.
3. Click **Add Client** (top right).
4. Fill in Business Name and GSTIN (required), plus contact details.
5. Optionally assign a staff member (add staff first via **Staff** in
   the sidebar if the dropdown is empty).
6. Click **Save Client** — it appears in the table immediately and is
   stored in Firestore, visible to every device that logs in.

## How to add a staff member

1. Log in as **admin**.
2. Open **Staff** in the sidebar → **Add Staff**.
3. Fill in name and a login username/password (required for a new
   staff member — this becomes their Staff Login credentials).
4. Save — they can now sign in via the **Staff Login** tab, and you can
   assign clients to them from Client Master.

## How to record a payment

1. Log in as **admin** or **staff**.
2. Open **Payments** in the sidebar → **Add Payment**.
3. Choose the client (staff only see their own assigned clients here
   too), enter amount, date, mode, and status.
4. Save — it shows up in the table and in the dashboard's payment stats.

## Roadmap (waiting on your next prompt, per the spec)

- Settings + Backup/Restore UI (the export/import functions already
  exist in `db.js`, just need a page wired to them)

## Customer Login, OTP & Invoice Master (added this update)

**Customer Login is now mobile-number based.** In Client Master, the
Customer Login username is auto-derived (read-only) from the client's
Phone field — no separate username to manage. Click the 🎲 button next
to Customer Login Password to generate a strong random password. Saving
the client (or the Credentials panel) automatically creates/updates a
matching login in the `users` collection.

**Forgot Password (OTP) — one-time setup required in Firebase Console:**
1. Authentication → Sign-in method → enable **Phone**.
2. Your project must be on the **Blaze** (pay-as-you-go) plan — Phone
   Auth is not available on the free Spark plan (Blaze still includes a
   free monthly SMS quota).
3. Authentication → Settings → Authorized domains → add the domain this
   app is hosted on (e.g. your GitHub Pages domain).

Until all three are done, tapping "Send OTP" on the Customer Login tab
will show a clear in-app error instead of silently failing.

**Customer Dashboard** (`customer-dashboard.html`) — what a client sees
after logging in: their own GST filing status (GSTR-1 / GSTR-3B, period
by period) and their payments (pending amount + list, plus recent paid
history), with a link into their invoice/statement. Customers are
blocked from every admin/staff page and redirected here automatically.

**Invoice Master** (`invoice-master.html`, admin/staff only) — pick a
party, add line items (description, HSN/SAC, qty, rate), and generate a
proper multi-item sale invoice — separate from the auto-generated GST
filing fee invoices. Invoices get their own `SI/FY/###` numbering, can
be marked Paid/Unpaid, and print using the same Tally-style layout as
the rest of the app (`invoice.html?sales=<id>`).

