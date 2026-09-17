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
const faultyFix = require("../importPimFaultyFix.json");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";

// Shared by both commits below — resyncs PIM's material_stock from
// serial_numbers (Ready/Faulty only — an Installed unit is deployed at a
// site, not available warehouse stock) and recomputes each touched
// material's company-wide ready/faulty totals from source of truth, so
// neither can drift.
function resyncPimStock(touchedMaterialNames) {
  db.prepare("DELETE FROM material_stock WHERE customer = 'PIM'").run();
  const agg = db.prepare(`
    SELECT material,
      SUM(CASE WHEN status = 'Ready' THEN 1 ELSE 0 END) AS ready,
      SUM(CASE WHEN status = 'Faulty' THEN 1 ELSE 0 END) AS faulty
    FROM serial_numbers WHERE customer = 'PIM' GROUP BY material
  `).all();
  const insStock = db.prepare("INSERT INTO material_stock (material, customer, ready, faulty, reserved, in_transit) VALUES (?, 'PIM', ?, ?, 0, 0)");
  agg.forEach((r) => insStock.run(r.material, r.ready, r.faulty));

  const updateGlobal = db.prepare(`UPDATE materials SET
    ready = (SELECT COUNT(*) FROM serial_numbers WHERE material = ? AND status = 'Ready'),
    faulty = (SELECT COUNT(*) FROM serial_numbers WHERE material = ? AND status = 'Faulty')
    WHERE name = ?`);
  touchedMaterialNames.forEach((m) => updateGlobal.run(m, m, m));
}

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

    resyncPimStock(new Set(units.map((u) => u.material)));

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

// --- Faulty correction --------------------------------------------------
// Fixes a gap found after the first import: a "Replacement" row in the
// sheet carries TWO serial numbers — the new unit installed (S/N After,
// already imported above as Installed) and the OLD unit pulled out because
// it was faulty (S/N Before), which was never imported at all. Some of
// those old units later got repaired and show up again as a later
// "AVAILABLE" row or as the S/N After of a later replacement — so this
// isn't a blind "S/N Before = Faulty" pass, it's the result of resolving
// every SN's full timeline (every row it appears in, ordered by date) to
// its most recent state. See the conversation this was built in for the
// full derivation.
//   toUpdateStatusSns — SNs currently Installed (from the first import)
//     that a later event shows were actually swapped out — corrected to
//     Faulty (and their install_site/installed_date cleared, since they're
//     no longer at that site).
//   toInsert — SNs never imported at all, whose final resolved state is
//     Faulty.
function buildFaultyFixPreview() {
  const existingSns = new Set(db.prepare("SELECT sn FROM serial_numbers").all().map((r) => r.sn));
  const currentlyInstalled = new Set(
    db.prepare("SELECT sn FROM serial_numbers WHERE customer = 'PIM' AND status = 'Installed'").all().map((r) => r.sn)
  );

  const willInsert = faultyFix.toInsert.filter((u) => !existingSns.has(u.sn));
  const willSkipInsert = faultyFix.toInsert.filter((u) => existingSns.has(u.sn));
  const willUpdate = faultyFix.toUpdateStatusSns.filter((sn) => currentlyInstalled.has(sn));
  const willSkipUpdate = faultyFix.toUpdateStatusSns.filter((sn) => !currentlyInstalled.has(sn));

  const byMaterial = {};
  willInsert.forEach((u) => { byMaterial[u.material] = (byMaterial[u.material] || 0) + 1; });

  return {
    willInsert: willInsert.length,
    willSkipInsert: willSkipInsert.length,
    skippedInsertSns: willSkipInsert.map((u) => u.sn),
    willUpdate: willUpdate.length,
    willSkipUpdate: willSkipUpdate.length,
    skippedUpdateSns: willSkipUpdate,
    byMaterial: Object.fromEntries(Object.entries(byMaterial).sort((a, b) => b[1] - a[1])),
  };
}

router.get("/pim-import/fix-faulty/preview", requireAuth, requireRole(MANAGER), (req, res) => {
  res.json(buildFaultyFixPreview());
});

router.post("/pim-import/fix-faulty/commit", requireAuth, requireRole(MANAGER), (req, res) => {
  const preview = buildFaultyFixPreview();

  const tx = db.transaction(() => {
    const insertSn = db.prepare(`INSERT OR IGNORE INTO serial_numbers
      (sn, material, status, current_ref, received_date, received_ref, customer, cluster, cluster_nod, install_site, installed_date)
      VALUES (@sn, @material, @status, NULL, NULL, 'IMPORT-PIM-FAULTYFIX', @customer, @cluster, @clusterNod, @installSite, @installedDate)`);
    let inserted = 0;
    for (const u of faultyFix.toInsert) {
      const r = insertSn.run(u);
      if (r.changes) inserted += 1;
    }

    // Guarded on status = 'Installed' so this only ever touches a unit
    // still in the exact state the first import left it in — if something
    // else already changed it since, this silently leaves it alone rather
    // than clobbering whatever that newer state is.
    const updateStatus = db.prepare("UPDATE serial_numbers SET status = 'Faulty', install_site = NULL, installed_date = NULL WHERE sn = ? AND customer = 'PIM' AND status = 'Installed'");
    let updated = 0;
    for (const sn of faultyFix.toUpdateStatusSns) {
      const r = updateStatus.run(sn);
      if (r.changes) updated += 1;
    }

    const touchedMaterials = new Set([...faultyFix.toInsert.map((u) => u.material), ...units.map((u) => u.material)]);
    resyncPimStock(touchedMaterials);

    return { inserted, updated };
  });

  let result;
  try {
    result = tx();
  } catch (err) {
    return res.status(500).json({ error: "Koreksi gagal: " + err.message });
  }

  res.json({ ok: true, ...result, ...preview });
});

module.exports = router;
