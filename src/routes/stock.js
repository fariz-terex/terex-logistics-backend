const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { dailySequenceId, isoDate, nextStockMovementId } = require("../utils/ids");
const { scopeOf, resolveCreateCustomer } = require("../utils/stock");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";
const LOGISTICS = "Logistics Staff";

router.get("/", requireAuth, (req, res) => {
  const scope = scopeOf(req.user);
  if (!scope) {
    const rows = db.prepare("SELECT * FROM materials ORDER BY name").all();
    return res.json(rows.map((r) => ({ ...r, serialized: !!r.serialized })));
  }
  if (scope.length === 0) {
    // Scoped but assigned to zero divisions — sees everything as zero,
    // not the same as Manager's "unscoped" case.
    const rows = db.prepare("SELECT id, name, category, unit, serialized, min_stock, status FROM materials ORDER BY name").all();
    return res.json(rows.map((r) => ({ ...r, serialized: !!r.serialized, ready: 0, faulty: 0, reserved: 0, in_transit: 0 })));
  }
  // Division-scoped: same shape as the global row, but quantities are
  // summed from material_stock across every division this user covers (0
  // when none of them has ever received the material).
  const placeholders = scope.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT m.id, m.name, m.category, m.unit, m.serialized, m.min_stock, m.status,
           COALESCE(SUM(ms.ready), 0) AS ready, COALESCE(SUM(ms.faulty), 0) AS faulty,
           COALESCE(SUM(ms.reserved), 0) AS reserved, COALESCE(SUM(ms.in_transit), 0) AS in_transit
    FROM materials m
    LEFT JOIN material_stock ms ON ms.material = m.name AND ms.customer IN (${placeholders})
    GROUP BY m.id
    ORDER BY m.name
  `).all(...scope);
  res.json(rows.map((r) => ({ ...r, serialized: !!r.serialized })));
});

router.get("/movements", requireAuth, (req, res) => {
  const { material } = req.query;
  const scope = scopeOf(req.user);
  let query = "SELECT * FROM stock_movements WHERE 1=1";
  const params = [];
  if (material) { query += " AND material = ?"; params.push(material); }
  if (scope) {
    if (scope.length === 0) return res.json([]);
    query += ` AND customer IN (${scope.map(() => "?").join(",")})`;
    params.push(...scope);
  }
  query += " ORDER BY id DESC";
  const rows = db.prepare(query).all(...params);

  // Stock movements only ever store a reference id (the Goods Receipt,
  // Delivery, or Return that caused them), not the individual units — so
  // look those units up the same way the rest of the app already links
  // them: Receipts mark `received_ref`, Deliveries/Returns mark
  // `current_ref` as they move a unit through its lifecycle.
  const withSerials = rows.map((m) => {
    const serials = db.prepare(
      "SELECT sn FROM serial_numbers WHERE material = ? AND (received_ref = ? OR current_ref = ?) ORDER BY sn"
    ).all(m.material, m.ref, m.ref).map((r) => r.sn);
    return { ...m, serials };
  });

  res.json(withSerials);
});

// Browse the serial number registry — used by Warehouse Stock (see which
// units make up a material's count) and by the Delivery approval screen
// (pick specific Ready units to reserve). A caller can pass `customer`
// explicitly (e.g. the delivery's own division when Logistics/Manager is
// picking SNs to fulfill it) — otherwise it defaults to the caller's own
// division(s), and Manager with no override sees everything.
router.get("/serials", requireAuth, (req, res) => {
  const { material, status, q, customer } = req.query;
  let query = "SELECT * FROM serial_numbers WHERE 1=1";
  const params = [];
  if (material) { query += " AND material = ?"; params.push(material); }
  if (status) { query += " AND status = ?"; params.push(status); }
  if (q) { query += " AND sn LIKE ?"; params.push(`%${q}%`); }

  if (customer !== undefined) {
    if (customer) { query += " AND customer = ?"; params.push(customer); }
  } else {
    const scope = scopeOf(req.user);
    if (scope) {
      if (scope.length === 0) return res.json([]);
      query += ` AND customer IN (${scope.map(() => "?").join(",")})`;
      params.push(...scope);
    }
  }

  query += " ORDER BY sn";
  if (q) query += " LIMIT 10"; // free-text search only — the SN-picker use case (material+status) needs the full list
  res.json(db.prepare(query).all(...params));
});

router.get("/receipts", requireAuth, (req, res) => {
  const scope = scopeOf(req.user);
  if (!scope) return res.json(db.prepare("SELECT * FROM receipts ORDER BY id DESC").all());
  if (scope.length === 0) return res.json([]);
  const rows = db.prepare(`SELECT * FROM receipts WHERE customer IN (${scope.map(() => "?").join(",")}) ORDER BY id DESC`).all(...scope);
  res.json(rows);
});

// Goods Receipt: the only place new stock (and new Serial Numbers) enters
// the warehouse. Serialized materials require one SN per unit; everything
// else is just a quantity. Wrapped in one transaction so the receipt record,
// the serial rows, the material total, and the stock movement can never
// partially apply.
router.post("/receipts", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { material, serials, qty, note } = req.body;
  const mat = db.prepare("SELECT * FROM materials WHERE name = ?").get(material);
  if (!mat) return res.status(400).json({ error: "Unknown material" });

  const resolved = resolveCreateCustomer(req.user, req.body.customer);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const customer = resolved.customer;

  const id = dailySequenceId(db, "receipts", "WR");
  let addedQty = 0;

  const tx = db.transaction(() => {
    if (mat.serialized) {
      if (!Array.isArray(serials) || serials.length === 0) throw new Error("Serial Number wajib diisi untuk material serialized");
      const seen = new Set();
      serials.forEach((raw) => {
        const sn = (raw || "").trim();
        if (!sn) throw new Error("Ada Serial Number kosong");
        if (seen.has(sn)) throw new Error(`Serial Number duplikat dalam penerimaan ini: ${sn}`);
        seen.add(sn);
        if (db.prepare("SELECT 1 FROM serial_numbers WHERE sn = ?").get(sn)) throw new Error(`Serial Number sudah terdaftar di sistem: ${sn}`);
      });
      const insertSn = db.prepare("INSERT INTO serial_numbers (sn, material, status, current_ref, received_date, received_ref, customer) VALUES (?, ?, 'Ready', NULL, ?, ?, ?)");
      serials.forEach((raw) => insertSn.run(raw.trim(), material, isoDate(), id, customer));
      addedQty = serials.length;
    } else {
      addedQty = Number(qty) || 0;
      if (addedQty <= 0) throw new Error("Qty harus lebih dari 0");
    }

    db.prepare("INSERT INTO receipts (id, date, material, qty, note, created_by, customer) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, isoDate(), material, addedQty, note || "", req.user.name, customer);

    db.prepare(`
      INSERT INTO material_stock (material, customer, ready) VALUES (?, ?, ?)
      ON CONFLICT(material, customer) DO UPDATE SET ready = ready + excluded.ready
    `).run(material, customer, addedQty);
    db.prepare("UPDATE materials SET ready = ready + ? WHERE name = ?").run(addedQty, material);

    const updated = db.prepare("SELECT ready FROM materials WHERE name = ?").get(material);
    const movId = nextStockMovementId(db);
    db.prepare(`INSERT INTO stock_movements (id, date, material, qty, ref, remaining, type, customer) VALUES (?, ?, ?, ?, ?, ?, 'Receipt', ?)`)
      .run(movId, isoDate(), material, addedQty, id, updated.ready, customer);
  });

  try {
    tx();
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }

  res.status(201).json({ id, material, qty: addedQty, serialized: !!mat.serialized, customer });
});

module.exports = router;
