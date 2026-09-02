const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { dailySequenceId, isoDate, nextStockMovementId } = require("../utils/ids");
const { scopeOf, scopeAllows, getDivisionStock, adjustStock, adjustConsumable, resolveCreateCustomer } = require("../utils/stock");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";
const LOGISTICS = "Logistics Staff";
const SPV = "SPV";

// Tools are a separate, shared, un-divisioned pool (see routes/tools.js) —
// this local helper just adjusts a tools row directly, no per-division split.
function adjustToolStock(tool, field, delta) {
  db.prepare(`UPDATE tools SET ${field} = MAX(0, ${field} + ?) WHERE name = ?`).run(delta, tool);
}

function loadDelivery(id) {
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id);
  if (!delivery) return null;
  const items = db.prepare("SELECT material, qty, item_type FROM delivery_items WHERE delivery_id = ?").all(id).map((item) => {
    const isTool = item.item_type === "tool";
    const serialRows = isTool
      ? db.prepare("SELECT sn, status FROM tool_serials WHERE current_ref = ? AND tool = ?").all(id, item.material)
      : db.prepare("SELECT sn, status, installed_date, installed_by, install_site, install_photo FROM serial_numbers WHERE current_ref = ? AND material = ?").all(id, item.material);
    return {
      material: item.material, qty: item.qty, type: item.item_type,
      serials: serialRows.map((s) => s.sn),
      serialStatuses: Object.fromEntries(serialRows.map((s) => [s.sn, s.status])),
      serialInstallInfo: isTool ? undefined : Object.fromEntries(serialRows.map((s) => [
        s.sn, { installedDate: s.installed_date, installedBy: s.installed_by, installSite: s.install_site, installPhoto: s.install_photo },
      ])),
    };
  });
  const history = db.prepare("SELECT time, text FROM delivery_history WHERE delivery_id = ? ORDER BY id").all(id);
  const serialPhotoRows = db.prepare("SELECT sn, photo FROM delivery_serial_photos WHERE delivery_id = ?").all(id);
  const serialPhotos = Object.fromEntries(serialPhotoRows.map((r) => [r.sn, r.photo]));
  // Any tool unit still Checked Out under this delivery needs to come back
  // eventually, independent of the delivery's own status — surfaced here so
  // the front-end can show a "Kembalikan Alat" panel whenever relevant.
  const outstandingTools = items.filter((i) => i.type === "tool")
    .flatMap((i) => i.serials.filter((sn) => i.serialStatuses[sn] === "Checked Out").map((sn) => ({ tool: i.material, sn })));
  return {
    ...delivery, items, history,
    docOverall: delivery.doc_overall, docAfterPacking: delivery.doc_after_packing, resiNumber: delivery.resi_number, resiPhoto: delivery.resi_photo,
    deliveredPhoto: delivery.delivered_photo, receivedBy: delivery.received_by,
    bastDocument: delivery.bast_document, bastFilename: delivery.bast_filename,
    bkbLink: delivery.bkb_link,
    rejectionReason: delivery.rejection_reason,
    serialPhotos, outstandingTools,
  };
}

function addHistory(id, text) {
  db.prepare("INSERT INTO delivery_history (delivery_id, time, text) VALUES (?, ?, ?)")
    .run(id, new Date().toISOString(), text);
}

router.get("/", requireAuth, (req, res) => {
  const scope = scopeOf(req.user);
  let ids;
  if (!scope) {
    ids = db.prepare("SELECT id FROM deliveries ORDER BY id DESC").all().map((r) => r.id);
  } else if (scope.length === 0) {
    ids = [];
  } else {
    ids = db.prepare(`SELECT id FROM deliveries WHERE customer IN (${scope.map(() => "?").join(",")}) ORDER BY id DESC`).all(...scope).map((r) => r.id);
  }
  res.json(ids.map(loadDelivery));
});

router.get("/:id", requireAuth, (req, res) => {
  const delivery = loadDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (!scopeAllows(scopeOf(req.user), delivery.customer)) return res.status(403).json({ error: "Delivery ini bukan milik divisi Anda" });
  res.json(delivery);
});

// SPV (or Manager) submits a new request — items can be a mix of materials
// (division-scoped, one-way) and tools (shared pool, borrowed and returned).
// Every request still resolves to one division for visibility/filtering
// purposes even if it's tools-only, same as before.
router.post("/", requireAuth, requireRole(SPV, MANAGER), (req, res) => {
  const { homebase, site, keperluan, note, items } = req.body;
  if (!homebase || !keperluan || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "homebase, keperluan, and at least one item are required" });
  }

  const resolved = resolveCreateCustomer(req.user, req.body.customer);
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const customer = resolved.customer;

  for (const item of items) {
    if (item.type === "tool") {
      const t = db.prepare("SELECT * FROM tools WHERE name = ?").get(item.material);
      if (!t) return res.status(400).json({ error: `Unknown tool: ${item.material}` });
      if (item.qty > t.available) return res.status(409).json({ error: `Stock alat ${item.material} tidak cukup: diminta ${item.qty}, tersedia ${t.available}` });
    } else if (item.type === "consumable") {
      const c = db.prepare("SELECT * FROM consumables WHERE name = ?").get(item.material);
      if (!c) return res.status(400).json({ error: `Unknown consumable: ${item.material}` });
      if (item.qty > c.ready) {
        return res.status(409).json({ error: `Insufficient stock for ${item.material}: requested ${item.qty}, available ${c.ready}` });
      }
    } else {
      const material = db.prepare("SELECT 1 FROM materials WHERE name = ?").get(item.material);
      if (!material) return res.status(400).json({ error: `Unknown material: ${item.material}` });
      const stock = getDivisionStock(item.material, customer);
      if (item.qty > stock.ready) {
        return res.status(409).json({ error: `Insufficient stock for ${item.material}: requested ${item.qty}, available ${stock.ready} (divisi ${customer})` });
      }
    }
  }

  const id = dailySequenceId(db, "deliveries", "DR");
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO deliveries (id, requester, homebase, site, keperluan, note, status, date, customer) VALUES (?, ?, ?, ?, ?, ?, 'Waiting Logistics Approval', ?, ?)`)
      .run(id, req.user.name, homebase, site || "", keperluan, note || "", isoDate(), customer);
    const insertItem = db.prepare("INSERT INTO delivery_items (delivery_id, material, qty, item_type) VALUES (?, ?, ?, ?)");
    items.forEach((i) => insertItem.run(id, i.material, i.qty, i.type === "tool" ? "tool" : i.type === "consumable" ? "consumable" : "material"));
    addHistory(id, `Dibuat dan disubmit oleh ${req.user.name} (${req.user.role})`);
  });
  tx();

  res.status(201).json(loadDelivery(id));
});

// Manager Logistics reviews and approves at the qty level only — no stock
// or Serial Numbers are touched here yet.
router.post("/:id/approve", requireAuth, requireRole(MANAGER), (req, res) => {
  const delivery = loadDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (delivery.status !== "Waiting Logistics Approval") {
    return res.status(409).json({ error: `Cannot approve a request with status "${delivery.status}"` });
  }

  for (const item of delivery.items) {
    if (item.type === "tool") {
      const t = db.prepare("SELECT * FROM tools WHERE name = ?").get(item.material);
      if (!t || item.qty > t.available) return res.status(409).json({ error: `Stock alat ${item.material} berubah dan tidak lagi cukup` });
    } else if (item.type === "consumable") {
      const c = db.prepare("SELECT ready FROM consumables WHERE name = ?").get(item.material);
      if (!c || item.qty > c.ready) {
        return res.status(409).json({ error: `Stock for ${item.material} changed and is no longer sufficient` });
      }
    } else {
      const stock = getDivisionStock(item.material, delivery.customer);
      if (item.qty > stock.ready) {
        return res.status(409).json({ error: `Stock for ${item.material} changed and is no longer sufficient (divisi ${delivery.customer})` });
      }
    }
  }

  db.prepare("UPDATE deliveries SET status = 'Waiting Stock Assignment' WHERE id = ?").run(delivery.id);
  addHistory(delivery.id, `Approved by ${req.user.name} (Manager) — menunggu penugasan stock oleh Logistics Staff`);

  res.json(loadDelivery(delivery.id));
});

// Logistics Staff picks the specific units to fulfill an already-Approved
// request. Materials: Ready -> Reserved (existing division-scoped flow).
// Tools: picked units go straight Available -> Checked Out here (tools have
// no separate in-transit leg — the moment Logistics commits a specific unit
// to this request, it's considered handed over for accountability purposes).
router.post("/:id/assign-stock", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const delivery = loadDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (!scopeAllows(scopeOf(req.user), delivery.customer)) return res.status(403).json({ error: "Delivery ini bukan milik divisi Anda" });
  if (delivery.status !== "Waiting Stock Assignment") {
    return res.status(409).json({ error: `Cannot assign stock for a request with status "${delivery.status}"` });
  }

  const serialSelections = req.body?.serialSelections || {};
  const materialItems = delivery.items.filter((i) => i.type !== "tool" && i.type !== "consumable");
  const toolItems = delivery.items.filter((i) => i.type === "tool");
  const consumableItems = delivery.items.filter((i) => i.type === "consumable");

  const materialRows = {};
  for (const item of materialItems) {
    const material = db.prepare("SELECT * FROM materials WHERE name = ?").get(item.material);
    const stock = getDivisionStock(item.material, delivery.customer);
    if (!material || item.qty > stock.ready) {
      return res.status(409).json({ error: `Stock for ${item.material} changed and is no longer sufficient (divisi ${delivery.customer})` });
    }
    materialRows[item.material] = material;
  }
  const toolRows = {};
  for (const item of toolItems) {
    const t = db.prepare("SELECT * FROM tools WHERE name = ?").get(item.material);
    if (!t || item.qty > t.available) return res.status(409).json({ error: `Stock alat ${item.material} berubah dan tidak lagi cukup` });
    toolRows[item.material] = t;
  }
  // Consumables are never serialized — this is purely a qty check, no
  // per-unit selection step like materials/tools go through below.
  for (const item of consumableItems) {
    const c = db.prepare("SELECT ready FROM consumables WHERE name = ?").get(item.material);
    if (!c || item.qty > c.ready) {
      return res.status(409).json({ error: `Stock for ${item.material} changed and is no longer sufficient` });
    }
  }

  for (const item of materialItems) {
    if (!materialRows[item.material].serialized) continue;
    const chosen = serialSelections[item.material];
    if (chosen) {
      if (chosen.length !== item.qty) return res.status(400).json({ error: `Pilih tepat ${item.qty} Serial Number untuk ${item.material} (dipilih: ${chosen.length})` });
      if (new Set(chosen).size !== chosen.length) return res.status(400).json({ error: `Ada Serial Number terpilih dua kali untuk ${item.material}` });
      for (const sn of chosen) {
        const row = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(sn);
        if (!row || row.material !== item.material || row.status !== "Ready" || row.customer !== delivery.customer) {
          return res.status(409).json({ error: `Serial Number ${sn} tidak tersedia (Ready) untuk ${item.material} di divisi ${delivery.customer}` });
        }
      }
    } else {
      const available = db.prepare("SELECT COUNT(*) AS n FROM serial_numbers WHERE material = ? AND status = 'Ready' AND customer = ?").get(item.material, delivery.customer).n;
      if (available < item.qty) {
        return res.status(409).json({ error: `Serial Number Ready untuk ${item.material} tidak mencukupi di divisi ${delivery.customer} (tersedia ${available}, butuh ${item.qty})` });
      }
    }
  }
  for (const item of toolItems) {
    if (!toolRows[item.material].serialized) continue;
    const chosen = serialSelections[item.material];
    if (chosen) {
      if (chosen.length !== item.qty) return res.status(400).json({ error: `Pilih tepat ${item.qty} unit untuk ${item.material}` });
      if (new Set(chosen).size !== chosen.length) return res.status(400).json({ error: `Ada unit terpilih dua kali untuk ${item.material}` });
      for (const sn of chosen) {
        const row = db.prepare("SELECT * FROM tool_serials WHERE sn = ?").get(sn);
        if (!row || row.tool !== item.material || row.status !== "Available") {
          return res.status(409).json({ error: `Unit ${sn} tidak tersedia (Available) untuk ${item.material}` });
        }
      }
    } else {
      const available = db.prepare("SELECT COUNT(*) AS n FROM tool_serials WHERE tool = ? AND status = 'Available'").get(item.material).n;
      if (available < item.qty) return res.status(409).json({ error: `Unit Available untuk ${item.material} tidak mencukupi (tersedia ${available}, butuh ${item.qty})` });
    }
  }

  const tx = db.transaction(() => {
    materialItems.forEach((item) => {
      adjustStock(item.material, delivery.customer, "ready", -item.qty);
      adjustStock(item.material, delivery.customer, "reserved", item.qty);
      if (materialRows[item.material].serialized) {
        const chosen = serialSelections[item.material]
          || db.prepare("SELECT sn FROM serial_numbers WHERE material = ? AND status = 'Ready' AND customer = ? ORDER BY sn LIMIT ?").all(item.material, delivery.customer, item.qty).map((r) => r.sn);
        const markReserved = db.prepare("UPDATE serial_numbers SET status = 'Reserved', current_ref = ? WHERE sn = ?");
        chosen.forEach((sn) => markReserved.run(delivery.id, sn));
      }
    });
    toolItems.forEach((item) => {
      adjustToolStock(item.material, "available", -item.qty);
      adjustToolStock(item.material, "checked_out", item.qty);
      if (toolRows[item.material].serialized) {
        const chosen = serialSelections[item.material]
          || db.prepare("SELECT sn FROM tool_serials WHERE tool = ? AND status = 'Available' ORDER BY sn LIMIT ?").all(item.material, item.qty).map((r) => r.sn);
        const markOut = db.prepare("UPDATE tool_serials SET status = 'Checked Out', current_ref = ? WHERE sn = ?");
        chosen.forEach((sn) => markOut.run(delivery.id, sn));
      }
    });
    consumableItems.forEach((item) => {
      adjustConsumable(item.material, "ready", -item.qty);
      adjustConsumable(item.material, "reserved", item.qty);
    });
    db.prepare("UPDATE deliveries SET status = 'Preparing' WHERE id = ?").run(delivery.id);
    const parts = [];
    if (materialItems.length) parts.push("stock material direservasi");
    if (toolItems.length) parts.push("alat diserahkan (Checked Out)");
    if (consumableItems.length) parts.push("stock consumable direservasi");
    addHistory(delivery.id, `${parts.join(" & ")} oleh ${req.user.name} (Logistics)`);
  });
  tx();

  res.json(loadDelivery(delivery.id));
});

router.post("/:id/reject", requireAuth, requireRole(MANAGER), (req, res) => {
  const { reason } = req.body || {};
  if (!reason?.trim()) return res.status(400).json({ error: "Alasan penolakan wajib diisi" });
  const delivery = loadDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (delivery.status !== "Waiting Logistics Approval") {
    return res.status(409).json({ error: `Cannot reject a request with status "${delivery.status}"` });
  }
  db.prepare("UPDATE deliveries SET status = 'Rejected', rejection_reason = ? WHERE id = ?").run(reason.trim(), delivery.id);
  addHistory(delivery.id, `Rejected by ${req.user.name} (Manager) — alasan: ${reason.trim()}`);
  res.json(loadDelivery(delivery.id));
});

// Preparing -> Shipped requires shipment documentation: one photo per
// Serial Number being sent (materials AND tools alike, for accountability),
// plus an overall photo and a post-packing photo. Only material stock moves
// here (reserved -> in transit) — tool units are already Checked Out since
// assign-stock, so they just ride along with no further stock change.
router.post("/:id/ship", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const delivery = loadDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (!scopeAllows(scopeOf(req.user), delivery.customer)) return res.status(403).json({ error: "Delivery ini bukan milik divisi Anda" });
  if (delivery.status !== "Preparing") {
    return res.status(409).json({ error: `Cannot ship a request with status "${delivery.status}"` });
  }

  const { docOverall, docAfterPacking, serialPhotos } = req.body || {};
  if (!docOverall || !docAfterPacking) {
    return res.status(400).json({ error: "Foto keseluruhan material dan foto setelah packing wajib diisi" });
  }

  const photos = serialPhotos || {};
  const allSerials = delivery.items.flatMap((item) => item.serials || []);
  const missingPhotos = allSerials.filter((sn) => !photos[sn]);
  if (missingPhotos.length > 0) {
    return res.status(400).json({ error: `Foto Serial Number belum lengkap untuk: ${missingPhotos.join(", ")}` });
  }

  const materialItems = delivery.items.filter((i) => i.type !== "tool" && i.type !== "consumable");
  const consumableItems = delivery.items.filter((i) => i.type === "consumable");

  const tx = db.transaction(() => {
    materialItems.forEach((item) => {
      adjustStock(item.material, delivery.customer, "reserved", -item.qty);
      adjustStock(item.material, delivery.customer, "in_transit", item.qty);
      db.prepare("UPDATE serial_numbers SET status = 'In Transit' WHERE current_ref = ? AND material = ? AND status = 'Reserved'")
        .run(delivery.id, item.material);
      const material = db.prepare("SELECT ready FROM materials WHERE name = ?").get(item.material);
      const movId = nextStockMovementId(db);
      db.prepare(`INSERT INTO stock_movements (id, date, material, qty, ref, remaining, type, customer) VALUES (?, ?, ?, ?, ?, ?, 'Delivery', ?)`)
        .run(movId, isoDate(), item.material, -item.qty, delivery.id, material.ready, delivery.customer);
    });
    // Consumables skip stock_movements entirely — that table's `material`
    // column has a hard FK to materials(name), and a consumable's name was
    // never inserted there, so writing a row here would throw. History
    // (below) plus consumable_stock's own reserved/in_transit numbers are
    // enough of an audit trail for something this low-stakes.
    consumableItems.forEach((item) => {
      adjustConsumable(item.material, "reserved", -item.qty);
      adjustConsumable(item.material, "in_transit", item.qty);
    });

    const insertPhoto = db.prepare("INSERT INTO delivery_serial_photos (delivery_id, sn, photo) VALUES (?, ?, ?)");
    allSerials.forEach((sn) => insertPhoto.run(delivery.id, sn, photos[sn]));

    db.prepare("UPDATE deliveries SET status = 'Shipped', doc_overall = ?, doc_after_packing = ? WHERE id = ?")
      .run(docOverall, docAfterPacking, delivery.id);
    addHistory(delivery.id, `Ditandai Shipped oleh ${req.user.name} — dokumentasi pengiriman lengkap`);
  });
  tx();

  res.json(loadDelivery(delivery.id));
});

router.post("/:id/resi", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { resiNumber, resiPhoto } = req.body;
  if (!resiNumber?.trim() && !resiPhoto) {
    return res.status(400).json({ error: "Isi nomor resi atau upload foto resi" });
  }
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (!scopeAllows(scopeOf(req.user), delivery.customer)) return res.status(403).json({ error: "Delivery ini bukan milik divisi Anda" });

  const nextNumber = resiNumber?.trim() || delivery.resi_number;
  const nextPhoto = resiPhoto || delivery.resi_photo;
  db.prepare("UPDATE deliveries SET resi_number = ?, resi_photo = ? WHERE id = ?").run(nextNumber, nextPhoto, delivery.id);
  addHistory(delivery.id, `Resi ditambahkan${nextNumber ? `: ${nextNumber}` : " (foto)"}`);
  res.json(loadDelivery(delivery.id));
});

router.post("/:id/bast", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { bastDocument, bastFilename } = req.body;
  if (!bastDocument) return res.status(400).json({ error: "Upload dokumen BAST terlebih dahulu" });
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (!scopeAllows(scopeOf(req.user), delivery.customer)) return res.status(403).json({ error: "Delivery ini bukan milik divisi Anda" });
  if (!["Shipped", "Delivered"].includes(delivery.status)) {
    return res.status(409).json({ error: `Tidak bisa upload BAST untuk status "${delivery.status}"` });
  }
  db.prepare("UPDATE deliveries SET bast_document = ?, bast_filename = ? WHERE id = ?").run(bastDocument, bastFilename || "BAST", delivery.id);
  addHistory(delivery.id, `Dokumen BAST diupload oleh ${req.user.name}`);
  res.json(loadDelivery(delivery.id));
});

router.post("/:id/bkb-link", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { bkbLink } = req.body;
  if (!bkbLink?.trim()) return res.status(400).json({ error: "Isi link BKB / Surat Jalan" });
  if (!/^https?:\/\//i.test(bkbLink.trim())) return res.status(400).json({ error: "Link harus diawali http:// atau https://" });
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (!scopeAllows(scopeOf(req.user), delivery.customer)) return res.status(403).json({ error: "Delivery ini bukan milik divisi Anda" });
  db.prepare("UPDATE deliveries SET bkb_link = ? WHERE id = ?").run(bkbLink.trim(), delivery.id);
  addHistory(delivery.id, `Link BKB / Surat Jalan ditambahkan oleh ${req.user.name}`);
  res.json(loadDelivery(delivery.id));
});

// Shipped -> Delivered: material units have left the warehouse for good, so
// in_transit is cleared for them and their SNs move to a final "Delivered"
// state. Tool items are unaffected (already Checked Out) — they get
// returned independently via POST /:id/return-tools, any time, regardless
// of the delivery's own status.
router.post("/:id/advance", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const delivery = loadDelivery(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (!scopeAllows(scopeOf(req.user), delivery.customer)) return res.status(403).json({ error: "Delivery ini bukan milik divisi Anda" });
  if (delivery.status !== "Shipped") {
    return res.status(409).json({ error: `Cannot advance a request with status "${delivery.status}"` });
  }

  const { deliveredPhoto, receivedBy } = req.body || {};
  if (!deliveredPhoto) {
    return res.status(400).json({ error: "Foto bukti penerimaan barang wajib diisi" });
  }

  const materialItems = delivery.items.filter((i) => i.type !== "tool" && i.type !== "consumable");
  const consumableItems = delivery.items.filter((i) => i.type === "consumable");

  const tx = db.transaction(() => {
    materialItems.forEach((item) => {
      adjustStock(item.material, delivery.customer, "in_transit", -item.qty);
      const material = db.prepare("SELECT serialized FROM materials WHERE name = ?").get(item.material);
      if (material && material.serialized) {
        // Serialized: each unit's current homebase is tracked directly on
        // its own row — this is also the moment Transfer Stock's history
        // starts being meaningful for it.
        db.prepare("UPDATE serial_numbers SET status = 'Delivered', homebase = ? WHERE current_ref = ? AND material = ? AND status = 'In Transit'")
          .run(delivery.homebase, delivery.id, item.material);
      } else {
        db.prepare("UPDATE serial_numbers SET status = 'Delivered' WHERE current_ref = ? AND material = ? AND status = 'In Transit'")
          .run(delivery.id, item.material);
        // Non-serialized: no individual rows to tag, so the arrived qty is
        // credited straight into the per-homebase ledger instead.
        db.prepare(`
          INSERT INTO material_stock_homebase (material, customer, homebase, qty) VALUES (?, ?, ?, ?)
          ON CONFLICT(material, customer, homebase) DO UPDATE SET qty = qty + excluded.qty
        `).run(item.material, delivery.customer, delivery.homebase, item.qty);
      }
    });
    // Consumables: once Delivered, they're considered consumed on the
    // spot — in_transit just drains away with nothing else to track
    // afterward (no Delivered bucket, no homebase ledger, no Installed
    // step — unlike Materials, there's no further lifecycle here).
    consumableItems.forEach((item) => {
      adjustConsumable(item.material, "in_transit", -item.qty);
    });
    db.prepare("UPDATE deliveries SET status = 'Delivered', delivered_photo = ?, received_by = ? WHERE id = ?")
      .run(deliveredPhoto, receivedBy || null, delivery.id);
    addHistory(delivery.id, `Status diubah ke Delivered oleh ${req.user.name}${receivedBy ? ` — diterima oleh ${receivedBy}` : ""}`);
  });
  tx();

  res.json(loadDelivery(delivery.id));
});

// Tools attached to this delivery come back independently of the delivery's
// own status/lifecycle — a delivery can sit at "Delivered" forever with its
// material portion done while tool units are still out, and partial returns
// (some SNs now, more later) are allowed. Only SNs actually tied to THIS
// delivery and currently Checked Out are accepted.
router.post("/:id/return-tools", requireAuth, requireRole(LOGISTICS, MANAGER, SPV, "Technician"), (req, res) => {
  const delivery = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(req.params.id);
  if (!delivery) return res.status(404).json({ error: "Delivery request not found" });
  if (!scopeAllows(scopeOf(req.user), delivery.customer)) return res.status(403).json({ error: "Delivery ini bukan milik divisi Anda" });

  const { serials, condition, note, photo } = req.body || {};
  if (!Array.isArray(serials) || serials.length === 0) return res.status(400).json({ error: "Pilih minimal satu unit alat untuk dikembalikan" });
  const cond = condition === "Rusak" ? "Rusak" : "Baik";
  const nextStatus = cond === "Rusak" ? "Under Repair" : "Available";
  const nextField = cond === "Rusak" ? "under_repair" : "available";

  const rows = serials.map((sn) => db.prepare("SELECT * FROM tool_serials WHERE sn = ?").get(sn));
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.current_ref !== delivery.id || row.status !== "Checked Out") {
      return res.status(409).json({ error: `Unit ${serials[i]} tidak sedang dipinjam pada delivery ini` });
    }
  }

  const tx = db.transaction(() => {
    const byTool = {};
    rows.forEach((row) => { byTool[row.tool] = (byTool[row.tool] || 0) + 1; });
    Object.entries(byTool).forEach(([tool, qty]) => {
      adjustToolStock(tool, "checked_out", -qty);
      adjustToolStock(tool, nextField, qty);
    });
    const markReturned = db.prepare("UPDATE tool_serials SET status = ?, current_ref = NULL WHERE sn = ?");
    serials.forEach((sn) => markReturned.run(nextStatus, sn));
    addHistory(delivery.id, `Alat dikembalikan oleh ${req.user.name} (${serials.join(", ")}) — kondisi: ${cond}${note ? `, catatan: ${note}` : ""}`);
  });
  tx();

  res.json(loadDelivery(delivery.id));
});

// Note: confirming a unit as "Installed" no longer happens here — Delivery
// Request now only tracks shipping status through to "Delivered". The
// actual physical-install confirmation (and swapping out faulty units)
// lives in Penggantian Material (see routes/materialSwaps.js) instead,
// since installation is a separate real-world event that can happen much
// later, by someone else, independent of the shipment itself.

module.exports = router;
