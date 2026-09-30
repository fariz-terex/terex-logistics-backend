// Google Drive archive of ORIGINAL photos: connect/disconnect the account
// (Manager, from Settings), OAuth callback, and the endpoint the browser
// stages originals to. See utils/googleDrive.js, utils/originals.js,
// utils/archiveWorker.js.
const express = require("express");
const crypto = require("node:crypto");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const gdrive = require("../utils/googleDrive");
const originals = require("../utils/originals");
const { getSetting } = require("../utils/archiveWorker");
const { getObjectStore } = require("../utils/objectStore");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";
const MAX_ORIGINAL_BYTES = 20 * 1024 * 1024;

const setSetting = (key, value) => db.prepare("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
const deleteSetting = (key) => db.prepare("DELETE FROM app_settings WHERE key = ?").run(key);
const connected = () => !!getSetting(db, "gdrive_refresh_token") && gdrive.isConfigured();
const frontendUrl = () => (process.env.FRONTEND_URL || (process.env.RAILWAY_SERVICE_FRONTEND_URL ? `https://${process.env.RAILWAY_SERVICE_FRONTEND_URL}` : "")).replace(/\/$/, "");

// Any signed-in user: should the browser bother staging originals?
router.get("/enabled", requireAuth, (req, res) => {
  res.json({ enabled: connected() && !!getObjectStore() });
});

router.get("/status", requireAuth, requireRole(MANAGER), (req, res) => {
  res.json({
    configured: gdrive.isConfigured(),
    connected: connected(),
    email: getSetting(db, "gdrive_email"),
    expectedEmail: gdrive.EXPECTED_ACCOUNT,
    redirectUri: gdrive.oauthConfig().redirectUri,
    counts: originals.counts(db),
  });
});

router.post("/auth-url", requireAuth, requireRole(MANAGER), (req, res) => {
  if (!gdrive.isConfigured()) return res.status(400).json({ error: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET belum di-set di Railway" });
  const state = crypto.randomBytes(24).toString("hex");
  setSetting("gdrive_oauth_state", JSON.stringify({ state, exp: Date.now() + 10 * 60 * 1000, by: req.user.name }));
  res.json({ url: gdrive.authUrl(state) });
});

// Google redirects the browser here after consent (no JWT on this request —
// the one-time `state` stored by /auth-url is what authorizes it).
router.get("/callback", async (req, res) => {
  const back = (result) => res.redirect(`${frontendUrl()}/?gdrive=${encodeURIComponent(result)}#/settings`);
  const saved = JSON.parse(getSetting(db, "gdrive_oauth_state") || "null");
  deleteSetting("gdrive_oauth_state");
  if (req.query.error) return back(`error:${req.query.error}`);
  if (!saved || saved.state !== req.query.state || Date.now() > saved.exp) return back("error:state");
  try {
    const tokens = await gdrive.exchangeCode(String(req.query.code || ""));
    if (!tokens.refresh_token) return back("error:no_refresh_token");
    const drive = gdrive.createDriveClient({ refreshToken: tokens.refresh_token });
    const email = await drive.about().catch(() => null);
    setSetting("gdrive_refresh_token", tokens.refresh_token);
    setSetting("gdrive_email", email || "");
    console.log(`[gdrive] connected ${email || "(unknown account)"} by ${saved.by}`);
    back("ok");
  } catch (err) {
    console.error(`[gdrive] callback failed: ${err.message}`);
    back("error:exchange");
  }
});

router.post("/disconnect", requireAuth, requireRole(MANAGER), (req, res) => {
  deleteSetting("gdrive_refresh_token");
  deleteSetting("gdrive_email");
  res.json({ connected: false });
});

// The browser stages a photo's ORIGINAL right after the user picks it:
// { hash: sha256 hex of the compressed copy's bytes, original: data URL }.
// Best effort by design — answering 204 (not connected / duplicate) is fine.
router.post("/originals", requireAuth, async (req, res) => {
  const { hash, original } = req.body || {};
  const store = getObjectStore();
  if (!connected() || !store) return res.status(204).end();
  if (!/^[0-9a-f]{64}$/.test(String(hash || ""))) return res.status(400).json({ error: "hash tidak valid" });
  const m = /^data:(image\/([a-z0-9.+-]+));base64,(.+)$/i.exec(String(original || ""));
  if (!m) return res.status(400).json({ error: "File asli harus berupa foto" });
  const body = Buffer.from(m[3], "base64");
  if (body.length > MAX_ORIGINAL_BYTES) return res.status(413).json({ error: "Foto asli terlalu besar" });
  const d = new Date();
  const ext = m[2].toLowerCase().replace("jpeg", "jpg").replace(/[^a-z0-9]/g, "") || "jpg";
  const key = `originals/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
  try {
    await store.putObject(key, body, m[1]);
    if (!originals.stageOriginal(db, { hash, stagingKey: key })) await store.deleteObject(key).catch(() => {});
    res.status(201).json({ staged: true });
  } catch (err) {
    res.status(502).json({ error: err.message || "Gagal menyimpan foto asli" });
  }
});

module.exports = router;
