// One-off admin route for importing MSG historical data from the two Google
// Sheet CSV exports. Manager-only. POST the two CSV texts; without commit it's
// a dry run (returns the summary, writes nothing). With commit=true it inserts.
// Remove this route from server.js once the import is done.

const express = require("express");
const db = require("./db");
const { requireAuth, requireRole } = require("./middleware/auth");
const { buildUnits } = require("./importMsgCore");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";

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

module.exports = router;
