const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { paddedSequenceId, dailySequenceId, isoDate } = require("../utils/ids");
const { scopeOf, scopeAllows, resolveCreateCustomer, adjustConsumableStock } = require("../utils/stock");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";
const LOGISTICS = "Logistics Staff";

// Master Consumable — CRUD, mirrors Master Material but with no
// "serialized" concept (consumables are never individually tracked).

router.get("/", requireAuth, (req, res) => {
  const scope = scopeOf(req.user);

  // Mirrors /api/stock's `customer` override: Manager (unscoped) picking a
  // division in the Delivery Request form needs THAT division's real
  // numbers, not the grand total across every division — same reasoning
  // as materials, just for the separate consumables tables.
  const { customer: customerOverride } = req.query;
  if (customerOverride) {
    if (scope && !scopeAllows(scope, customerOverride)) {
      return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });
    }
    const rows = db.prepare(`
      SELECT c.id, c.name, c.category, c.unit, c.min_stock, c.status,
             COALESCE(cs.ready, 0) AS ready, COALESCE(cs.reserved, 0) AS reserved, COALESCE(cs.in_transit, 0) AS in_transit
      FROM consumables c
      LEFT JOIN consumable_stock cs ON cs.consumable = c.name AND cs.customer = ?
      ORDER BY c.name
    `).all(customerOverride);
    return res.json(rows);
  }

  if (!scope) {
    return res.json(db.prepare("SELECT * FROM consumables ORDER BY name").all());
  }
  if (scope.length === 0) {
    const rows = db.prepare("SELECT id, name, category, unit, min_stock, status FROM consumables ORDER BY name").all();
    return res.json(rows.map((r) => ({ ...r, ready: 0, reserved: 0, in_transit: 0 })));
  }
  const placeholders = scope.map(() => "?").join(",");
  const joinType = req.query.onlyWithHistory === "1" ? "INNER JOIN" : "LEFT JOIN";
  const rows = db.prepare(`
    SELECT c.id, c.name, c.category, c.unit, c.min_stock, c.status,
           COALESCE(SUM(cs.ready), 0) AS ready, COALESCE(SUM(cs.reserved), 0) AS reserved, COALESCE(SUM(cs.in_transit), 0) AS in_transit
    FROM consumables c
    ${joinType} consumable_stock cs ON cs.consumable = c.name AND cs.customer IN (${placeholders})
    GROUP BY c.id
    ORDER BY c.name
  `).all(...scope);
  res.json(rows);
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

router.get("/receipts", requireAuth, (req, res) => {
  const scope = scopeOf(req.user);
  if (!scope) return res.json(db.prepare("SELECT * FROM consumable_receipts ORDER BY date DESC, id DESC").all());
  if (scope.length === 0) return res.json([]);
  const placeholders = scope.map(() => "?").join(",");
  res.json(db.prepare(`SELECT * FROM consumable_receipts WHERE customer IN (${placeholders}) ORDER BY date DESC, id DESC`).all(...scope));
});

router.post("/receipts", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { consumable, qty, note } = req.body;
  const resolved = resolveCreateCustomer(req.user, req.body.customer);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const customer = resolved.customer;

  const item = db.prepare("SELECT * FROM consumables WHERE name = ?").get(consumable);
  if (!item) return res.status(400).json({ error: "Unknown consumable" });
  const addedQty = Number(qty);
  if (!addedQty || addedQty <= 0) return res.status(400).json({ error: "Qty harus lebih dari 0" });

  const id = dailySequenceId(db, "consumable_receipts", "CR");
  const tx = db.transaction(() => {
    db.prepare("INSERT INTO consumable_receipts (id, date, consumable, qty, note, created_by, customer) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, isoDate(), consumable, addedQty, note || "", req.user.name, customer);
    adjustConsumableStock(consumable, customer, "ready", addedQty);
  });
  tx();

  res.status(201).json({ id, consumable, qty: addedQty, customer });
});

module.exports = router;
