// Manager-only maintenance: move photos that older code stored inside the
// database (base64) into the bucket, in small resumable batches driven from
// Settings, then optionally compact the database file. See
// utils/photoMigration.js.
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { asyncRoute } = require("../utils/photoIntake");
const { remaining, migrateBatch } = require("../utils/photoMigration");
const { getObjectStore } = require("../utils/objectStore");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";

const dbBytes = () => { try { return fs.statSync(db.name).size; } catch { return null; } };

router.get("/migration", requireAuth, requireRole(MANAGER), (req, res) => {
  res.json({ ...remaining(db), dbBytes: dbBytes(), bucketConfigured: !!getObjectStore() });
});

// Body: { limit?: 1-25, cursor?: { t, rid } } — pass back the cursor from the
// previous call until `done` is true.
router.post("/migration", requireAuth, requireRole(MANAGER), asyncRoute(async (req, res) => {
  const store = getObjectStore();
  if (!store) return res.status(400).json({ error: "Bucket foto belum dikonfigurasi" });
  const limit = Math.min(25, Math.max(1, Number(req.body?.limit) || 10));
  const c = req.body?.cursor || {};
  const cursor = { t: Math.max(0, Number(c.t) || 0), rid: Math.max(0, Number(c.rid) || 0) };
  const result = await migrateBatch(db, store, { limit, cursor });
  res.json({ ...result, remaining: remaining(db).total });
}));

// Rewrites the database file without the space the moved photos used to
// take. Needs free disk space of about the file's current size, and blocks
// writes while it runs — refused if the volume doesn't have the room.
router.post("/compact", requireAuth, requireRole(MANAGER), (req, res) => {
  const before = dbBytes();
  try {
    const stat = fs.statfsSync(path.dirname(db.name));
    const free = stat.bavail * stat.bsize;
    if (before && free < before * 1.1) {
      return res.status(409).json({ error: `Ruang kosong di volume tidak cukup untuk merapikan database (perlu ±${Math.ceil(before / 1048576)} MB, tersedia ${Math.floor(free / 1048576)} MB)` });
    }
  } catch { /* statfs unavailable — let VACUUM itself fail if there's no room */ }
  db.exec("VACUUM");
  res.json({ beforeBytes: before, afterBytes: dbBytes() });
});

module.exports = router;
