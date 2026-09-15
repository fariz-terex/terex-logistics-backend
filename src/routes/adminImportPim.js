// One-off admin route for importing PIM historical unit data from the
// "Update Material VSAT TEREX" Google Sheet. Manager-only. GET /preview is
// always a dry run (writes nothing); POST /commit actually inserts.
// Remove this route (and importPimData.json / importPimNewMaterials.json)
// from server.js once the import is done and confirmed — same one-off
// pattern as the MSG import (see terex-admin-import-archive/ outside this
// repo for that precedent).
//
// units[] and newMaterials[] were built from the sheet by carefully
// filtering out placeholder rows, rows the sheet itself flags "BEDA SN"
// (unreliable SN), and re-reading Serial Number cells that Excel/Sheets
// had rendered as lossy scientific notation for large numeric SNs — see
// the conversation this was built in for the full derivation. This file
// does not re-derive anything from the sheet at request time; it only
// applies the already-reviewed unit list.

const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { paddedSequenceId } = require("../utils/ids");
const units = require("../importPimData.json");
const newMaterials = require("../importPimNewMaterials.json");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";

function buildPreview() {
  const existingMaterialNames = new Set(db.prepare("SELECT name FROM materials").all().map((r) => r.name));
  const existingSns = new Set(db.prepare("SELECT sn FROM serial_numbers").all().map((r) => r.sn));

  const materialsToCreate = newMaterials.filter((m) => !existingMaterialNames.has(m.name));
  const materialsAlreadyExist = newMaterials.filter((m) => existingMaterialNames.has(m.name)).map((m) => m.name);

  const willInsert = units.filter((u) => !existingSns.has(u.sn));
  const willSkip = units.filter((u) => existingSns.has(u.sn));

  const byStatus = {};
  willInsert.forEach((u) => { byStatus[u.status] = (byStatus[u.status] || 0) + 1; });
  const byMaterial = {};
  willInsert.forEach((u) => { byMaterial[u.material] = (byMaterial[u.material] || 0) + 1; });
  const byCluster = {};
  willInsert.forEach((u) => { const k = u.cluster || "(none)"; byCluster[k] = (byCluster[k] || 0) + 1; });

  return {
    totalUnitsInFile: units.length,
    willInsert: willInsert.length,
    willSkip: willSkip.length,
    skippedSns: willSkip.map((u) => ({ sn: u.sn, material: u.material })),
    materialsToCreate,
    materialsAlreadyExist,
    byStatus,
    byMaterial: Object.fromEntries(Object.entries(byMaterial).sort((a, b) => b[1] - a[1])),
    byCluster,
  };
}

router.get("/pim-import/preview", requireAuth, requireRole(MANAGER), (req, res) => {
  res.json(buildPreview());
});

router.post("/pim-import/commit", requireAuth, requireRole(MANAGER), (req, res) => {
  const preview = buildPreview();

  const tx = db.transaction(() => {
    for (const m of preview.materialsToCreate) {
      const id = paddedSequenceId(db, "materials", "MAT", "id");
      db.prepare(`INSERT INTO materials (id, name, category, unit, serialized, min_stock, status, ready, faulty, reserved, in_transit)
        VALUES (?, ?, ?, 'Unit', 1, 0, 'Active', 0, 0, 0, 0)`).run(id, m.name, m.category);
    }

    // INSERT OR IGNORE: any SN that already exists (checked in buildPreview,
    // but re-checked here by the DB itself as the actual guarantee) is
    // silently skipped rather than overwriting a real, already-tracked unit.
    const insertSn = db.prepare(`INSERT OR IGNORE INTO serial_numbers
      (sn, material, status, current_ref, received_date, received_ref, customer, cluster, cluster_nod, install_site, installed_date)
      VALUES (@sn, @material, @status, NULL, NULL, 'IMPORT-PIM', @customer, @cluster, @clusterNod, @installSite, @installedDate)`);
    let inserted = 0;
    for (const u of units) {
      const r = insertSn.run(u);
      if (r.changes) inserted += 1;
    }

    // Resync PIM's material_stock entirely from serial_numbers. Only Ready/
    // Faulty count as "stock" here — an Installed unit is deployed at a
    // site, not available warehouse stock, so it's excluded on purpose
    // (visible instead via its own serial_numbers row: status, install_site,
    // installed_date).
    db.prepare("DELETE FROM material_stock WHERE customer = 'PIM'").run();
    const agg = db.prepare(`
      SELECT material,
        SUM(CASE WHEN status = 'Ready' THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN status = 'Faulty' THEN 1 ELSE 0 END) AS faulty
      FROM serial_numbers WHERE customer = 'PIM' GROUP BY material
    `).all();
    const insStock = db.prepare("INSERT INTO material_stock (material, customer, ready, faulty, reserved, in_transit) VALUES (?, 'PIM', ?, ?, 0, 0)");
    agg.forEach((r) => insStock.run(r.material, r.ready, r.faulty));

    // Global materials.ready/faulty is company-wide (every division) —
    // fully recomputed from serial_numbers for each touched material
    // rather than incremented, so it can never drift from source of truth.
    const touchedMaterials = new Set(units.map((u) => u.material));
    const updateGlobal = db.prepare(`UPDATE materials SET
      ready = (SELECT COUNT(*) FROM serial_numbers WHERE material = ? AND status = 'Ready'),
      faulty = (SELECT COUNT(*) FROM serial_numbers WHERE material = ? AND status = 'Faulty')
      WHERE name = ?`);
    touchedMaterials.forEach((m) => updateGlobal.run(m, m, m));

    return inserted;
  });

  let inserted;
  try {
    inserted = tx();
  } catch (err) {
    return res.status(500).json({ error: "Import gagal: " + err.message });
  }

  res.json({ ok: true, inserted, ...preview });
});

module.exports = router;
