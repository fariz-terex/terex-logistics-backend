// One-off admin route for importing IPT historical unit data from
// "Data Material MS IPT-Terex - Online.csv" and its official homebase list
// "Import_2_Master_Homebase - IPT.xlsx" (both supplied by the user in their
// Downloads folder — IPT is a brand-new division, not yet in the system).
// GET /preview is always a dry run (writes nothing); POST /commit actually
// inserts. Remove this route (and the importIpt*.json data files) from
// server.js once the import is done and confirmed — same one-off pattern as
// the PIM/MSG imports (see routes/adminImportPim.js for precedent).
//
// Rows were filtered from the raw sheet per the user's own decisions:
//   - Kepemilikan (ownership) must be "IPT" — rows owned by "Terex" itself
//     were excluded entirely, at the user's request.
//   - Status must resolve to Ready / Installed / Faulty. "Return" (33 rows)
//     and "Need QC" (5 rows) have no equivalent in the app's status enum —
//     excluded entirely, at the user's request.
//   - A material with at least one real Serial Number anywhere in the kept
//     rows is treated as serialized; its remaining "No SN" rows are dropped
//     (can't create a serial_numbers row without a serial). A material with
//     ONLY "No SN" rows is treated as non-serialized — its Ready/Faulty
//     quantities are aggregated into material_stock instead. An "Installed"
//     quantity for a non-serialized material is already consumed at a site
//     (no warehouse-stock bucket for that), so it contributes nothing.
//   - install_site/installed_date/homebase are only ever set for Installed
//     units, matching the schema's own invariant (see materialSwaps.js) —
//     Ready/Faulty units get homebase=NULL, meaning "at the central
//     warehouse", same as every other division.
//   - homebase for an Installed unit is resolved from its Region against
//     the 9 official homebases; anything else is left Unassigned (NULL) per
//     the user's choice, rather than guessed at.
// See build_ipt_import.js (this conversation) for the exact derivation.

const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { paddedSequenceId } = require("../utils/ids");
const units = require("../importIptUnits.json");
const newMaterials = require("../importIptNewMaterials.json");
const nonSerialStock = require("../importIptNonSerialStock.json");
const homebases = require("../importIptHomebases.json");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";
const CUSTOMER = "IPT";

function buildPreview() {
  const customerExists = !!db.prepare("SELECT 1 FROM customers WHERE name = ?").get(CUSTOMER);

  const existingAreaNames = new Set(db.prepare("SELECT name FROM areas").all().map((r) => r.name));
  const areasToCreate = [...new Set(homebases.map((h) => h.area))].filter((a) => !existingAreaNames.has(a));

  const existingHomebaseNames = new Set(db.prepare("SELECT name FROM homebases").all().map((r) => r.name));
  const homebasesToCreate = homebases.filter((h) => !existingHomebaseNames.has(h.name)).map((h) => h.name);
  const homebasesAlreadyExist = homebases.filter((h) => existingHomebaseNames.has(h.name)).map((h) => h.name);

  const existingMaterialNames = new Set(db.prepare("SELECT name FROM materials").all().map((r) => r.name));
  const materialsToCreate = newMaterials.filter((m) => !existingMaterialNames.has(m.name));
  const materialsAlreadyExist = newMaterials.filter((m) => existingMaterialNames.has(m.name)).map((m) => m.name);

  const existingSns = new Set(db.prepare("SELECT sn FROM serial_numbers").all().map((r) => r.sn));
  const willInsertUnits = units.filter((u) => !existingSns.has(u.sn));
  const willSkipUnits = units.filter((u) => existingSns.has(u.sn));

  const byStatus = {};
  willInsertUnits.forEach((u) => { byStatus[u.status] = (byStatus[u.status] || 0) + 1; });
  const byMaterial = {};
  willInsertUnits.forEach((u) => { byMaterial[u.material] = (byMaterial[u.material] || 0) + 1; });

  const nonSerialTotal = Object.values(nonSerialStock).reduce((s, v) => s + v.ready + v.faulty, 0);

  return {
    customerExists,
    areasToCreate,
    homebasesToCreate,
    homebasesAlreadyExist,
    materialsToCreate,
    materialsAlreadyExist,
    totalUnitsInFile: units.length,
    willInsert: willInsertUnits.length,
    willSkip: willSkipUnits.length,
    skippedSns: willSkipUnits.map((u) => ({ sn: u.sn, material: u.material })),
    byStatus,
    byMaterial: Object.fromEntries(Object.entries(byMaterial).sort((a, b) => b[1] - a[1])),
    nonSerialStock,
    nonSerialTotal,
  };
}

router.get("/ipt-import/preview", requireAuth, requireRole(MANAGER), (req, res) => {
  res.json(buildPreview());
});

router.post("/ipt-import/commit", requireAuth, requireRole(MANAGER), (req, res) => {
  const preview = buildPreview();

  const tx = db.transaction(() => {
    if (!preview.customerExists) {
      const id = paddedSequenceId(db, "customers", "CUST", "id");
      db.prepare("INSERT INTO customers (id, name, status) VALUES (?, ?, 'Active')").run(id, CUSTOMER);
    }

    for (const areaName of preview.areasToCreate) {
      const code = paddedSequenceId(db, "areas", "AR");
      db.prepare("INSERT INTO areas (code, name, status) VALUES (?, ?, 'Active')").run(code, areaName);
    }

    for (const h of homebases) {
      if (preview.homebasesAlreadyExist.includes(h.name)) continue;
      const code = paddedSequenceId(db, "homebases", "HB");
      db.prepare(`INSERT INTO homebases (code, name, area, address, pic, phone, status) VALUES (?, ?, ?, ?, ?, ?, 'Active')`)
        .run(code, h.name, h.area, h.address || "", h.pic || "", h.phone || "");
    }

    for (const m of preview.materialsToCreate) {
      const id = paddedSequenceId(db, "materials", "MAT", "id");
      db.prepare(`INSERT INTO materials (id, name, category, unit, serialized, min_stock, status, ready, faulty, reserved, in_transit)
        VALUES (?, ?, ?, 'Unit', ?, 0, 'Active', 0, 0, 0, 0)`).run(id, m.name, m.category, m.serialized);
    }

    // INSERT OR IGNORE: any SN that already exists (checked in buildPreview,
    // but re-checked here by the DB itself as the actual guarantee) is
    // silently skipped rather than overwriting a real, already-tracked unit.
    const insertSn = db.prepare(`INSERT OR IGNORE INTO serial_numbers
      (sn, material, status, current_ref, received_date, received_ref, customer, installed_date, install_site, homebase)
      VALUES (@sn, @material, @status, NULL, @receivedDate, 'IMPORT-IPT', '${CUSTOMER}', @installedDate, @installSite, @homebase)`);
    let inserted = 0;
    for (const u of units) {
      const r = insertSn.run(u);
      if (r.changes) inserted += 1;
    }

    // Non-serialized materials: their Ready/Faulty quantities have no
    // serial_numbers rows to derive from, so set them directly. ON CONFLICT
    // makes this idempotent — re-running commit re-sets the same absolute
    // values rather than adding on top.
    const ensureStock = db.prepare("INSERT INTO material_stock (material, customer, ready, faulty, reserved, in_transit) VALUES (?, ?, 0, 0, 0, 0) ON CONFLICT(material, customer) DO NOTHING");
    const setStock = db.prepare("UPDATE material_stock SET ready = ?, faulty = ? WHERE material = ? AND customer = ?");
    Object.entries(nonSerialStock).forEach(([material, s]) => {
      ensureStock.run(material, CUSTOMER);
      setStock.run(s.ready, s.faulty, material, CUSTOMER);
    });

    // Serialized materials: resync material_stock.{ready,faulty} from
    // serial_numbers counts (Ready/Faulty only — Installed is deployed at a
    // site, not warehouse stock), same convention as the PIM import.
    const touchedSerialMaterials = [...new Set(units.map((u) => u.material))];
    const countByStatus = db.prepare("SELECT COUNT(*) AS n FROM serial_numbers WHERE customer = ? AND material = ? AND status = ?");
    touchedSerialMaterials.forEach((material) => {
      ensureStock.run(material, CUSTOMER);
      const ready = countByStatus.get(CUSTOMER, material, "Ready").n;
      const faulty = countByStatus.get(CUSTOMER, material, "Faulty").n;
      setStock.run(ready, faulty, material, CUSTOMER);
    });

    // Refresh the global materials.{ready,faulty} aggregate for every
    // touched material — its definition is "sum across every division".
    const touchedAll = new Set([...touchedSerialMaterials, ...Object.keys(nonSerialStock)]);
    const updateGlobal = db.prepare(`UPDATE materials SET
      ready = (SELECT COALESCE(SUM(ready), 0) FROM material_stock WHERE material = ?),
      faulty = (SELECT COALESCE(SUM(faulty), 0) FROM material_stock WHERE material = ?)
      WHERE name = ?`);
    touchedAll.forEach((m) => updateGlobal.run(m, m, m));

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

// --- Correction: IPT is not a separate division ---------------------------
// Turns out "IPT" isn't a real division distinct from "Teleglobal" — same
// business, the source spreadsheet just used a different name (confirmed by
// the user after seeing the import create a 5th division). This reassigns
// everything the import above created from customer='IPT' to
// customer='Teleglobal', merges non-serialized stock into whatever
// Teleglobal already has (adds, doesn't overwrite), resyncs serialized-
// material stock from serial_numbers the normal way, and removes the
// phantom "IPT" customer row. Areas/homebases are untouched — they're
// global, not per-division, so nothing to undo there. Safe to run even if
// the import was never committed (everything below is a no-op then).
function buildMergePreview() {
  const SOURCE = "IPT", TARGET = "Teleglobal";
  const sourceExists = !!db.prepare("SELECT 1 FROM customers WHERE name = ?").get(SOURCE);
  const unitsToReassign = db.prepare("SELECT COUNT(*) AS n FROM serial_numbers WHERE customer = ?").get(SOURCE).n;
  const sourceStock = db.prepare("SELECT material, ready, faulty, reserved, in_transit FROM material_stock WHERE customer = ?").all(SOURCE);
  const serializedSet = new Set(newMaterials.filter((m) => m.serialized).map((m) => m.name));
  const nonSerialRows = sourceStock.filter((r) => !serializedSet.has(r.material));
  return { sourceExists, unitsToReassign, nonSerialRows, source: SOURCE, target: TARGET };
}

router.get("/ipt-merge-into-teleglobal/preview", requireAuth, requireRole(MANAGER), (req, res) => {
  res.json(buildMergePreview());
});

router.post("/ipt-merge-into-teleglobal/commit", requireAuth, requireRole(MANAGER), (req, res) => {
  const SOURCE = "IPT", TARGET = "Teleglobal";
  const preview = buildMergePreview();

  const tx = db.transaction(() => {
    const reassigned = db.prepare("UPDATE serial_numbers SET customer = ? WHERE customer = ?").run(TARGET, SOURCE).changes;

    const ensureStock = db.prepare("INSERT INTO material_stock (material, customer, ready, faulty, reserved, in_transit) VALUES (?, ?, 0, 0, 0, 0) ON CONFLICT(material, customer) DO NOTHING");
    const addToTarget = db.prepare("UPDATE material_stock SET ready = ready + ?, faulty = faulty + ? WHERE material = ? AND customer = ?");
    for (const row of preview.nonSerialRows) {
      ensureStock.run(row.material, TARGET);
      addToTarget.run(row.ready, row.faulty, row.material, TARGET);
    }

    // Serialized materials: recompute Teleglobal's stock from serial_numbers
    // now that the reassignment above already moved the units over — this
    // naturally combines whatever Teleglobal already had with the merged-in
    // IPT units, no manual addition needed.
    const touchedSerialMaterials = [...new Set(units.map((u) => u.material))];
    const countByStatus = db.prepare("SELECT COUNT(*) AS n FROM serial_numbers WHERE customer = ? AND material = ? AND status = ?");
    const setStock = db.prepare("UPDATE material_stock SET ready = ?, faulty = ? WHERE material = ? AND customer = ?");
    touchedSerialMaterials.forEach((material) => {
      ensureStock.run(material, TARGET);
      const ready = countByStatus.get(TARGET, material, "Ready").n;
      const faulty = countByStatus.get(TARGET, material, "Faulty").n;
      setStock.run(ready, faulty, material, TARGET);
    });

    db.prepare("DELETE FROM material_stock WHERE customer = ?").run(SOURCE);
    db.prepare("DELETE FROM customers WHERE name = ?").run(SOURCE);

    const touchedAll = new Set([...touchedSerialMaterials, ...Object.keys(nonSerialStock)]);
    const updateGlobal = db.prepare(`UPDATE materials SET
      ready = (SELECT COALESCE(SUM(ready), 0) FROM material_stock WHERE material = ?),
      faulty = (SELECT COALESCE(SUM(faulty), 0) FROM material_stock WHERE material = ?)
      WHERE name = ?`);
    touchedAll.forEach((m) => updateGlobal.run(m, m, m));

    return reassigned;
  });

  let reassigned;
  try {
    reassigned = tx();
  } catch (err) {
    return res.status(500).json({ error: "Merge gagal: " + err.message });
  }

  res.json({ ok: true, reassigned, ...preview });
});

module.exports = router;
