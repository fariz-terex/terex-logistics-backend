// One-off admin route for importing MSG historical data from the two Google
// Sheet CSV exports. Manager-only. POST the two CSV texts; without commit it's
// a dry run (returns the summary, writes nothing). With commit=true it inserts.
// Remove this route from server.js once the import is done.

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { buildUnits } = require("../importMsgCore");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";

// TEMP one-off: download a local backup of the SQLite database. Manager-only.
// Uses better-sqlite3's .backup() to write a consistent snapshot to a temp
// file first (so WAL/-wal contents are folded in — copying terex.db raw could
// miss recent writes), streams it as a download, then deletes the temp copy.
// Remove this route together with the other /api/admin routes (see TUGAS 3).
router.get("/backup-db", requireAuth, requireRole(MANAGER), async (req, res) => {
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

router.post("/import-msg", requireAuth, requireRole(MANAGER), (req, res) => {
  const { masukCsv, keluarCsv, commit } = req.body || {};
  if (!masukCsv || !keluarCsv) {
    return res.status(400).json({ error: "masukCsv dan keluarCsv (isi teks CSV) wajib dikirim" });
  }

  let result;
  try {
    result = buildUnits(masukCsv, keluarCsv);
  } catch (err) {
    return res.status(400).json({ error: "Gagal memproses CSV: " + err.message });
  }
  const { units, summary } = result;

  // Validate against master data so we never insert a unit pointing at a
  // material or homebase that doesn't exist (would break joins downstream).
  const masterMaterials = new Set(db.prepare("SELECT name FROM materials").all().map((r) => r.name));
  const masterHomebases = new Set(db.prepare("SELECT name FROM homebases").all().map((r) => r.name));
  const badMaterials = new Set(), badHomebases = new Set();
  for (const u of units) {
    if (!masterMaterials.has(u.material)) badMaterials.add(u.material);
    if (u.homebase && !masterHomebases.has(u.homebase)) badHomebases.add(u.homebase);
  }
  summary.masterMaterialMissing = [...badMaterials];
  summary.masterHomebaseMissing = [...badHomebases];

  // Block a commit if anything wouldn't resolve — dry-run always allowed.
  const hasBlockers = badMaterials.size > 0 || badHomebases.size > 0 || summary.materialMissing.length > 0;

  if (!commit) {
    return res.json({ mode: "dry-run", blockers: hasBlockers, summary });
  }
  if (hasBlockers) {
    return res.status(409).json({ mode: "blocked", error: "Ada material/homebase yang tidak cocok dengan master. Perbaiki dulu.", summary });
  }

  // Commit: wipe any prior MSG import, then insert. INSERT OR IGNORE so a
  // stray real SN that already exists (created via the app) is never clobbered.
  const wipe = db.prepare("DELETE FROM serial_numbers WHERE customer = 'MSG' AND received_ref = 'IMPORT-MSG'").run();
  const insert = db.prepare(`INSERT OR IGNORE INTO serial_numbers
    (sn, material, status, current_ref, received_date, received_ref, customer,
     installed_date, install_site, homebase,
     replacement_date, shipped_to_warehouse_date, returned_to_customer_date)
    VALUES (@sn, @material, @status, NULL, @received_date, 'IMPORT-MSG', @customer,
     @installed_date, @install_site, @homebase,
     @replacement_date, @shipped_to_warehouse_date, @returned_to_customer_date)`);
  let inserted = 0, skipped = 0;
  const tx = db.transaction((list) => {
    for (const u of list) {
      const r = insert.run(u);
      if (r.changes) inserted++; else skipped++;
    }
  });
  tx(units);

  res.json({ mode: "committed", wiped: wipe.changes, inserted, skipped, summary });
});

// Recompute material_stock for a division from its serial_numbers, so
// Warehouse Stock (which reads material_stock) matches the imported units.
// Per decision: ready = Ready + Delivered (units the division owns, incl.
// installed), faulty = Faulty. in_transit/reserved forced to 0 (no such data
// in the historical import). Overwrites the division's material_stock rows
// entirely. Dry-run unless commit=true.
router.post("/sync-stock", requireAuth, requireRole(MANAGER), (req, res) => {
  const { customer, commit } = req.body || {};
  if (!customer) return res.status(400).json({ error: "customer wajib diisi (mis. 'MSG')" });

  // Aggregate per material from serial_numbers.
  const rows = db.prepare(`
    SELECT material,
           SUM(CASE WHEN status IN ('Ready','Delivered') THEN 1 ELSE 0 END) AS ready,
           SUM(CASE WHEN status = 'Faulty' THEN 1 ELSE 0 END) AS faulty
    FROM serial_numbers
    WHERE customer = ?
    GROUP BY material
  `).all(customer);

  // Validate every material exists in master (material_stock has an FK to it).
  const masterMaterials = new Set(db.prepare("SELECT name FROM materials").all().map((r) => r.name));
  const missing = rows.map((r) => r.material).filter((m) => !masterMaterials.has(m));

  const preview = rows.map((r) => ({ material: r.material, ready: r.ready, faulty: r.faulty }))
    .sort((a, b) => a.material.localeCompare(b.material));

  if (!commit) {
    return res.json({ mode: "dry-run", customer, materials: preview.length, missing, preview });
  }
  if (missing.length) {
    return res.status(409).json({ mode: "blocked", error: "Ada material yang tidak ada di master", missing });
  }

  // Overwrite: clear this division's rows, then insert fresh aggregates.
  const clear = db.prepare("DELETE FROM material_stock WHERE customer = ?").run(customer);
  const ins = db.prepare(`INSERT INTO material_stock (material, customer, ready, faulty, reserved, in_transit)
    VALUES (@material, @customer, @ready, @faulty, 0, 0)`);
  let n = 0;
  const tx = db.transaction((list) => { for (const r of list) { ins.run({ material: r.material, customer, ready: r.ready, faulty: r.faulty }); n++; } });
  tx(rows);

  res.json({ mode: "committed", customer, cleared: clear.changes, inserted: n, preview });
});

module.exports = router;
