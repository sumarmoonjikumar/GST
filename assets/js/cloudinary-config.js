/**
 * GST MASTER — Cloudinary configuration (free file storage for client documents).
 *
 * Firebase Storage now needs the paid Blaze plan, so document uploads
 * (KYC / IT proof) go through Cloudinary's free tier instead — 25GB
 * storage + 25GB bandwidth/month, no card required.
 *
 * SETUP (one-time, ~2 minutes):
 *   1. Sign up free at https://cloudinary.com
 *   2. Dashboard home shows your "Cloud name" at the top — copy it below.
 *   3. Go to Settings (gear icon) → Upload → Upload presets → "Add upload preset".
 *      - Signing Mode: UNSIGNED  (required — lets the browser upload directly,
 *        no backend/API secret needed)
 *      - Folder: clients  (optional, keeps uploads tidy)
 *      - Save, then copy the preset name below.
 */
export const cloudinaryConfig = {
  cloudName: "ddrm5nh4",
  uploadPreset: "client_docs",
};
