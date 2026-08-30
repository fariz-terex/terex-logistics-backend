const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { dailySequenceId, isoDate, nextStockMovementId } = require("../utils/ids");
const { scopeOf, scopeAllows, scopeClause, resolveCreateCustomer, adjustStock } = require("../utils/stock");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";
const LOGISTICS = "Logistics Staff";

router.get("/", requireAuth, (req, res) => {
  const { customer: customerOverride } = req.query;
  const scope = scopeOf(req.user);

  // An explicit override is for forms that need ONE division's real
  // numbers instead of a global/summed total — e.g. Manager (unscoped, so
  // normally sees the grand total across every division) picking materials
  // for a Delivery Request they're creating on behalf of a specific
  // division. Showing the aggregate there is actively misleading: it can
  // show "18 available" while the actual division being requested for has
  // zero, which only surfaces as a confusing "insufficient stock" error at
  // submit time. Still respects scope — a scoped user can't peek at a
  // division that isn't theirs.
  if (customerOverride) {
    if (scope && !scope.includes(customerOverride)) {
      return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });
    }
    const rows = db.prepare(`
      SELECT m.id, m.name, m.category, m.unit, m.serialized, m.min_stock, m.status,
             COALESCE(ms.ready, 0) AS ready, COALESCE(ms.faulty, 0) AS faulty,
             COALESCE(ms.reserved, 0) AS reserved, COALESCE(ms.in_transit, 0) AS in_transit
      FROM materials m
      LEFT JOIN material_stock ms ON ms.material = m.name AND ms.customer = ?
      ORDER BY m.name
    `).all(customerOverride);
    return res.json(rows.map((r) => ({ ...r, serialized: !!r.serialized })));
  }

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
  // `onlyWithHistory=1` is used specifically by the Warehouse Stock page —
  // it hides materials that have never had a single material_stock row for
  // any of this user's divisions (never received/requested there before),
  // which is just catalog noise from other divisions' materials on that
  // page. Everywhere else that reads this endpoint — the Delivery Request
  // material picker above all — needs the FULL catalog regardless of
  // history, since requesting a material for the very first time is a
  // completely normal thing to do and must not be hidden.
  const joinType = req.query.onlyWithHistory === "1" ? "INNER JOIN" : "LEFT JOIN";
  const rows = db.prepare(`
    SELECT m.id, m.name, m.category, m.unit, m.serialized, m.min_stock, m.status,
           COALESCE(SUM(ms.ready), 0) AS ready, COALESCE(SUM(ms.faulty), 0) AS faulty,
           COALESCE(SUM(ms.reserved), 0) AS reserved, COALESCE(SUM(ms.in_transit), 0) AS in_transit
    FROM materials m
    ${joinType} material_stock ms ON ms.material = m.name AND ms.customer IN (${placeholders})
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
  const { material, status, q, customer, homebase } = req.query;
  let query = "SELECT * FROM serial_numbers WHERE 1=1";
  const params = [];
  if (material) { query += " AND material = ?"; params.push(material); }
  if (status) { query += " AND status = ?"; params.push(status); }
  if (homebase) { query += " AND homebase = ?"; params.push(homebase); }
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

// ===================== TRANSFER STOK ANTAR HOMEBASE =====================
// Warehouse-operations feature (Logistics/Manager only) — moves already-
// Delivered stock from one homebase's inventory to another's within the
// same division. Never touches material_stock (the division-level total is
// unaffected by moving stock between homebases inside that same division)
// or a delivery's own records — this is purely a relocation, layered on
// top of what Delivery Request already tracks.

// Per-homebase breakdown for one material+division — what the transfer
// form needs to know how much is available to move FROM each homebase.
router.get("/transfer-options", requireAuth, (req, res) => {
  const { material, customer } = req.query;
  if (!material || !customer) return res.status(400).json({ error: "material and customer are required" });
  const scope = scopeOf(req.user);
  if (!scopeAllows(scope, customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });

  const mat = db.prepare("SELECT * FROM materials WHERE name = ?").get(material);
  if (!mat) return res.status(404).json({ error: "Material not found" });

  if (mat.serialized) {
    const rows = db.prepare(`
      SELECT homebase, COUNT(*) AS qty FROM serial_numbers
      WHERE material = ? AND customer = ? AND status = 'Delivered' AND homebase IS NOT NULL
      GROUP BY homebase HAVING qty > 0 ORDER BY homebase
    `).all(material, customer);
    return res.json({ serialized: true, breakdown: rows });
  }
  const rows = db.prepare(`
    SELECT homebase, qty FROM material_stock_homebase
    WHERE material = ? AND customer = ? AND qty > 0 ORDER BY homebase
  `).all(material, customer);
  res.json({ serialized: false, breakdown: rows });
});

router.get("/transfers", requireAuth, (req, res) => {
  const scope = scopeOf(req.user);
  let rows;
  if (!scope) {
    rows = db.prepare("SELECT * FROM stock_transfers ORDER BY date DESC, id DESC").all();
  } else if (scope.length === 0) {
    rows = [];
  } else {
    rows = db.prepare(`SELECT * FROM stock_transfers WHERE ${scopeClause("customer", scope).sql} ORDER BY date DESC, id DESC`).all(...scope);
  }
  const withSerials = rows.map((r) => ({
    ...r,
    serials: db.prepare("SELECT sn FROM stock_transfer_serials WHERE transfer_id = ?").all(r.id).map((s) => s.sn),
  }));
  res.json(withSerials);
});

router.post("/transfers", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { material, customer, homebaseFrom, homebaseTo, qty, serials, note } = req.body || {};
  if (!material || !customer || !homebaseFrom || !homebaseTo) {
    return res.status(400).json({ error: "material, customer, homebaseFrom, homebaseTo are required" });
  }
  if (homebaseFrom === homebaseTo) return res.status(400).json({ error: "Homebase asal dan tujuan tidak boleh sama" });
  const scope = scopeOf(req.user);
  if (!scopeAllows(scope, customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });

  const mat = db.prepare("SELECT * FROM materials WHERE name = ?").get(material);
  if (!mat) return res.status(404).json({ error: "Material not found" });

  const id = dailySequenceId(db, "stock_transfers", "TR");
  const date = isoDate();

  const tx = db.transaction(() => {
    let finalQty;
    if (mat.serialized) {
      if (!Array.isArray(serials) || serials.length === 0) throw new Error("Pilih minimal satu Serial Number untuk dipindahkan");
      finalQty = serials.length;
      const rows = serials.map((sn) => db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(sn));
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.material !== material || row.customer !== customer || row.status !== "Delivered" || row.homebase !== homebaseFrom) {
          throw new Error(`Serial Number ${serials[i]} tidak tersedia di homebase ${homebaseFrom}`);
        }
      }
      const update = db.prepare("UPDATE serial_numbers SET homebase = ? WHERE sn = ?");
      serials.forEach((sn) => update.run(homebaseTo, sn));
    } else {
      finalQty = Number(qty);
      if (!finalQty || finalQty <= 0) throw new Error("Qty harus lebih dari 0");
      const source = db.prepare("SELECT qty FROM material_stock_homebase WHERE material = ? AND customer = ? AND homebase = ?").get(material, customer, homebaseFrom);
      if (!source || source.qty < finalQty) throw new Error(`Stock ${material} di ${homebaseFrom} tidak cukup (tersedia: ${source ? source.qty : 0})`);
      db.prepare("UPDATE material_stock_homebase SET qty = qty - ? WHERE material = ? AND customer = ? AND homebase = ?").run(finalQty, material, customer, homebaseFrom);
      db.prepare(`
        INSERT INTO material_stock_homebase (material, customer, homebase, qty) VALUES (?, ?, ?, ?)
        ON CONFLICT(material, customer, homebase) DO UPDATE SET qty = qty + excluded.qty
      `).run(material, customer, homebaseTo, finalQty);
    }

    db.prepare("INSERT INTO stock_transfers (id, material, customer, homebase_from, homebase_to, qty, performed_by, date, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, material, customer, homebaseFrom, homebaseTo, finalQty, req.user.name, date, note || "");
    if (mat.serialized) {
      const insertSerial = db.prepare("INSERT INTO stock_transfer_serials (transfer_id, sn) VALUES (?, ?)");
      serials.forEach((sn) => insertSerial.run(id, sn));
    }
  });

  try {
    tx();
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }

  res.status(201).json({
    id, material, customer, homebaseFrom, homebaseTo, date,
    serials: mat.serialized ? serials : [],
  });
});

// ================= FAULTY -> SENT TO CUSTOMER -> READY CYCLE =================
// A Faulty unit can be shipped onward to the customer's own facility for
// them to repair, then eventually comes back and rejoins Ready stock. Each
// round trip is its own row in faulty_customer_returns — a unit can cycle
// through this more than once over its life.

router.get("/serials/:sn/customer-return-history", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM faulty_customer_returns WHERE sn = ? ORDER BY sent_date DESC, id DESC").all(req.params.sn);
  res.json(rows);
});

router.post("/serials/:sn/send-to-customer", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { ref, note } = req.body || {};
  if (!ref || !ref.trim()) return res.status(400).json({ error: "Nomor surat/BA wajib diisi" });
  const row = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(req.params.sn);
  if (!row) return res.status(404).json({ error: "Serial Number not found" });
  if (row.status !== "Faulty") return res.status(409).json({ error: `Unit ini berstatus "${row.status}", harus Faulty untuk dikirim ke customer` });
  const scope = scopeOf(req.user);
  if (!scopeAllows(scope, row.customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });

  const id = dailySequenceId(db, "faulty_customer_returns", "FCR");
  const date = isoDate();
  const tx = db.transaction(() => {
    db.prepare("UPDATE serial_numbers SET status = 'Sent to Customer' WHERE sn = ?").run(row.sn);
    db.prepare(`
      INSERT INTO faulty_customer_returns (id, sn, material, customer, sent_date, sent_ref, sent_by, sent_note, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Sent')
    `).run(id, row.sn, row.material, row.customer, date, ref.trim(), req.user.name, note || "");
  });
  tx();
  res.status(201).json({ id, sn: row.sn, status: "Sent to Customer" });
});

router.post("/serials/:sn/receive-from-customer", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { ref, note } = req.body || {};
  if (!ref || !ref.trim()) return res.status(400).json({ error: "Nomor surat/BA wajib diisi" });
  const row = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(req.params.sn);
  if (!row) return res.status(404).json({ error: "Serial Number not found" });
  if (row.status !== "Sent to Customer") return res.status(409).json({ error: `Unit ini berstatus "${row.status}", harus "Sent to Customer" untuk diterima kembali` });
  const scope = scopeOf(req.user);
  if (!scopeAllows(scope, row.customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });

  const openCycle = db.prepare("SELECT * FROM faulty_customer_returns WHERE sn = ? AND status = 'Sent' ORDER BY sent_date DESC, id DESC LIMIT 1").get(row.sn);
  if (!openCycle) return res.status(409).json({ error: "Tidak ditemukan catatan pengiriman ke customer yang masih terbuka untuk unit ini" });
  if (ref.trim() === openCycle.sent_ref) return res.status(400).json({ error: "Nomor surat penerimaan harus berbeda dari nomor surat pengiriman sebelumnya" });

  const date = isoDate();
  const tx = db.transaction(() => {
    db.prepare("UPDATE serial_numbers SET status = 'Ready' WHERE sn = ?").run(row.sn);
    db.prepare(`
      UPDATE faulty_customer_returns
      SET received_date = ?, received_ref = ?, received_by = ?, received_note = ?, status = 'Received'
      WHERE id = ?
    `).run(date, ref.trim(), req.user.name, note || "", openCycle.id);
    adjustStock(row.material, row.customer, "faulty", -1);
    adjustStock(row.material, row.customer, "ready", 1);
  });
  tx();
  res.json({ id: openCycle.id, sn: row.sn, status: "Ready" });
});

module.exports = router;
