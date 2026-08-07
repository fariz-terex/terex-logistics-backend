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
  const items = db.prepare("SELECT material, qty FROM delivery_items WHERE delivery_id = ?").all(id);
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

// Logistics approves: reserve stock (ready -> reserved), status -> Preparing.
// Wrapped in one transaction so a partial reservation can never happen.
router.post("/:id/approve", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
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

  const tx = db.transaction(() => {
    delivery.items.forEach((item) => {
      db.prepare("UPDATE materials SET ready = ready - ?, reserved = reserved + ? WHERE name = ?")
        .run(item.qty, item.qty, item.material);
    });
    db.prepare("UPDATE deliveries SET status = 'Preparing' WHERE id = ?").run(delivery.id);
    addHistory(delivery.id, `Approved by ${req.user.name} (Logistics) — stock direservasi`);
  });
  tx();

  res.json(loadDelivery(delivery.id));
});

router.post("/:id/reject", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const delivery = loadDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (delivery.status !== "Waiting Logistics Approval") {
    return res.status(409).json({ error: `Cannot reject a request with status "${delivery.status}"` });
  }
  db.prepare("UPDATE deliveries SET status = 'Rejected' WHERE id = ?").run(delivery.id);
  addHistory(delivery.id, `Rejected by ${req.user.name} (Logistics)`);
  res.json(loadDelivery(delivery.id));
});

// Advances Preparing -> Shipped -> Delivered. On Preparing->Shipped, moves
// reserved stock into transit and writes a stock movement row.
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
        const material = db.prepare("SELECT ready FROM materials WHERE name = ?").get(item.material);
        const movId = nextStockMovementId(db);
        db.prepare(`INSERT INTO stock_movements (id, date, material, qty, ref, remaining, type) VALUES (?, ?, ?, ?, ?, ?, 'Delivery')`)
          .run(movId, isoDate(), item.material, -item.qty, delivery.id, material.ready);
      });
    }
    db.prepare("UPDATE deliveries SET status = ? WHERE id = ?").run(next, delivery.id);
    addHistory(delivery.id, `Status diubah ke ${next} oleh ${req.user.name}`);
  });
  tx();

  res.json(loadDelivery(delivery.id));
});

module.exports = router;
