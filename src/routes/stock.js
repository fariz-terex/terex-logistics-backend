const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { dailySequenceId, isoDate, nextStockMovementId } = require("../utils/ids");
const { scopeOf, scopeAllows, scopeClause, resolveCreateCustomer, adjustStock } = require("../utils/stock");
const { sendToCustomer, receiveFromCustomer } = require("../utils/faultyCycle");
const { createTransferRequest, approveTransfer, rejectTransfer, cancelTransfer } = require("../utils/stockTransfers");
const { notifyWebhook } = require("../utils/webhook");
const { computeStockConsistency, planGlobalAggregateRebuild, planSerialBucketRebuild, planInstalledStatusFix } = require("../utils/stockConsistency");
const { parseBkbDocument } = require("../utils/bkbParser");
const { detectMaterialsFromPhotos, readSerialsFromPhoto } = require("../utils/materialPhotoDetector");
const { storePhoto, storePhotos, discardPhotos, photoUrl } = require("../utils/photos");

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
    // Same `onlyWithHistory` support as the scoped branch further down —
    // this branch was missing it entirely, so Warehouse Stock's division
    // filter (which always passes onlyWithHistory=1) silently ignored it
    // here and fell back to LEFT JOIN's "show everything, zeros included".
    const joinType = req.query.onlyWithHistory === "1" ? "INNER JOIN" : "LEFT JOIN";
    const rows = db.prepare(`
      SELECT m.id, m.name, m.category, m.unit, m.serialized, m.min_stock, m.status,
             COALESCE(ms.ready, 0) AS ready, COALESCE(ms.faulty, 0) AS faulty,
             COALESCE(ms.reserved, 0) AS reserved, COALESCE(ms.in_transit, 0) AS in_transit
      FROM materials m
      ${joinType} material_stock ms ON ms.material = m.name AND ms.customer = ?
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

// Dashboard breakdown: per-cluster (for divisions that use clusters — PIM)
// or per-homebase (everyone else) counts of on-hand and faulty serialized
// units, plus the division-level totals the summary cards show. All derived
// from serial_numbers, so it only covers serialized materials (non-serialized
// have no per-unit location) — that's an intentional, agreed limitation.
//
// Location semantics, straight from how the delivery flow fills these:
//   - Ready units live at the central warehouse; their homebase is NULL until
//     a delivery is completed (then status flips to Delivered + homebase set).
//   - So "on-hand at homebase X" = Delivered units whose homebase = X.
//   - Ready units (homebase NULL) are grouped under a "Warehouse Pusat" card.
//   - For PIM, cluster is set at Goods Receipt and is always present, so its
//     breakdown is by cluster and includes Ready units directly.
router.get("/dashboard-breakdown", requireAuth, (req, res) => {
  const scope = scopeOf(req.user);
  // Unscoped Manager may target one division via ?customer=; scoped users are
  // pinned to their own. Default: first division in scope.
  let customer = req.query.customer;
  if (scope) {
    if (scope.length === 0) return res.json({ customer: null, mode: "none", totals: emptyTotals(), groups: [] });
    if (customer && !scope.includes(customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });
    if (!customer) customer = scope[0];
  }
  if (!customer) {
    // Truly unscoped and no division picked — nothing sensible to break down.
    return res.json({ customer: null, mode: "none", totals: emptyTotals(), groups: [] });
  }

  // Division-level totals (match the summary cards). in_transit comes from
  // material_stock (per-division only); the rest from serial_numbers so they
  // agree with the per-group sums below.
  const readyTotal = db.prepare("SELECT COUNT(*) n FROM serial_numbers WHERE customer = ? AND status = 'Ready'").get(customer).n;
  const deliveredTotal = db.prepare("SELECT COUNT(*) n FROM serial_numbers WHERE customer = ? AND status = 'Delivered'").get(customer).n;
  const faultyTotal = db.prepare("SELECT COUNT(*) n FROM serial_numbers WHERE customer = ? AND status = 'Faulty'").get(customer).n;
  const inTransitRow = db.prepare("SELECT COALESCE(SUM(in_transit),0) n FROM material_stock WHERE customer = ?").get(customer);
  const faultyOnDelivery = db.prepare(`
    SELECT COALESCE(SUM(ri.qty),0) n
    FROM returns r JOIN return_items ri ON ri.return_id = r.id
    WHERE r.customer = ? AND r.status = 'On Delivery'
  `).get(customer).n;

  const totals = {
    onHand: readyTotal + deliveredTotal, // Ready (central) + Delivered (at homebases)
    inTransit: inTransitRow.n,
    faultyOnDelivery,
    faultyWarehouse: faultyTotal,
  };

  const usesClusters = db.prepare("SELECT COUNT(*) n FROM clusters WHERE customer = ? AND status = 'Active'").get(customer).n > 0;

  let groups;
  if (usesClusters) {
    // PIM: group by cluster. Ready + Faulty per cluster (Ready units already
    // carry their cluster from Goods Receipt).
    const rows = db.prepare(`
      SELECT COALESCE(cluster, '(Tanpa Cluster)') AS grp,
             SUM(CASE WHEN status IN ('Ready','Delivered') THEN 1 ELSE 0 END) AS onHand,
             SUM(CASE WHEN status = 'Faulty' THEN 1 ELSE 0 END) AS faulty
      FROM serial_numbers WHERE customer = ?
      GROUP BY COALESCE(cluster, '(Tanpa Cluster)')
      HAVING onHand > 0 OR faulty > 0
      ORDER BY grp
    `).all(customer);
    groups = rows.map((r) => ({ name: r.grp, onHand: r.onHand, faulty: r.faulty }));
  } else {
    // Other divisions: group by homebase. Ready units (homebase NULL) fall
    // under "Warehouse Pusat"; Delivered units sit at their homebase.
    const rows = db.prepare(`
      SELECT COALESCE(NULLIF(homebase, ''), 'Warehouse Pusat') AS grp,
             SUM(CASE WHEN status IN ('Ready','Delivered') THEN 1 ELSE 0 END) AS onHand,
             SUM(CASE WHEN status = 'Faulty' THEN 1 ELSE 0 END) AS faulty
      FROM serial_numbers WHERE customer = ?
      GROUP BY COALESCE(NULLIF(homebase, ''), 'Warehouse Pusat')
      HAVING onHand > 0 OR faulty > 0
      ORDER BY (grp = 'Warehouse Pusat') DESC, grp
    `).all(customer);
    groups = rows.map((r) => ({ name: r.grp, onHand: r.onHand, faulty: r.faulty }));
  }

  res.json({ customer, mode: usesClusters ? "cluster" : "homebase", totals, groups });
});

function emptyTotals() {
  return { onHand: 0, inTransit: 0, faultyOnDelivery: 0, faultyWarehouse: 0 };
}

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
  res.json(db.prepare(query).all(...params).map((r) => ({ ...r, receipt_photo: photoUrl(r.receipt_photo) })));
});

router.get("/receipts", requireAuth, (req, res) => {
  const scope = scopeOf(req.user);
  let rows;
  if (!scope) rows = db.prepare("SELECT * FROM receipts ORDER BY id DESC").all();
  else if (scope.length === 0) rows = [];
  else rows = db.prepare(`SELECT * FROM receipts WHERE customer IN (${scope.map(() => "?").join(",")}) ORDER BY id DESC`).all(...scope);
  res.json(rows.map((r) => ({ ...r, photo: photoUrl(r.photo) })));
});

// One receipt with its photos: the overall photo plus each unit's label
// photo (serialized materials). Older receipts simply have none.
router.get("/receipts/:id", requireAuth, (req, res) => {
  const r = db.prepare("SELECT * FROM receipts WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "Penerimaan barang tidak ditemukan" });
  if (!scopeAllows(scopeOf(req.user), r.customer)) return res.status(403).json({ error: "Penerimaan ini bukan milik divisi Anda" });
  const units = db.prepare("SELECT sn, receipt_photo FROM serial_numbers WHERE received_ref = ? ORDER BY sn").all(r.id)
    .map((u) => ({ sn: u.sn, photo: photoUrl(u.receipt_photo) }));
  res.json({ ...r, photo: photoUrl(r.photo), units });
});

// Goods Receipt: the only place new stock (and new Serial Numbers) enters
// the warehouse. Serialized materials require one SN per unit; everything
// else is just a quantity. Every receipt needs an overall photo of the goods,
// and every serialized unit its own label photo — `serials` is
// [{ sn, photo }]. Photos are validated first, uploaded to the bucket, and
// only then is everything written in one transaction (receipt record,
// serial rows, material total, stock movement) so it can never partially
// apply; if that write fails the just-uploaded photos are deleted again.
router.post("/receipts", requireAuth, requireRole(LOGISTICS, MANAGER), async (req, res) => {
  const { material, serials, qty, note, photo } = req.body;
  const mat = db.prepare("SELECT * FROM materials WHERE name = ?").get(material);
  if (!mat) return res.status(400).json({ error: "Unknown material" });

  const resolved = resolveCreateCustomer(req.user, req.body.customer);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const customer = resolved.customer;

  // Cluster is only meaningful for divisions that actually have clusters
  // (today: PIM only) AND only for serialized materials, since it's tagged
  // per-unit on serial_numbers. A division with any Active cluster requires
  // one to be picked; a division with none must not receive a cluster at
  // all. This keeps every non-PIM Goods Receipt working exactly as before.
  const cluster = (req.body.cluster || "").trim();
  const divisionClusters = db.prepare("SELECT name FROM clusters WHERE customer = ? AND status = 'Active'").all(customer).map((c) => c.name);
  const divisionUsesClusters = divisionClusters.length > 0;
  if (divisionUsesClusters) {
    if (mat.serialized) {
      // Serialized material in a clustered division: a cluster is required
      // and must be one of that division's Active clusters.
      if (!cluster) return res.status(400).json({ error: `Cluster wajib dipilih untuk divisi ${customer}` });
      if (!divisionClusters.includes(cluster)) return res.status(400).json({ error: `Cluster "${cluster}" tidak valid untuk divisi ${customer}` });
    } else if (cluster) {
      // A clustered division can still hold non-serialized materials — they
      // just can't carry a per-unit cluster tag. Reject an accidentally-sent
      // cluster rather than silently dropping it.
      return res.status(400).json({ error: "Material non-serialized tidak bisa diberi cluster" });
    }
  } else if (cluster) {
    return res.status(400).json({ error: `Divisi ${customer} tidak menggunakan cluster` });
  }
  const clusterToStore = divisionUsesClusters && mat.serialized ? cluster : null;

  if (!photo) return res.status(400).json({ error: "Foto keseluruhan penerimaan barang wajib" });
  let units = [];
  if (mat.serialized) {
    if (!Array.isArray(serials) || serials.length === 0) return res.status(409).json({ error: "Serial Number wajib diisi untuk material serialized" });
    units = serials.map((s) => (s && typeof s === "object" ? { sn: String(s.sn || "").trim(), photo: s.photo || null } : { sn: String(s || "").trim(), photo: null }));
    const seen = new Set();
    for (const u of units) {
      if (!u.sn) return res.status(409).json({ error: "Ada Serial Number kosong" });
      const key = u.sn.toUpperCase();
      if (seen.has(key)) return res.status(409).json({ error: `Serial Number duplikat dalam penerimaan ini: ${u.sn}` });
      seen.add(key);
      if (db.prepare("SELECT 1 FROM serial_numbers WHERE sn = ?").get(u.sn)) return res.status(409).json({ error: `Serial Number sudah terdaftar di sistem: ${u.sn}` });
      if (!u.photo) return res.status(400).json({ error: `Foto label wajib untuk setiap Serial Number (${u.sn})` });
    }
  } else if (!(Number(qty) > 0)) {
    return res.status(409).json({ error: "Qty harus lebih dari 0" });
  }

  let photoRef, unitRefs = [];
  try {
    photoRef = await storePhoto(photo, "receipts");
    unitRefs = await storePhotos(units.map((u) => u.photo), "receipts/units");
  } catch (err) {
    return res.status(err.status || 502).json({ error: err.message || "Gagal menyimpan foto" });
  }

  const id = dailySequenceId(db, "receipts", "WR");
  let addedQty = 0;

  const tx = db.transaction(() => {
    if (mat.serialized) {
      // Re-checked inside the transaction: the uploads above took time.
      units.forEach((u) => {
        if (db.prepare("SELECT 1 FROM serial_numbers WHERE sn = ?").get(u.sn)) throw new Error(`Serial Number sudah terdaftar di sistem: ${u.sn}`);
      });
      const insertSn = db.prepare("INSERT INTO serial_numbers (sn, material, status, current_ref, received_date, received_ref, customer, cluster, receipt_photo) VALUES (?, ?, 'Ready', NULL, ?, ?, ?, ?, ?)");
      units.forEach((u, i) => insertSn.run(u.sn, material, isoDate(), id, customer, clusterToStore, unitRefs[i]));
      addedQty = units.length;
    } else {
      addedQty = Number(qty);
    }

    db.prepare("INSERT INTO receipts (id, date, material, qty, note, created_by, customer, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, isoDate(), material, addedQty, note || "", req.user.name, customer, photoRef);

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
    await discardPhotos([photoRef, ...unitRefs]);
    return res.status(409).json({ error: err.message });
  }

  res.status(201).json({ id, material, qty: addedQty, serialized: !!mat.serialized, customer });
});

// Reads an uploaded BKB (photo or PDF) via Claude and returns the line
// items it found plus a guessed destination division — each material
// matched against the Master Material list we hand Claude directly (see
// bkbParser.js), not a plain string-similarity guess, so differently
// worded/ordered names on the real document still resolve correctly.
// Writes nothing to the database; the actual receipt still goes through
// POST /receipts above, once per item, only after a human confirms it.
router.post("/parse-bkb", requireAuth, requireRole(LOGISTICS, MANAGER), async (req, res) => {
  const { document } = req.body;
  if (!document) return res.status(400).json({ error: "Dokumen BKB wajib diupload" });
  try {
    const materialNames = db.prepare("SELECT name FROM materials WHERE status = 'Active'").all().map((r) => r.name);
    const divisionNames = db.prepare("SELECT name FROM customers WHERE status = 'Active'").all().map((r) => r.name);
    const materialsByName = new Map(
      db.prepare("SELECT name, serialized FROM materials WHERE status = 'Active'").all().map((m) => [m.name, !!m.serialized])
    );
    const result = await parseBkbDocument(document, { materialNames, divisionNames });
    const items = result.items.map((it) => ({
      ...it,
      matchedSerialized: it.matchedMaterial ? materialsByName.get(it.matchedMaterial) : null,
    }));
    res.json({ documentType: result.documentType, division: result.division, items });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Gagal membaca dokumen BKB" });
  }
});

// Same idea as parse-bkb above, but for photos of physical materials/goods
// (not a document) — shared by Reconciliation, Transfer Stock, and Return
// Material Faulty's "Deteksi dari Foto" panels. requireAuth only: this is
// read-only and never touches the DB, so it doesn't need to be restricted
// to a specific role — each flow's own submit endpoint (POST /returns,
// POST /stock/transfers, POST /reconciliations) keeps its own role gate
// unchanged, so nothing here widens who can actually create a record.
// Reads the SN(s) off one label photo — the per-SN "Upload/Ganti Foto"
// fallback when the browser can't decode a barcode. Read-only, like above.
router.post("/read-serial-photo", requireAuth, async (req, res) => {
  try {
    const materialNames = db.prepare("SELECT name FROM materials WHERE status = 'Active'").all().map((r) => r.name);
    res.json(await readSerialsFromPhoto((req.body || {}).photo, { materialNames }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Gagal membaca Serial Number dari foto" });
  }
});

router.post("/detect-materials-photo", requireAuth, async (req, res) => {
  const { photos } = req.body || {};
  try {
    const materialNames = db.prepare("SELECT name FROM materials WHERE status = 'Active'").all().map((r) => r.name);
    const materialsByName = new Map(
      db.prepare("SELECT name, serialized FROM materials WHERE status = 'Active'").all().map((m) => [m.name, !!m.serialized])
    );
    const result = await detectMaterialsFromPhotos(photos, { materialNames });
    const items = result.items.map((it) => ({ ...it, serialized: materialsByName.get(it.material) }));
    res.json({ items });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || "Gagal mendeteksi material dari foto" });
  }
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

// Creates a PENDING transfer only — nothing moves yet. Used to apply the
// stock change instantly on submit; now waits for a Logistics/Manager
// approval (see POST /:id/approve below) like the other two request types.
// Business logic lives in utils/stockTransfers.js (unit-tested there); this
// handler is just auth/scope + translating thrown errors to HTTP status.
router.post("/transfers", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { material, customer, homebaseFrom, homebaseTo, qty, serials, note } = req.body || {};
  if (customer && !scopeAllows(scopeOf(req.user), customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });

  try {
    const created = createTransferRequest(db, { material, customer, homebaseFrom, homebaseTo, qty, serials, note, performedBy: req.user.name });
    res.status(201).json(created);
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : /are required|harus lebih dari 0|tidak boleh sama|Pilih minimal/i.test(err.message) ? 400 : 409;
    res.status(status).json({ error: err.message });
  }
});

// Approves a pending Transfer Stock — this is where the stock actually
// moves (previously happened instantly at creation). approveTransfer
// re-validates live rather than trusting what was true when the transfer
// was requested (mirrors the "re-check, don't trust stale client state"
// pattern already used by /stock/phantom-cleanup): the source unit/qty
// could have moved again in the meantime.
router.post("/transfers/:id/approve", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const transfer = db.prepare("SELECT customer FROM stock_transfers WHERE id = ?").get(req.params.id);
  if (transfer && !scopeAllows(scopeOf(req.user), transfer.customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });

  try {
    res.json(approveTransfer(db, req.params.id));
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 409;
    res.status(status).json({ error: err.message });
  }
});

// Rejects a pending Transfer Stock — nothing to unwind since stock never
// moved (that only happens at /approve now).
router.post("/transfers/:id/reject", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const transfer = db.prepare("SELECT customer FROM stock_transfers WHERE id = ?").get(req.params.id);
  if (transfer && !scopeAllows(scopeOf(req.user), transfer.customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });

  try {
    res.json(rejectTransfer(db, req.params.id, { reason: req.body?.reason, rejectedBy: req.user.name }));
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 409;
    res.status(status).json({ error: err.message });
  }
});

// Reverses an already-APPROVED Transfer Stock — for fixing a mistaken
// entry, not a normal business-flow undo. cancelTransfer only allows this
// while nothing has touched the units/qty since (see its own comments) —
// if something has, it rejects with a clear reason instead of silently
// producing wrong numbers, and whoever needs it fixes it by hand instead.
router.post("/transfers/:id/cancel", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const transfer = db.prepare("SELECT customer FROM stock_transfers WHERE id = ?").get(req.params.id);
  if (transfer && !scopeAllows(scopeOf(req.user), transfer.customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });

  try {
    res.json(cancelTransfer(db, req.params.id, { cancelledBy: req.user.name }));
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 409;
    res.status(status).json({ error: err.message });
  }
});

// ===================== TRANSFER ANTAR CLUSTER =====================
// Move ownership of a specific serialized unit from one PIM cluster to
// another, WITHIN the same division. Requires the owning cluster's SPV to
// approve before serial_numbers.cluster is actually changed. No BKB / physical
// handover is involved — this is a pure ownership reallocation, so the unit's
// status, homebase, customer, and everything else stay untouched; only its
// `cluster` tag changes on approval.
const SPV = "SPV";

// Units the requester could ask to borrow: Ready units in this division that
// belong to some OTHER cluster (you don't request your own). Scope-checked so
// an SPV can only see their own division's stock.
router.get("/cluster-transfer-options", requireAuth, (req, res) => {
  const { customer, clusterTo, material } = req.query;
  if (!customer || !clusterTo) return res.status(400).json({ error: "customer and clusterTo are required" });
  const scope = scopeOf(req.user);
  if (!scopeAllows(scope, customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });

  let sql = `
    SELECT sn, material, cluster, homebase, status FROM serial_numbers
    WHERE customer = ? AND status = 'Ready' AND cluster IS NOT NULL AND cluster != ?
  `;
  const params = [customer, clusterTo];
  if (material) { sql += " AND material = ?"; params.push(material); }
  sql += " ORDER BY material, cluster, sn";
  res.json(db.prepare(sql).all(...params));
});

// Transfers this user can see. An SPV sees requests they raised (outgoing)
// and requests awaiting THEIR clusters' approval (incoming). Manager/Logistics
// (unscoped) see all; a division-scoped non-SPV sees their division's.
router.get("/cluster-transfers", requireAuth, (req, res) => {
  const scope = scopeOf(req.user);
  let rows;
  if (!scope) {
    rows = db.prepare("SELECT * FROM cluster_transfers ORDER BY requested_date DESC, id DESC").all();
  } else if (scope.length === 0) {
    rows = [];
  } else {
    rows = db.prepare(`SELECT * FROM cluster_transfers WHERE ${scopeClause("customer", scope).sql} ORDER BY requested_date DESC, id DESC`).all(...scope);
  }
  res.json(rows);
});

// Raise a request: SPV of cluster_to asks for a specific unit owned by
// cluster_from. Validated: the SN must exist, be Ready, be in this division,
// and currently belong to cluster_from (not already cluster_to). Only the
// tag is checked here — nothing changes until approval.
router.post("/cluster-transfers", requireAuth, requireRole(SPV, LOGISTICS, MANAGER), (req, res) => {
  const { sn, clusterTo, note } = req.body || {};
  if (!sn || !clusterTo) return res.status(400).json({ error: "sn dan clusterTo wajib diisi" });

  const unit = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(sn);
  if (!unit) return res.status(404).json({ error: `Serial Number ${sn} tidak ditemukan` });

  const scope = scopeOf(req.user);
  if (!scopeAllows(scope, unit.customer)) return res.status(403).json({ error: "Divisi unit ini bukan divisi Anda" });

  if (unit.status !== "Ready") return res.status(409).json({ error: `Unit ${sn} tidak berstatus Ready (status saat ini: ${unit.status})` });
  if (!unit.cluster) return res.status(409).json({ error: `Unit ${sn} belum punya cluster` });
  if (unit.cluster === clusterTo) return res.status(409).json({ error: `Unit ${sn} sudah milik cluster ${clusterTo}` });

  // Target cluster must be a real Active cluster of this division.
  const validTo = db.prepare("SELECT 1 FROM clusters WHERE name = ? AND customer = ? AND status = 'Active'").get(clusterTo, unit.customer);
  if (!validTo) return res.status(400).json({ error: `Cluster tujuan "${clusterTo}" tidak valid untuk divisi ${unit.customer}` });

  // Block a second pending request for the same unit — avoids two clusters
  // both getting approved for the same physical unit.
  const existingPending = db.prepare("SELECT 1 FROM cluster_transfers WHERE sn = ? AND status = 'Pending'").get(sn);
  if (existingPending) return res.status(409).json({ error: `Sudah ada permintaan transfer yang menunggu persetujuan untuk unit ${sn}` });

  const id = dailySequenceId(db, "cluster_transfers", "CT");
  db.prepare(`
    INSERT INTO cluster_transfers (id, material, customer, sn, cluster_from, cluster_to, status, requested_by, requested_date, request_note)
    VALUES (?, ?, ?, ?, ?, ?, 'Pending', ?, ?, ?)
  `).run(id, unit.material, unit.customer, sn, unit.cluster, clusterTo, req.user.name, isoDate(), note || "");

  res.status(201).json(db.prepare("SELECT * FROM cluster_transfers WHERE id = ?").get(id));
});

// Approve: the owning cluster (cluster_from) SPV agrees. This is the ONLY
// place serial_numbers.cluster changes. Re-validates the unit is still Ready
// and still owned by cluster_from at approval time (it could have moved or
// shipped since the request was raised).
router.post("/cluster-transfers/:id/approve", requireAuth, requireRole(SPV, LOGISTICS, MANAGER), (req, res) => {
  const { note } = req.body || {};
  const tr = db.prepare("SELECT * FROM cluster_transfers WHERE id = ?").get(req.params.id);
  if (!tr) return res.status(404).json({ error: "Transfer tidak ditemukan" });
  if (tr.status !== "Pending") return res.status(409).json({ error: `Transfer ini sudah ${tr.status === "Approved" ? "disetujui" : "ditolak"}` });

  const scope = scopeOf(req.user);
  if (!scopeAllows(scope, tr.customer)) return res.status(403).json({ error: "Divisi transfer ini bukan divisi Anda" });

  const tx = db.transaction(() => {
    const unit = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(tr.sn);
    if (!unit) throw new Error(`Unit ${tr.sn} tidak ditemukan`);
    if (unit.status !== "Ready") throw new Error(`Unit ${tr.sn} tidak lagi Ready (status: ${unit.status})`);
    if (unit.cluster !== tr.cluster_from) throw new Error(`Unit ${tr.sn} tidak lagi milik cluster ${tr.cluster_from}`);

    db.prepare("UPDATE serial_numbers SET cluster = ? WHERE sn = ?").run(tr.cluster_to, tr.sn);
    db.prepare("UPDATE cluster_transfers SET status = 'Approved', decided_by = ?, decided_date = ?, decision_note = ? WHERE id = ?")
      .run(req.user.name, isoDate(), note || "", tr.id);
  });

  try {
    tx();
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
  res.json(db.prepare("SELECT * FROM cluster_transfers WHERE id = ?").get(tr.id));
});

// Reject: owning cluster SPV declines. Nothing on the unit changes; the
// reason is recorded for the requester.
router.post("/cluster-transfers/:id/reject", requireAuth, requireRole(SPV, LOGISTICS, MANAGER), (req, res) => {
  const { note } = req.body || {};
  const tr = db.prepare("SELECT * FROM cluster_transfers WHERE id = ?").get(req.params.id);
  if (!tr) return res.status(404).json({ error: "Transfer tidak ditemukan" });
  if (tr.status !== "Pending") return res.status(409).json({ error: `Transfer ini sudah ${tr.status === "Approved" ? "disetujui" : "ditolak"}` });

  const scope = scopeOf(req.user);
  if (!scopeAllows(scope, tr.customer)) return res.status(403).json({ error: "Divisi transfer ini bukan divisi Anda" });

  db.prepare("UPDATE cluster_transfers SET status = 'Rejected', decided_by = ?, decided_date = ?, decision_note = ? WHERE id = ?")
    .run(req.user.name, isoDate(), note || "", tr.id);
  res.json(db.prepare("SELECT * FROM cluster_transfers WHERE id = ?").get(tr.id));
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
  const row = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(req.params.sn);
  if (row) {
    const scope = scopeOf(req.user);
    if (!scopeAllows(scope, row.customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });
  }
  try {
    const result = sendToCustomer({ sn: req.params.sn, ref, note, performedBy: req.user.name });
    notifyWebhook("sent_to_customer", { sn: result.sn, material: result.material, division: result.customer, ref, performedBy: req.user.name });
    res.status(201).json(result);
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : /wajib diisi/i.test(err.message) ? 400 : 409;
    res.status(status).json({ error: err.message });
  }
});

// Sends several Faulty units to the customer under ONE Nomor Surat/BA — the
// common real-world case (a batch shipped together on one document), which
// the single-SN endpoint above can't express. Each SN still gets its own
// faulty_customer_returns row (so per-unit receive-back tracking is
// unaffected), they just share `ref`. All-or-nothing: sendToCustomer's own
// per-call transaction nests inside this one via SAVEPOINT, so one bad SN
// rolls the whole batch back instead of leaving it half-sent.
router.post("/serials/send-to-customer-batch", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { sns, ref, note } = req.body || {};
  if (!Array.isArray(sns) || sns.length === 0) return res.status(400).json({ error: "Pilih minimal satu Serial Number" });

  const scope = scopeOf(req.user);
  for (const sn of sns) {
    const row = db.prepare("SELECT customer FROM serial_numbers WHERE sn = ?").get(sn);
    if (row && !scopeAllows(scope, row.customer)) return res.status(403).json({ error: `Divisi unit ${sn} bukan divisi Anda` });
  }

  try {
    const results = db.transaction(() => sns.map((sn) => sendToCustomer({ sn, ref, note, performedBy: req.user.name })))();
    results.forEach((result) => notifyWebhook("sent_to_customer", { sn: result.sn, material: result.material, division: result.customer, ref, performedBy: req.user.name }));
    res.status(201).json({ results });
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : /wajib diisi/i.test(err.message) ? 400 : 409;
    res.status(status).json({ error: err.message });
  }
});

router.post("/serials/:sn/receive-from-customer", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { ref, note } = req.body || {};
  const row = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(req.params.sn);
  if (row) {
    const scope = scopeOf(req.user);
    if (!scopeAllows(scope, row.customer)) return res.status(403).json({ error: "Divisi tersebut bukan divisi Anda" });
  }
  try {
    const result = receiveFromCustomer({ sn: req.params.sn, ref, note, performedBy: req.user.name });
    notifyWebhook("received_from_customer", { sn: result.sn, material: result.material, division: result.customer, ref, performedBy: req.user.name });
    res.json(result);
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : /wajib diisi|berbeda dari/i.test(err.message) ? 400 : 409;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;

// ===================== DATA HYGIENE: PHANTOM STOCK ROWS =====================
// A material_stock row can end up sitting at all-zeros for reasons that
// don't actually mean "this division has touched this material" — e.g. a
// Delivery Request that got approved then rejected/cancelled after
// assign-stock already ran adjustStock, or leftover rows from early
// testing before real data existed. Since Warehouse Stock's division
// filter treats "a row exists" as "this division has history with it",
// those leftover zero rows leak through as materials a division never
// actually had. This finds rows with NO real evidence anywhere (receipts,
// stock_movements, serial_numbers, or any Delivery/Return/Reconciliation
// line item) backing their existence, and optionally removes them.
function findPhantomStockRows(db) {
  const zeroRows = db.prepare(`
    SELECT material, customer FROM material_stock
    WHERE ready = 0 AND faulty = 0 AND reserved = 0 AND in_transit = 0
  `).all();

  const hasEvidence = (material, customer) => {
    const checks = [
      db.prepare("SELECT 1 FROM receipts WHERE material = ? AND customer = ? LIMIT 1").get(material, customer),
      db.prepare("SELECT 1 FROM stock_movements WHERE material = ? AND customer = ? LIMIT 1").get(material, customer),
      db.prepare("SELECT 1 FROM serial_numbers WHERE material = ? AND customer = ? LIMIT 1").get(material, customer),
      db.prepare(`SELECT 1 FROM delivery_items di JOIN deliveries d ON d.id = di.delivery_id WHERE di.material = ? AND d.customer = ? LIMIT 1`).get(material, customer),
      db.prepare(`SELECT 1 FROM return_items ri JOIN returns r ON r.id = ri.return_id WHERE ri.material = ? AND r.customer = ? LIMIT 1`).get(material, customer),
      db.prepare(`SELECT 1 FROM reconciliation_items rci JOIN reconciliations rc ON rc.id = rci.reconciliation_id WHERE rci.material = ? AND rc.customer = ? LIMIT 1`).get(material, customer),
    ];
    return checks.some(Boolean);
  };

  const phantoms = [];
  for (const row of zeroRows) {
    if (!hasEvidence(row.material, row.customer)) phantoms.push(row);
  }
  return phantoms;
}

router.get("/phantom-check", requireAuth, requireRole(MANAGER), (req, res) => {
  const phantoms = findPhantomStockRows(db);
  res.json({ count: phantoms.length, rows: phantoms });
});

// Read-only cross-check of serial_numbers vs material_stock vs the global
// materials aggregate. Writes nothing — see utils/stockConsistency.js. The
// recompute/overwrite action is deliberately NOT here (TUGAS_PENGEMBANGAN.md #3).
router.get("/consistency", requireAuth, requireRole(MANAGER), (req, res) => {
  res.json(computeStockConsistency(db));
});

// Rebuild the materials.* global aggregate from material_stock (= sum across
// every division, which is the column's definition). Fixes "global != division
// sum" drift. Dry-run unless body { commit: true }. Manager only. One
// transaction. Does NOT touch material_stock or serial_numbers.
router.post("/rebuild-global", requireAuth, requireRole(MANAGER), (req, res) => {
  const commit = req.body?.commit === true;
  const { changes, desired } = planGlobalAggregateRebuild(db);

  if (!commit || changes.length === 0) {
    return res.json({ mode: changes.length === 0 ? "already-consistent" : "dry-run", count: changes.length, changes });
  }

  const upd = db.prepare("UPDATE materials SET ready = @ready, faulty = @faulty, reserved = @reserved, in_transit = @in_transit WHERE name = @name");
  const tx = db.transaction(() => {
    for (const [name, row] of Object.entries(desired)) upd.run({ name, ...row });
  });
  tx();

  console.log(`[stock] rebuild-global by ${req.user.name}: ${changes.length} field(s) across ${Object.keys(desired).length} material(s)`);
  res.json({ mode: "committed", count: changes.length, materialsUpdated: Object.keys(desired).length, changes });
});

// Recompute material_stock.{reserved, in_transit, faulty} from serial_numbers
// status counts (serialized materials, real divisions). Does NOT touch `ready`
// (disputed MSG semantics) or serial_numbers. Dry-run unless { commit: true }.
// Manager only. Run rebuild-global afterwards to refresh the global aggregate.
router.post("/rebuild-serial-buckets", requireAuth, requireRole(MANAGER), (req, res) => {
  const commit = req.body?.commit === true;
  const { changes, desired } = planSerialBucketRebuild(db);

  if (!commit || changes.length === 0) {
    return res.json({ mode: changes.length === 0 ? "already-consistent" : "dry-run", count: changes.length, changes });
  }

  const ensure = db.prepare("INSERT INTO material_stock (material, customer) VALUES (@material, @customer) ON CONFLICT(material, customer) DO NOTHING");
  const upd = db.prepare("UPDATE material_stock SET reserved = @reserved, in_transit = @in_transit, faulty = @faulty WHERE material = @material AND customer = @customer");
  const tx = db.transaction(() => {
    for (const row of desired) { ensure.run(row); upd.run(row); }
  });
  tx();

  console.log(`[stock] rebuild-serial-buckets by ${req.user.name}: ${changes.length} field(s) across ${desired.length} (material,divisi)`);
  res.json({ mode: "committed", count: changes.length, rowsUpdated: desired.length, changes });
});

// Corrects units left at status='Delivered' despite having a complete
// install record (install_site + installed_date) — see
// utils/stockConsistency.js planInstalledStatusFix for the exact criteria.
// Re-derives the plan server-side rather than trusting the client's stale
// preview. Dry-run unless body { commit: true }. Manager only.
router.post("/fix-installed-status", requireAuth, requireRole(MANAGER), (req, res) => {
  const commit = req.body?.commit === true;
  const { fixable, needsReview } = planInstalledStatusFix(db);

  if (!commit || fixable.length === 0) {
    return res.json({ mode: fixable.length === 0 ? "already-consistent" : "dry-run", count: fixable.length, fixable, needsReview });
  }

  const upd = db.prepare("UPDATE serial_numbers SET status = 'Installed' WHERE sn = ? AND status = 'Delivered'");
  const tx = db.transaction((rows) => {
    let n = 0;
    rows.forEach((r) => { if (upd.run(r.sn).changes) n += 1; });
    return n;
  });
  const updated = tx(fixable);

  console.log(`[stock] fix-installed-status by ${req.user.name}: ${updated} unit(s) corrected Delivered -> Installed`);
  res.json({ mode: "committed", count: updated, fixable, needsReview });
});

router.post("/phantom-cleanup", requireAuth, requireRole(MANAGER), (req, res) => {
  // Re-runs the same check server-side rather than trusting whatever list
  // the client sends — a row that looked phantom moments ago could have
  // since gained real activity, and this must never delete real history.
  const phantoms = findPhantomStockRows(db);
  const del = db.prepare("DELETE FROM material_stock WHERE material = ? AND customer = ?");
  const tx = db.transaction((rows) => rows.forEach((r) => del.run(r.material, r.customer)));
  tx(phantoms);
  res.json({ deleted: phantoms.length, rows: phantoms });
});
