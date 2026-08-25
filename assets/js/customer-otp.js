/**
 * GST MASTER — Customer "Forgot Password" via Mobile OTP
 *
 * Uses Firebase Phone Authentication (signInWithPhoneNumber) to send a
 * real SMS OTP to the client's registered mobile number, entirely from
 * the browser — no custom backend needed, consistent with the rest of
 * this app.
 *
 * ONE-TIME SETUP REQUIRED IN FIREBASE CONSOLE before this will send
 * real SMS (see README.md for the full walkthrough):
 *   1. Authentication → Sign-in method → enable "Phone".
 *   2. Project must be on the Blaze (pay-as-you-go) plan — Phone Auth
 *      is not available on the free Spark plan. Firebase still gives a
 *      free monthly SMS quota on Blaze.
 *   3. Authentication → Settings → Authorized domains → add the domain
 *      this app is hosted on (e.g. your GitHub Pages domain).
 * Until step 1–3 are done, "Send OTP" will show a clear error instead
 * of silently failing.
 *
 * This flow briefly signs the browser in as the verified phone number
 * (that's what proves the OTP was correct) and then signs back into
 * the app's normal anonymous session afterwards, so it doesn't disturb
 * anything else in the app.
 */
import {
  RecaptchaVerifier,
  signInWithPhoneNumber,
  signOut,
  signInAnonymously,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth } from "./firebase.js";
import DB from "./db.js";
import { normalizeMobile } from "./customer-account.js";

let modalEl, modal;
let recaptchaVerifier = null;
let confirmationResult = null;
let matchedUser = null; // the `users` doc (role: customer) for the mobile being reset

function ensureModal() {
  if (modalEl) return;
  modalEl = document.createElement("div");
  modalEl.className = "modal fade";
  modalEl.tabIndex = -1;
  modalEl.innerHTML = `
    <div class="modal-dialog modal-dialog-centered">
      <div class="modal-content">
        <div class="modal-header">
          <h5 class="modal-title mb-0" style="font-family:Manrope,Arial,sans-serif;color:#0B1F3A;">
            <i class="fa-solid fa-mobile-screen-button me-2"></i>Reset Password
          </h5>
          <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
        </div>
        <div class="modal-body">

          <div id="fpStepMobile">
            <p class="small text-muted mb-2">Enter your registered mobile number. We'll send a one-time code by SMS.</p>
            <div class="mb-2">
              <label class="form-label small mb-1">Mobile Number</label>
              <input type="tel" class="form-control" id="fpMobile" placeholder="10-digit mobile number" inputmode="numeric" autocomplete="tel">
            </div>
            <div id="fpRecaptcha" class="mb-2"></div>
            <div class="small text-danger d-none" id="fpMobileError"></div>
            <button type="button" class="btn btn-navy w-100 mt-2" id="fpSendOtpBtn">Send OTP</button>
          </div>

          <div id="fpStepOtp" class="d-none">
            <p class="small text-muted mb-2">Enter the 6-digit code sent to <strong id="fpOtpMobileLabel"></strong>.</p>
            <div class="mb-2">
              <label class="form-label small mb-1">OTP Code</label>
              <input type="text" class="form-control font-mono" id="fpOtpCode" inputmode="numeric" maxlength="6" placeholder="123456">
            </div>
            <div class="small text-danger d-none" id="fpOtpError"></div>
            <button type="button" class="btn btn-navy w-100 mt-2" id="fpVerifyOtpBtn">Verify OTP</button>
            <button type="button" class="btn btn-link btn-sm w-100 mt-1" id="fpResendOtpBtn">Resend OTP</button>
          </div>

          <div id="fpStepReset" class="d-none">
            <p class="small text-muted mb-2">Mobile verified. Set a new Customer Login password.</p>
            <div class="mb-2">
              <label class="form-label small mb-1">New Password</label>
              <input type="text" class="form-control font-mono" id="fpNewPassword" placeholder="At least 6 characters">
            </div>
            <div class="mb-2">
              <label class="form-label small mb-1">Confirm Password</label>
              <input type="text" class="form-control font-mono" id="fpConfirmPassword">
            </div>
            <div class="small text-danger d-none" id="fpResetError"></div>
            <button type="button" class="btn btn-navy w-100 mt-2" id="fpSavePasswordBtn">Save New Password</button>
          </div>

          <div id="fpStepDone" class="d-none text-center py-3">
            <i class="fa-solid fa-circle-check text-success" style="font-size:34px;"></i>
            <p class="mt-2 mb-0">Password updated. You can log in now.</p>
          </div>

        </div>
      </div>
    </div>`;
  document.body.appendChild(modalEl);
  modal = new bootstrap.Modal(modalEl);

  modalEl.querySelector("#fpSendOtpBtn").addEventListener("click", onSendOtp);
  modalEl.querySelector("#fpVerifyOtpBtn").addEventListener("click", onVerifyOtp);
  modalEl.querySelector("#fpResendOtpBtn").addEventListener("click", onSendOtp);
  modalEl.querySelector("#fpSavePasswordBtn").addEventListener("click", onSavePassword);
  modalEl.addEventListener("hidden.bs.modal", resetFlow);
}

function showStep(step) {
  ["fpStepMobile", "fpStepOtp", "fpStepReset", "fpStepDone"].forEach((id) => {
    modalEl.querySelector(`#${id}`).classList.toggle("d-none", id !== step);
  });
}

function showError(fieldId, message) {
  const el = modalEl.querySelector(`#${fieldId}`);
  el.textContent = message;
  el.classList.remove("d-none");
}

function clearError(fieldId) {
  const el = modalEl.querySelector(`#${fieldId}`);
  el.classList.add("d-none");
  el.textContent = "";
}

function resetFlow() {
  confirmationResult = null;
  matchedUser = null;
  if (recaptchaVerifier) {
    recaptchaVerifier.clear();
    recaptchaVerifier = null;
  }
  modalEl.querySelector("#fpMobile").value = "";
  modalEl.querySelector("#fpOtpCode").value = "";
  modalEl.querySelector("#fpNewPassword").value = "";
  modalEl.querySelector("#fpConfirmPassword").value = "";
  clearError("fpMobileError");
  clearError("fpOtpError");
  clearError("fpResetError");
  showStep("fpStepMobile");
}

function friendlyAuthError(err) {
  const code = err?.code || "";
  if (code === "auth/operation-not-allowed") {
    return "Phone sign-in isn't enabled for this project yet. Ask your admin to enable it in Firebase Console → Authentication → Sign-in method.";
  }
  if (code === "auth/billing-not-enabled" || code === "auth/quota-exceeded") {
    return "SMS sending isn't available yet — this Firebase project needs to be on the Blaze (pay-as-you-go) plan for Phone Auth.";
  }
  if (code === "auth/invalid-phone-number") {
    return "That doesn't look like a valid 10-digit mobile number.";
  }
  if (code === "auth/too-many-requests") {
    return "Too many attempts. Please wait a while and try again.";
  }
  if (code === "auth/code-expired") {
    return "That code expired. Tap Resend OTP for a new one.";
  }
  if (code === "auth/invalid-verification-code") {
    return "That code doesn't match. Please check and try again.";
  }
  return err?.message || "Something went wrong. Please try again.";
}

async function onSendOtp() {
  clearError("fpMobileError");
  const mobile = normalizeMobile(modalEl.querySelector("#fpMobile").value);
  if (!mobile) {
    showError("fpMobileError", "Enter a valid 10-digit mobile number.");
    return;
  }

  const btn = modalEl.querySelector("#fpSendOtpBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>Checking…`;

  try {
    const matches = await DB.getByIndex(DB.STORES.users, "username", mobile);
    const user = matches.find((u) => u.role === "customer");
    if (!user) {
      showError("fpMobileError", "No customer account is registered with this mobile number.");
      return;
    }
    matchedUser = user;

    if (recaptchaVerifier) {
      recaptchaVerifier.clear();
      modalEl.querySelector("#fpRecaptcha").innerHTML = "";
    }
    recaptchaVerifier = new RecaptchaVerifier(auth, "fpRecaptcha", { size: "normal" });

    confirmationResult = await signInWithPhoneNumber(auth, `+91${mobile}`, recaptchaVerifier);
    modalEl.querySelector("#fpOtpMobileLabel").textContent = `+91 ${mobile}`;
    showStep("fpStepOtp");
  } catch (err) {
    console.error("OTP send failed:", err);
    showError("fpMobileError", friendlyAuthError(err));
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Send OTP";
  }
}

async function onVerifyOtp() {
  clearError("fpOtpError");
  const code = modalEl.querySelector("#fpOtpCode").value.trim();
  if (!code) {
    showError("fpOtpError", "Enter the 6-digit code.");
    return;
  }
  const btn = modalEl.querySelector("#fpVerifyOtpBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>Verifying…`;

  try {
    await confirmationResult.confirm(code);
    showStep("fpStepReset");
  } catch (err) {
    console.error("OTP verify failed:", err);
    showError("fpOtpError", friendlyAuthError(err));
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Verify OTP";
  }
}

async function onSavePassword() {
  clearError("fpResetError");
  const pass = modalEl.querySelector("#fpNewPassword").value;
  const confirm = modalEl.querySelector("#fpConfirmPassword").value;
  if (!pass || pass.length < 6) {
    showError("fpResetError", "Password must be at least 6 characters.");
    return;
  }
  if (pass !== confirm) {
    showError("fpResetError", "Passwords don't match.");
    return;
  }

  const btn = modalEl.querySelector("#fpSavePasswordBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span>Saving…`;

  try {
    matchedUser.password = pass;
    matchedUser.updatedAt = new Date().toISOString();
    await DB.put(DB.STORES.users, matchedUser);

    // Keep the client record's own copy of the password in sync, so
    // Client Master shows the same current password.
    if (matchedUser.clientId) {
      const client = await DB.get(DB.STORES.clients, matchedUser.clientId);
      if (client) {
        client.customerPassword = pass;
        client.updatedAt = new Date().toISOString();
        await DB.put(DB.STORES.clients, client);
      }
    }

    // Restore the app's normal anonymous session (verifying the OTP
    // signed this tab in as the phone number instead).
    try {
      await signOut(auth);
      await signInAnonymously(auth);
    } catch { /* best-effort — a stale session here doesn't block the password change */ }

    showStep("fpStepDone");
  } catch (err) {
    console.error("Password reset failed:", err);
    showError("fpResetError", "Couldn't save the new password. Please try again.");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Save New Password";
  }
}

export function openForgotPasswordFlow() {
  ensureModal();
  resetFlow();
  modal.show();
}
