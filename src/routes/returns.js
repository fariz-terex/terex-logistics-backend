const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { dailySequenceId, isoDate, nextStockMovementId } = require("../utils/ids");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";
const LOGISTICS = "Logistics Staff";
const TECH = "Technician";

const ACTIVE_RETURN_STATUSES = ["Waiting Logistics Review", "Revision Required", "Ready to Ship", "On Delivery", "Received by Warehouse", "QC Checking"];
const ACTIVE_RECON_STATUSES = ["Waiting Logistics Review", "Revision Required"];

// Same rule the front-end enforces client-side: a Serial Number cannot be
// active on more than one in-flight Return Faulty or Reconciliation at once.
function findSNConflict(sn, excludeReturnId = null) {
  const placeholders = ACTIVE_RETURN_STATUSES.map(() => "?").join(",");
  const returnHit = db.prepare(`
    SELECT r.id FROM return_serials rs
    JOIN return_items ri ON ri.id = rs.return_item_id
    JOIN returns r ON r.id = ri.return_id
    WHERE rs.sn = ? AND r.status IN (${placeholders}) AND r.id != ?
    LIMIT 1
  `).get(sn, ...ACTIVE_RETURN_STATUSES, excludeReturnId || "");
  if (returnHit) return `Return Faulty ${returnHit.id}`;

  const reconPlaceholders = ACTIVE_RECON_STATUSES.map(() => "?").join(",");
  const reconHit = db.prepare(`
    SELECT rc.id FROM reconciliation_serials rcs
    JOIN reconciliation_items rci ON rci.id = rcs.reconciliation_item_id
    JOIN reconciliations rc ON rc.id = rci.reconciliation_id
    WHERE rcs.sn = ? AND rc.status IN (${reconPlaceholders})
    LIMIT 1
  `).get(sn, ...ACTIVE_RECON_STATUSES);
  if (reconHit) return `Reconciliation ${reconHit.id}`;

  return null;
}

function loadReturn(id) {
  const ret = db.prepare("SELECT * FROM returns WHERE id = ?").get(id);
  if (!ret) return null;
  const items = db.prepare("SELECT * FROM return_items WHERE return_id = ?").all(id).map((item) => ({
    material: item.material,
    qty: item.qty,
    serials: db.prepare("SELECT sn, photo FROM return_serials WHERE return_item_id = ?").all(item.id),
  }));
  const history = db.prepare("SELECT time, text FROM return_history WHERE return_id = ? ORDER BY id").all(id);
  return {
    id: ret.id, technician: ret.technician, homebase: ret.homebase, site: ret.site,
    status: ret.status, date: ret.date, resiNumber: ret.resi_number, revisionNote: ret.revision_note,
    docs: { beforePacking: ret.doc_before, afterPacking: ret.doc_after, weighing: ret.doc_weighing },
    items, history,
  };
}

function addHistory(id, text) {
  db.prepare("INSERT INTO return_history (return_id, time, text) VALUES (?, ?, ?)").run(id, new Date().toISOString(), text);
}

router.get("/", requireAuth, (req, res) => {
  const ids = db.prepare("SELECT id FROM returns ORDER BY id DESC").all().map((r) => r.id);
  res.json(ids.map(loadReturn));
});

router.get("/:id", requireAuth, (req, res) => {
  const ret = loadReturn(req.params.id);
  if (!ret) return res.status(404).json({ error: "Return Faulty not found" });
  res.json(ret);
});

// Shared validation for create + resubmit: full docs, every item has a
// material/qty/serials, every SN filled with a photo, no duplicates within
// the whole submission (across items, not just within one), and no
// cross-transaction SN conflicts (except the transaction being edited).
function validateSubmission({ items, docs }, excludeReturnId) {
  if (!Array.isArray(items) || items.length === 0) return "Minimal satu material dengan Serial Number wajib diisi";
  if (!docs?.beforePacking || !docs?.afterPacking || !docs?.weighing) return "Foto sebelum packing, setelah packing, dan timbangan wajib diisi";
  const seen = new Set();
  for (const item of items) {
    if (!item.material || !item.qty || !Array.isArray(item.serials) || item.serials.length === 0) {
      return `Material, qty, dan Serial Number wajib diisi untuk ${item.material || "salah satu material"}`;
    }
    if (item.qty !== item.serials.length) {
      return `Jumlah Serial Number (${item.serials.length}) harus sama dengan qty (${item.qty}) untuk ${item.material}`;
    }
    for (const s of item.serials) {
      if (!s.sn?.trim() || !s.photo) return `Setiap Serial Number wajib diisi beserta fotonya (${item.material})`;
      const trimmed = s.sn.trim();
      if (seen.has(trimmed)) return `Serial Number duplikat dalam transaksi ini: ${trimmed}`;
      seen.add(trimmed);
      const conflict = findSNConflict(trimmed, excludeReturnId);
      if (conflict) return `Serial Number ${trimmed} sedang digunakan pada ${conflict}`;
    }
  }
  return null;
}

router.post("/", requireAuth, requireRole(TECH, MANAGER), (req, res) => {
  const err = validateSubmission(req.body, null);
  if (err) return res.status(409).json({ error: err });

  const { items, docs } = req.body;
  const id = dailySequenceId(db, "returns", "RF");
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO returns (id, technician, homebase, site, status, date, resi_number, doc_before, doc_after, doc_weighing) VALUES (?, ?, ?, ?, 'Waiting Logistics Review', ?, '', ?, ?, ?)`)
      .run(id, req.user.name, req.body.homebase || req.user.assignment || "", req.body.site || "", isoDate(), docs.beforePacking, docs.afterPacking, docs.weighing);
    const insertItem = db.prepare("INSERT INTO return_items (return_id, material, qty) VALUES (?, ?, ?)");
    const insertSerial = db.prepare("INSERT INTO return_serials (return_item_id, sn, photo) VALUES (?, ?, ?)");
    items.forEach((item) => {
      const itemId = insertItem.run(id, item.material, item.qty).lastInsertRowid;
      item.serials.forEach((s) => insertSerial.run(itemId, s.sn.trim(), s.photo));
    });
    addHistory(id, `Draft dibuat dan disubmit oleh Technician ${req.user.name}`);
  });
  tx();

  res.status(201).json(loadReturn(id));
});

router.post("/:id/approve", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const ret = db.prepare("SELECT * FROM returns WHERE id = ?").get(req.params.id);
  if (!ret) return res.status(404).json({ error: "Return Faulty not found" });
  if (ret.status !== "Waiting Logistics Review") return res.status(409).json({ error: `Cannot approve status "${ret.status}"` });
  db.prepare("UPDATE returns SET status = 'Ready to Ship' WHERE id = ?").run(ret.id);
  addHistory(ret.id, `Approved by ${req.user.name} (Logistics) — Ready to Ship`);
  res.json(loadReturn(ret.id));
});

router.post("/:id/revise", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { note } = req.body;
  if (!note?.trim()) return res.status(400).json({ error: "Revision note is required" });
  const ret = db.prepare("SELECT * FROM returns WHERE id = ?").get(req.params.id);
  if (!ret) return res.status(404).json({ error: "Return Faulty not found" });
  if (ret.status !== "Waiting Logistics Review") return res.status(409).json({ error: `Cannot request revision on status "${ret.status}"` });
  db.prepare("UPDATE returns SET status = 'Revision Required', revision_note = ? WHERE id = ?").run(note, ret.id);
  addHistory(ret.id, `Revision Required by ${req.user.name} (Logistics)`);
  res.json(loadReturn(ret.id));
});

// Technician fixes the flagged issues and resubmits — same validation as
// create, minus itself when checking for SN conflicts.
router.post("/:id/resubmit", requireAuth, requireRole(TECH, MANAGER), (req, res) => {
  const ret = db.prepare("SELECT * FROM returns WHERE id = ?").get(req.params.id);
  if (!ret) return res.status(404).json({ error: "Return Faulty not found" });
  if (ret.status !== "Revision Required") return res.status(409).json({ error: `Cannot resubmit status "${ret.status}"` });

  const err = validateSubmission(req.body, ret.id);
  if (err) return res.status(409).json({ error: err });

  const { items, docs } = req.body;
  const tx = db.transaction(() => {
    db.prepare("UPDATE returns SET status = 'Waiting Logistics Review', revision_note = NULL, doc_before = ?, doc_after = ?, doc_weighing = ? WHERE id = ?")
      .run(docs.beforePacking, docs.afterPacking, docs.weighing, ret.id);
    db.prepare("DELETE FROM return_items WHERE return_id = ?").run(ret.id); // cascades to serials
    const insertItem = db.prepare("INSERT INTO return_items (return_id, material, qty) VALUES (?, ?, ?)");
    const insertSerial = db.prepare("INSERT INTO return_serials (return_item_id, sn, photo) VALUES (?, ?, ?)");
    items.forEach((item) => {
      const itemId = insertItem.run(ret.id, item.material, item.qty).lastInsertRowid;
      item.serials.forEach((s) => insertSerial.run(itemId, s.sn.trim(), s.photo));
    });
    addHistory(ret.id, `Diperbaiki dan dikirim ulang oleh Technician ${req.user.name}`);
  });
  tx();

  res.json(loadReturn(ret.id));
});

router.post("/:id/ship", requireAuth, requireRole(TECH, MANAGER), (req, res) => {
  const ret = db.prepare("SELECT * FROM returns WHERE id = ?").get(req.params.id);
  if (!ret) return res.status(404).json({ error: "Return Faulty not found" });
  if (ret.status !== "Ready to Ship") return res.status(409).json({ error: `Cannot ship status "${ret.status}"` });
  db.prepare("UPDATE returns SET status = 'On Delivery' WHERE id = ?").run(ret.id);
  addHistory(ret.id, `Ditandai sudah dikirim oleh Technician ${req.user.name}`);
  res.json(loadReturn(ret.id));
});

router.post("/:id/resi", requireAuth, requireRole(TECH, MANAGER), (req, res) => {
  const { resiNumber } = req.body;
  if (!resiNumber?.trim()) return res.status(400).json({ error: "resiNumber is required" });
  const ret = db.prepare("SELECT * FROM returns WHERE id = ?").get(req.params.id);
  if (!ret) return res.status(404).json({ error: "Return Faulty not found" });
  db.prepare("UPDATE returns SET resi_number = ? WHERE id = ?").run(resiNumber, ret.id);
  addHistory(ret.id, `Resi ditambahkan: ${resiNumber}`);
  res.json(loadReturn(ret.id));
});

router.post("/:id/receive", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const ret = db.prepare("SELECT * FROM returns WHERE id = ?").get(req.params.id);
  if (!ret) return res.status(404).json({ error: "Return Faulty not found" });
  if (ret.status !== "On Delivery") return res.status(409).json({ error: `Cannot receive status "${ret.status}"` });
  db.prepare("UPDATE returns SET status = 'Received by Warehouse' WHERE id = ?").run(ret.id);
  addHistory(ret.id, `Received by Warehouse (${req.user.name})`);
  res.json(loadReturn(ret.id));
});

router.post("/:id/qc", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const ret = db.prepare("SELECT * FROM returns WHERE id = ?").get(req.params.id);
  if (!ret) return res.status(404).json({ error: "Return Faulty not found" });
  if (ret.status !== "Received by Warehouse") return res.status(409).json({ error: `Cannot QC status "${ret.status}"` });
  db.prepare("UPDATE returns SET status = 'QC Checking' WHERE id = ?").run(ret.id);
  addHistory(ret.id, `QC Checking selesai (${req.user.name})`);
  res.json(loadReturn(ret.id));
});

// Completing the return is the one step that actually touches warehouse
// stock: faulty qty goes up and a stock movement is logged, inside one
// transaction so the two never drift apart.
router.post("/:id/complete", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const ret = loadReturn(req.params.id);
  if (!ret) return res.status(404).json({ error: "Return Faulty not found" });
  if (ret.status !== "QC Checking") return res.status(409).json({ error: `Cannot complete status "${ret.status}"` });

  const tx = db.transaction(() => {
    ret.items.forEach((item) => {
      db.prepare("UPDATE materials SET faulty = faulty + ? WHERE name = ?").run(item.qty, item.material);
      const material = db.prepare("SELECT ready FROM materials WHERE name = ?").get(item.material);
      const movId = nextStockMovementId(db);
      db.prepare(`INSERT INTO stock_movements (id, date, material, qty, ref, remaining, type) VALUES (?, ?, ?, ?, ?, ?, 'Faulty Return')`)
        .run(movId, isoDate(), item.material, item.qty, ret.id, material.ready);

      // Fold the returned Serial Numbers into the registry as Faulty. If a
      // unit was already known (it went out through a Delivery earlier),
      // this closes the loop on it; if it's new to the system, it's
      // registered here for the first time.
      item.serials.forEach((s) => {
        const existing = db.prepare("SELECT 1 FROM serial_numbers WHERE sn = ?").get(s.sn);
        if (existing) {
          db.prepare("UPDATE serial_numbers SET status = 'Faulty', current_ref = ?, material = ? WHERE sn = ?").run(ret.id, item.material, s.sn);
        } else {
          db.prepare("INSERT INTO serial_numbers (sn, material, status, current_ref, received_date, received_ref) VALUES (?, ?, 'Faulty', ?, ?, NULL)")
            .run(s.sn, item.material, ret.id, isoDate());
        }
      });
    });
    db.prepare("UPDATE returns SET status = 'Completed' WHERE id = ?").run(ret.id);
    addHistory(ret.id, `Completed by ${req.user.name} — stock warehouse diperbarui`);
  });
  tx();

  res.json(loadReturn(ret.id));
});

module.exports = router;
