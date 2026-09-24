const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { dailySequenceId, isoDate } = require("../utils/ids");
const { scopeOf, scopeAllows, resolveCreateCustomer } = require("../utils/stock");
const { homebaseSystemQtyMap, withSystemQty, applyApproval } = require("../utils/reconciliation");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";
const LOGISTICS = "Logistics Staff";
const TECH = "Technician";

const ACTIVE_RETURN_STATUSES = ["Waiting Logistics Review", "Revision Required", "Ready to Ship", "On Delivery", "Received by Warehouse", "QC Checking"];
const ACTIVE_RECON_STATUSES = ["Waiting Logistics Review", "Revision Required"];

function findSNConflict(sn, excludeReconId = null) {
  const returnPlaceholders = ACTIVE_RETURN_STATUSES.map(() => "?").join(",");
  const returnHit = db.prepare(`
    SELECT r.id FROM return_serials rs
    JOIN return_items ri ON ri.id = rs.return_item_id
    JOIN returns r ON r.id = ri.return_id
    WHERE rs.sn = ? AND r.status IN (${returnPlaceholders})
    LIMIT 1
  `).get(sn, ...ACTIVE_RETURN_STATUSES);
  if (returnHit) return `Return Faulty ${returnHit.id}`;

  const reconPlaceholders = ACTIVE_RECON_STATUSES.map(() => "?").join(",");
  const reconHit = db.prepare(`
    SELECT rc.id FROM reconciliation_serials rcs
    JOIN reconciliation_items rci ON rci.id = rcs.reconciliation_item_id
    JOIN reconciliations rc ON rc.id = rci.reconciliation_id
    WHERE rcs.sn = ? AND rc.status IN (${reconPlaceholders}) AND rc.id != ?
    LIMIT 1
  `).get(sn, ...ACTIVE_RECON_STATUSES, excludeReconId || "");
  if (reconHit) return `Reconciliation ${reconHit.id}`;

  return null;
}

function loadReconciliation(id) {
  const rc = db.prepare("SELECT * FROM reconciliations WHERE id = ?").get(id);
  if (!rc) return null;
  const items = db.prepare("SELECT * FROM reconciliation_items WHERE reconciliation_id = ?").all(id).map((item) => ({
    material: item.material,
    serialized: !!item.serialized,
    systemQty: item.system_qty,
    actualQty: item.actual_qty,
    reason: item.reason,
    serials: item.serialized ? db.prepare("SELECT sn FROM reconciliation_serials WHERE reconciliation_item_id = ?").all(item.id).map((s) => s.sn) : [],
  }));
  const history = db.prepare("SELECT time, text FROM reconciliation_history WHERE reconciliation_id = ? ORDER BY id").all(id);
  // `photo` is ONE photo for the whole reconciliation (all materials
  // together in one frame), not per item — see reconciliations.photo.
  return { id: rc.id, homebase: rc.homebase, period: rc.period, status: rc.status, date: rc.date, revisionNote: rc.revision_note, customer: rc.customer, photo: rc.photo, reason: rc.reason || "", items, history };
}

function addHistory(id, text) {
  db.prepare("INSERT INTO reconciliation_history (reconciliation_id, time, text) VALUES (?, ?, ?)").run(id, new Date().toISOString(), text);
}

router.get("/", requireAuth, (req, res) => {
  const scope = scopeOf(req.user);
  let ids;
  if (!scope) {
    ids = db.prepare("SELECT id FROM reconciliations ORDER BY id DESC").all().map((r) => r.id);
  } else if (scope.length === 0) {
    ids = [];
  } else {
    ids = db.prepare(`SELECT id FROM reconciliations WHERE customer IN (${scope.map(() => "?").join(",")}) ORDER BY id DESC`).all(...scope).map((r) => r.id);
  }
  res.json(ids.map(loadReconciliation));
});

// System Qty per material for one homebase — what the create form shows
// (read-only) next to Actual Qty. See utils/reconciliation.js for what
// "system" means here (homebase stock, not warehouse Ready).
router.get("/system-qty", requireAuth, (req, res) => {
  const { customer, homebase } = req.query;
  if (!customer || !homebase) return res.status(400).json({ error: "customer and homebase are required" });
  if (!scopeAllows(scopeOf(req.user), customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });
  res.json(homebaseSystemQtyMap(db, customer, homebase));
});

router.get("/:id", requireAuth, (req, res) => {
  const rc = loadReconciliation(req.params.id);
  if (!rc) return res.status(404).json({ error: "Reconciliation not found" });
  if (!scopeAllows(scopeOf(req.user), rc.customer)) return res.status(403).json({ error: "Reconciliation ini bukan milik divisi Anda" });
  res.json(rc);
});

// `reason` is the one reconciliation-level explanation; an item's own
// reason (older clients) also satisfies it.
function validateItems(items, excludeReconId, reason) {
  // The same physical unit can't be counted twice in one reconciliation.
  const seen = new Set();
  for (const item of items) {
    for (const sn of item.serials || []) {
      const key = sn?.trim().toUpperCase();
      if (!key) continue;
      if (seen.has(key)) return `Serial Number ${sn.trim()} tercatat lebih dari sekali`;
      seen.add(key);
    }
  }
  for (const item of items) {
    if (item.systemQty !== item.actualQty && !item.reason?.trim() && !reason?.trim()) return `Alasan discrepancy wajib diisi (selisih pada ${item.material})`;
    if (item.serialized) {
      const serials = item.serials || [];
      if (serials.some((s) => !s?.trim())) return `Semua Serial Number wajib diisi untuk ${item.material}`;
      for (const sn of serials) {
        const conflict = findSNConflict(sn.trim(), excludeReconId);
        if (conflict) return `Serial Number ${sn} sedang digunakan pada ${conflict}`;
      }
    }
  }
  return null;
}

function writeItems(reconId, items) {
  const insertItem = db.prepare(`INSERT INTO reconciliation_items (reconciliation_id, material, serialized, system_qty, actual_qty, reason) VALUES (?, ?, ?, ?, ?, ?)`);
  const insertSerial = db.prepare("INSERT INTO reconciliation_serials (reconciliation_item_id, sn) VALUES (?, ?)");
  items.forEach((item) => {
    const itemId = insertItem.run(reconId, item.material, item.serialized ? 1 : 0, item.systemQty, item.actualQty, item.reason || "").lastInsertRowid;
    (item.serials || []).forEach((sn) => insertSerial.run(itemId, sn.trim()));
  });
}

// The report is credited to the reporting technician's own division;
// Manager (unscoped) must say explicitly which division it's for.
router.post("/", requireAuth, requireRole(TECH, MANAGER), (req, res) => {
  const { homebase, period, photo } = req.body;
  if (!homebase || !period || !Array.isArray(req.body.items) || req.body.items.length === 0) {
    return res.status(400).json({ error: "homebase, period, and at least one item are required" });
  }
  if (!photo) return res.status(400).json({ error: "Foto keseluruhan material wajib" });

  const resolved = resolveCreateCustomer(req.user, req.body.customer);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const customer = resolved.customer;

  const items = withSystemQty(db, req.body.items, customer, homebase);
  const reason = (req.body.reason || "").trim();
  const err = validateItems(items, null, reason);
  if (err) return res.status(409).json({ error: err });

  const id = dailySequenceId(db, "reconciliations", "RC");
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO reconciliations (id, homebase, period, status, date, customer, photo, reason) VALUES (?, ?, ?, 'Waiting Logistics Review', ?, ?, ?, ?)`).run(id, homebase, period, isoDate(), customer, photo, reason);
    writeItems(id, items);
    addHistory(id, `Draft dibuat dan disubmit oleh Technician ${req.user.name}`);
  });
  tx();

  res.status(201).json(loadReconciliation(id));
});

router.post("/:id/revise", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { note } = req.body;
  if (!note?.trim()) return res.status(400).json({ error: "Revision note is required" });
  const rc = db.prepare("SELECT * FROM reconciliations WHERE id = ?").get(req.params.id);
  if (!rc) return res.status(404).json({ error: "Reconciliation not found" });
  if (!scopeAllows(scopeOf(req.user), rc.customer)) return res.status(403).json({ error: "Reconciliation ini bukan milik divisi Anda" });
  if (rc.status !== "Waiting Logistics Review") return res.status(409).json({ error: `Cannot request revision on status "${rc.status}"` });
  db.prepare("UPDATE reconciliations SET status = 'Revision Required', revision_note = ? WHERE id = ?").run(note, rc.id);
  addHistory(rc.id, `Revision Required by ${req.user.name} (Logistics)`);
  res.json(loadReconciliation(rc.id));
});

router.post("/:id/resubmit", requireAuth, requireRole(TECH, MANAGER), (req, res) => {
  const rc = db.prepare("SELECT * FROM reconciliations WHERE id = ?").get(req.params.id);
  if (!rc) return res.status(404).json({ error: "Reconciliation not found" });
  if (!scopeAllows(scopeOf(req.user), rc.customer)) return res.status(403).json({ error: "Reconciliation ini bukan milik divisi Anda" });
  if (rc.status !== "Revision Required") return res.status(409).json({ error: `Cannot resubmit status "${rc.status}"` });

  const { photo } = req.body;
  if (!Array.isArray(req.body.items) || req.body.items.length === 0) return res.status(400).json({ error: "items are required" });
  if (!photo) return res.status(400).json({ error: "Foto keseluruhan material wajib" });
  const items = withSystemQty(db, req.body.items, rc.customer, rc.homebase);
  const reason = (req.body.reason || "").trim();
  const err = validateItems(items, rc.id, reason);
  if (err) return res.status(409).json({ error: err });

  const tx = db.transaction(() => {
    db.prepare("UPDATE reconciliations SET status = 'Waiting Logistics Review', revision_note = NULL, photo = ?, reason = ? WHERE id = ?").run(photo, reason, rc.id);
    db.prepare("DELETE FROM reconciliation_items WHERE reconciliation_id = ?").run(rc.id); // cascades to serials
    writeItems(rc.id, items);
    addHistory(rc.id, `Diperbaiki dan dikirim ulang oleh Technician ${req.user.name}`);
  });
  tx();

  res.json(loadReconciliation(rc.id));
});

// Approving is the step that matters for inventory: discrepancy != 0 per
// item adjusts the reconciliation's HOMEBASE stock (not warehouse Ready) and
// becomes a stock_movements row — but only here, after explicit review, per
// the "no silent stock changes" rule. Details in utils/reconciliation.js.
router.post("/:id/approve", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const rc = loadReconciliation(req.params.id);
  if (!rc) return res.status(404).json({ error: "Reconciliation not found" });
  if (!scopeAllows(scopeOf(req.user), rc.customer)) return res.status(403).json({ error: "Reconciliation ini bukan milik divisi Anda" });
  if (rc.status !== "Waiting Logistics Review") return res.status(409).json({ error: `Cannot approve status "${rc.status}"` });

  const notes = applyApproval(db, rc);
  addHistory(rc.id, `Approved by ${req.user.name} (Logistics)${notes.length ? " — stock homebase disesuaikan" : ""}`);
  notes.forEach((n) => addHistory(rc.id, n));
  addHistory(rc.id, "Completed");

  res.json(loadReconciliation(rc.id));
});

module.exports = router;
