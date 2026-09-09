// Permanent DB backup endpoint, for the scheduled off-site backup job.
//
// Auth: the static automation key (header `X-Automation-Key`), NOT a user JWT —
// so an unattended job (Railway Cron / GitHub Actions) can call it. Same key as
// the n8n automation routes (`AUTOMATION_API_KEY`); if that env var is unset the
// shared middleware rejects every request (secure by default).
//
// The response is a consistent point-in-time snapshot produced with
// better-sqlite3's .backup() into a temp file — copying `terex.db` directly
// could miss writes still sitting in the `-wal` sidecar. The temp file is
// deleted once the download finishes (or fails).

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const db = require("../db");
const { requireAutomationKey } = require("../middleware/automationAuth");

const router = express.Router();

router.get("/db", requireAutomationKey, async (req, res) => {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const name = `terex-backup-${stamp}.db`;
  const tmp = path.join(os.tmpdir(), name);

  try {
    await db.backup(tmp);
  } catch (err) {
    if (fs.existsSync(tmp)) fs.unlink(tmp, () => {});
    return res.status(500).json({ error: "Gagal membuat snapshot backup: " + err.message });
  }

  res.download(tmp, name, (err) => {
    fs.unlink(tmp, () => {});
    if (err && !res.headersSent) {
      res.status(500).json({ error: "Gagal mengirim file backup: " + err.message });
    }
  });
});

module.exports = router;
