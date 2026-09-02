const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { paddedSequenceId, dailySequenceId, isoDate } = require("../utils/ids");
const { adjustConsumable } = require("../utils/stock");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";
const LOGISTICS = "Logistics Staff";

// Master Consumable — a shared, un-divisioned pool across every customer,
// same reasoning as Tools: connectors/isolasi/rubber etc. aren't owned by
// one division's stock the way Material is, so there's no per-division
// breakdown, no scoping by the requester's division, no customer field on
// receipts. Every authenticated user sees the same numbers.

router.get("/", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM consumables ORDER BY name").all());
});

router.post("/", requireAuth, requireRole(MANAGER), (req, res) => {
  const { name, category, unit, minStock } = req.body;
  if (!name || !category) return res.status(400).json({ error: "name and category are required" });
  const id = paddedSequenceId(db, "consumables", "CSM");
  db.prepare(`INSERT INTO consumables (id, name, category, unit, min_stock, status, ready, reserved, in_transit) VALUES (?, ?, ?, ?, ?, 'Active', 0, 0, 0)`)
    .run(id, name, category, unit || "Unit", minStock || 0);
  res.status(201).json(db.prepare("SELECT * FROM consumables WHERE id = ?").get(id));
});

router.patch("/:id/toggle-status", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM consumables WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Consumable not found" });
  const next = row.status === "Active" ? "Inactive" : "Active";
  db.prepare("UPDATE consumables SET status = ? WHERE id = ?").run(next, row.id);
  res.json(db.prepare("SELECT * FROM consumables WHERE id = ?").get(row.id));
});

router.post("/import", requireAuth, requireRole(MANAGER), (req, res) => {
  const rows = req.body.rows || [];
  const startCount = db.prepare("SELECT COUNT(*) AS n FROM consumables").get().n;
  const seenNames = new Set();
  const results = rows.map((r, idx) => {
    const errors = [];
    const name = (r.name || "").trim();
    if (!name) errors.push("Consumable Name kosong");
    else if (db.prepare("SELECT 1 FROM consumables WHERE name = ?").get(name)) errors.push("Consumable Name sudah ada");
    else if (seenNames.has(name.toLowerCase())) errors.push("Duplikat dalam file ini");
    if (!r.category) errors.push("Category kosong");
    seenNames.add(name.toLowerCase());
    return { name, category: r.category || "", unit: r.unit || "Unit", minStock: Number(r.minStock) || 0, status: r.status || "Active", errors, _seq: startCount + idx + 1 };
  });
  const insert = db.prepare(`INSERT INTO consumables (id, name, category, unit, min_stock, status, ready, reserved, in_transit) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)`);
  const tx = db.transaction((validRows) => validRows.forEach((r) => insert.run(`CSM${String(r._seq).padStart(3, "0")}`, r.name, r.category, r.unit, r.minStock, r.status)));
  const validRows = results.filter((r) => r.errors.length === 0);
  tx(validRows);
  res.json({ imported: validRows.length, total: results.length, results });
});

router.delete("/:id", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM consumables WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Consumable not found" });
  try {
    db.prepare("DELETE FROM consumables WHERE id = ?").run(row.id);
    res.json({ deleted: row.id });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY" || /FOREIGN KEY/i.test(err.message)) {
      return res.status(409).json({ error: "Tidak bisa dihapus — consumable ini sudah punya riwayat stock/transaksi" });
    }
    throw err;
  }
});
router.post("/bulk-delete", requireAuth, requireRole(MANAGER), (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length === 0) return res.status(400).json({ error: "Pilih minimal satu Consumable" });
  let deleted = 0;
  const blocked = [];
  const tx = db.transaction((list) => {
    list.forEach((id) => {
      try {
        const result = db.prepare("DELETE FROM consumables WHERE id = ?").run(id);
        deleted += result.changes;
      } catch (err) {
        if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY" || /FOREIGN KEY/i.test(err.message)) blocked.push(id);
        else throw err;
      }
    });
  });
  tx(ids);
  res.json({ deleted, blocked });
});

// ---------- Receipts (Terima Consumable) ----------
// No division/customer involved at all — same as Tools' receipts.

router.get("/receipts", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM consumable_receipts ORDER BY date DESC, id DESC").all());
});

router.post("/receipts", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { consumable, qty, note } = req.body;
  const item = db.prepare("SELECT * FROM consumables WHERE name = ?").get(consumable);
  if (!item) return res.status(400).json({ error: "Unknown consumable" });
  const addedQty = Number(qty);
  if (!addedQty || addedQty <= 0) return res.status(400).json({ error: "Qty harus lebih dari 0" });

  const id = dailySequenceId(db, "consumable_receipts", "CR");
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO consumable_receipts (id, date, consumable, qty, note, created_by, customer) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, isoDate(), consumable, addedQty, note || "", req.user.name, "");
    adjustConsumable(consumable, "ready", addedQty);
  });
  tx();

  res.status(201).json({ id, consumable, qty: addedQty });
});

module.exports = router;
