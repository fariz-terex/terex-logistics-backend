const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { dailySequenceId, isoDate, nextStockMovementId } = require("../utils/ids");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";
const LOGISTICS = "Logistics Staff";
const SPV = "SPV";

function loadDelivery(id) {
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id);
  if (!delivery) return null;
  const items = db.prepare("SELECT material, qty FROM delivery_items WHERE delivery_id = ?").all(id).map((item) => ({
    ...item,
    serials: db.prepare("SELECT sn, status FROM serial_numbers WHERE current_ref = ? AND material = ?").all(id, item.material).map((s) => s.sn),
  }));
  const history = db.prepare("SELECT time, text FROM delivery_history WHERE delivery_id = ? ORDER BY id").all(id);
  return { ...delivery, items, history };
}

function addHistory(id, text) {
  db.prepare("INSERT INTO delivery_history (delivery_id, time, text) VALUES (?, ?, ?)")
    .run(id, new Date().toISOString(), text);
}

router.get("/", requireAuth, (req, res) => {
  const ids = db.prepare("SELECT id FROM deliveries ORDER BY id DESC").all().map((r) => r.id);
  res.json(ids.map(loadDelivery));
});

router.get("/:id", requireAuth, (req, res) => {
  const delivery = loadDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  res.json(delivery);
});

// SPV (or Manager) submits a new request. Server re-validates stock
// sufficiency — the front-end UI check is a convenience, not the guarantee.
router.post("/", requireAuth, requireRole(SPV, MANAGER), (req, res) => {
  const { homebase, site, keperluan, note, items } = req.body;
  if (!homebase || !keperluan || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "homebase, keperluan, and at least one item are required" });
  }

  for (const item of items) {
    const material = db.prepare("SELECT ready FROM materials WHERE name = ?").get(item.material);
    if (!material) return res.status(400).json({ error: `Unknown material: ${item.material}` });
    if (item.qty > material.ready) {
      return res.status(409).json({ error: `Insufficient stock for ${item.material}: requested ${item.qty}, available ${material.ready}` });
    }
  }

  const id = dailySequenceId(db, "deliveries", "DR");
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO deliveries (id, requester, homebase, site, keperluan, note, status, date) VALUES (?, ?, ?, ?, ?, ?, 'Waiting Logistics Approval', ?)`)
      .run(id, req.user.name, homebase, site || "", keperluan, note || "", isoDate());
    const insertItem = db.prepare("INSERT INTO delivery_items (delivery_id, material, qty) VALUES (?, ?, ?)");
    items.forEach((i) => insertItem.run(id, i.material, i.qty));
    addHistory(id, `Dibuat dan disubmit oleh ${req.user.name} (${req.user.role})`);
  });
  tx();

  res.status(201).json(loadDelivery(id));
});

// Manager Logistics reviews and approves at the qty level only — no stock
// or Serial Numbers are touched here. This is a business decision ("do we
// fulfill this request at all"), separate from the operational question of
// exactly which physical units go out, which Logistics Staff decides next.
router.post("/:id/approve", requireAuth, requireRole(MANAGER), (req, res) => {
  const delivery = loadDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (delivery.status !== "Waiting Logistics Approval") {
    return res.status(409).json({ error: `Cannot approve a request with status "${delivery.status}"` });
  }

  for (const item of delivery.items) {
    const material = db.prepare("SELECT ready FROM materials WHERE name = ?").get(item.material);
    if (!material || item.qty > material.ready) {
      return res.status(409).json({ error: `Stock for ${item.material} changed and is no longer sufficient` });
    }
  }

  db.prepare("UPDATE deliveries SET status = 'Waiting Stock Assignment' WHERE id = ?").run(delivery.id);
  addHistory(delivery.id, `Approved by ${req.user.name} (Manager) — menunggu penugasan stock oleh Logistics Staff`);

  res.json(loadDelivery(delivery.id));
});

// Logistics Staff picks the specific units to fulfill an already-Approved
// request: reserve stock (ready -> reserved), status -> Preparing. For
// serialized materials, the caller picks exactly which units to reserve
// (serialSelections: { materialName: ["SN1","SN2"] }); if it omits a
// serialized material, the server falls back to auto-picking the oldest
// Ready units so this endpoint still works for older/simpler clients.
// Everything below is one transaction so a partial reservation can't happen.
router.post("/:id/assign-stock", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const delivery = loadDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (delivery.status !== "Waiting Stock Assignment") {
    return res.status(409).json({ error: `Cannot assign stock for a request with status "${delivery.status}"` });
  }

  const serialSelections = req.body?.serialSelections || {};

  const materialRows = {};
  for (const item of delivery.items) {
    const material = db.prepare("SELECT * FROM materials WHERE name = ?").get(item.material);
    if (!material || item.qty > material.ready) {
      return res.status(409).json({ error: `Stock for ${item.material} changed and is no longer sufficient` });
    }
    materialRows[item.material] = material;
  }

  // Pre-validate every serialized item's SN selection before touching the DB.
  for (const item of delivery.items) {
    if (!materialRows[item.material].serialized) continue;
    const chosen = serialSelections[item.material];
    if (chosen) {
      if (chosen.length !== item.qty) {
        return res.status(400).json({ error: `Pilih tepat ${item.qty} Serial Number untuk ${item.material} (dipilih: ${chosen.length})` });
      }
      const uniqueChosen = new Set(chosen);
      if (uniqueChosen.size !== chosen.length) {
        return res.status(400).json({ error: `Ada Serial Number terpilih dua kali untuk ${item.material}` });
      }
      for (const sn of chosen) {
        const row = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(sn);
        if (!row || row.material !== item.material || row.status !== "Ready") {
          return res.status(409).json({ error: `Serial Number ${sn} tidak tersedia (Ready) untuk ${item.material}` });
        }
      }
    } else {
      const available = db.prepare("SELECT COUNT(*) AS n FROM serial_numbers WHERE material = ? AND status = 'Ready'").get(item.material).n;
      if (available < item.qty) {
        return res.status(409).json({ error: `Serial Number Ready untuk ${item.material} tidak mencukupi (tersedia ${available}, butuh ${item.qty})` });
      }
    }
  }

  const tx = db.transaction(() => {
    delivery.items.forEach((item) => {
      db.prepare("UPDATE materials SET ready = ready - ?, reserved = reserved + ? WHERE name = ?")
        .run(item.qty, item.qty, item.material);

      if (materialRows[item.material].serialized) {
        const chosen = serialSelections[item.material]
          || db.prepare("SELECT sn FROM serial_numbers WHERE material = ? AND status = 'Ready' ORDER BY sn LIMIT ?").all(item.material, item.qty).map((r) => r.sn);
        const markReserved = db.prepare("UPDATE serial_numbers SET status = 'Reserved', current_ref = ? WHERE sn = ?");
        chosen.forEach((sn) => markReserved.run(delivery.id, sn));
      }
    });
    db.prepare("UPDATE deliveries SET status = 'Preparing' WHERE id = ?").run(delivery.id);
    addHistory(delivery.id, `Stock direservasi oleh ${req.user.name} (Logistics)`);
  });
  tx();

  res.json(loadDelivery(delivery.id));
});

router.post("/:id/reject", requireAuth, requireRole(MANAGER), (req, res) => {
  const delivery = loadDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (delivery.status !== "Waiting Logistics Approval") {
    return res.status(409).json({ error: `Cannot reject a request with status "${delivery.status}"` });
  }
  db.prepare("UPDATE deliveries SET status = 'Rejected' WHERE id = ?").run(delivery.id);
  addHistory(delivery.id, `Rejected by ${req.user.name} (Manager)`);
  res.json(loadDelivery(delivery.id));
});

// Advances Preparing -> Shipped -> Delivered.
// Preparing->Shipped: reserved stock moves into transit, matching SNs go
// Reserved -> In Transit, and a stock movement is logged.
// Shipped->Delivered: the units have left the warehouse for good, so
// in_transit is now cleared for them and their SNs move to a final
// "Delivered" state (previously in_transit was never cleared here — a gap
// fixed alongside this SN work since both track the same real-world fact).
router.post("/:id/advance", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const delivery = loadDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });

  const nextStatusMap = { Preparing: "Shipped", Shipped: "Delivered" };
  const next = nextStatusMap[delivery.status];
  if (!next) return res.status(409).json({ error: `Cannot advance a request with status "${delivery.status}"` });

  const tx = db.transaction(() => {
    if (delivery.status === "Preparing") {
      delivery.items.forEach((item) => {
        db.prepare("UPDATE materials SET reserved = reserved - ?, in_transit = in_transit + ? WHERE name = ?")
          .run(item.qty, item.qty, item.material);
        db.prepare("UPDATE serial_numbers SET status = 'In Transit' WHERE current_ref = ? AND material = ? AND status = 'Reserved'")
          .run(delivery.id, item.material);
        const material = db.prepare("SELECT ready FROM materials WHERE name = ?").get(item.material);
        const movId = nextStockMovementId(db);
        db.prepare(`INSERT INTO stock_movements (id, date, material, qty, ref, remaining, type) VALUES (?, ?, ?, ?, ?, ?, 'Delivery')`)
          .run(movId, isoDate(), item.material, -item.qty, delivery.id, material.ready);
      });
    } else if (delivery.status === "Shipped") {
      delivery.items.forEach((item) => {
        db.prepare("UPDATE materials SET in_transit = MAX(0, in_transit - ?) WHERE name = ?").run(item.qty, item.material);
        db.prepare("UPDATE serial_numbers SET status = 'Delivered' WHERE current_ref = ? AND material = ? AND status = 'In Transit'")
          .run(delivery.id, item.material);
      });
    }
    db.prepare("UPDATE deliveries SET status = ? WHERE id = ?").run(next, delivery.id);
    addHistory(delivery.id, `Status diubah ke ${next} oleh ${req.user.name}`);
  });
  tx();

  res.json(loadDelivery(delivery.id));
});

module.exports = router;
