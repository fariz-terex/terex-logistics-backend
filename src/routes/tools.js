const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { dailySequenceId, paddedSequenceId, isoDate } = require("../utils/ids");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";
const LOGISTICS = "Logistics Staff";
const SPV = "SPV";
const TECH = "Technician";

// Shared company pool — no division split, unlike materials — so every
// adjustment here just touches the tools row directly.
function adjustToolStock(tool, field, delta) {
  db.prepare(`UPDATE tools SET ${field} = MAX(0, ${field} + ?) WHERE name = ?`).run(delta, tool);
}

// ---------- Master Tools + stock ----------
router.get("/", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM tools ORDER BY name").all();
  res.json(rows.map((r) => ({ ...r, serialized: !!r.serialized })));
});

router.post("/", requireAuth, requireRole(MANAGER), (req, res) => {
  const { name, category, unit, serialized, minStock } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  if (db.prepare("SELECT 1 FROM tools WHERE name = ?").get(name)) return res.status(409).json({ error: "Nama alat sudah ada" });
  const id = paddedSequenceId(db, "tools", "TL");
  db.prepare(`INSERT INTO tools (id, name, category, unit, serialized, min_stock, status, available, checked_out, under_repair) VALUES (?, ?, ?, ?, ?, ?, 'Active', 0, 0, 0)`)
    .run(id, name.trim(), category || "", unit || "Unit", serialized ? 1 : 0, Number(minStock) || 0);
  res.status(201).json(db.prepare("SELECT * FROM tools WHERE id = ?").get(id));
});

router.patch("/:id/toggle-status", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM tools WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Tool not found" });
  const next = row.status === "Active" ? "Inactive" : "Active";
  db.prepare("UPDATE tools SET status = ? WHERE id = ?").run(next, row.id);
  res.json(db.prepare("SELECT * FROM tools WHERE id = ?").get(row.id));
});

// tool_serials.tool REFERENCES tools(name) — SQLite already blocks
// deleting a tool with any units ever received against it.
router.delete("/:id", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM tools WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Tool not found" });
  try {
    db.prepare("DELETE FROM tools WHERE id = ?").run(row.id);
    res.json({ deleted: row.id });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY" || /FOREIGN KEY/i.test(err.message)) {
      return res.status(409).json({ error: "Tidak bisa dihapus — alat ini sudah punya unit/riwayat peminjaman" });
    }
    throw err;
  }
});
router.post("/bulk-delete", requireAuth, requireRole(MANAGER), (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length === 0) return res.status(400).json({ error: "Pilih minimal satu Alat" });
  let deleted = 0;
  const blocked = [];
  const tx = db.transaction((list) => {
    list.forEach((id) => {
      try {
        const result = db.prepare("DELETE FROM tools WHERE id = ?").run(id);
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

router.get("/serials", requireAuth, (req, res) => {
  const { tool, status, q } = req.query;
  let query = "SELECT * FROM tool_serials WHERE 1=1";
  const params = [];
  if (tool) { query += " AND tool = ?"; params.push(tool); }
  if (status) { query += " AND status = ?"; params.push(status); }
  if (q) { query += " AND sn LIKE ?"; params.push(`%${q}%`); }
  query += " ORDER BY sn";
  if (q) query += " LIMIT 10";
  res.json(db.prepare(query).all(...params));
});

router.get("/receipts", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM tool_receipts ORDER BY id DESC").all());
});

// Terima Alat: intake of new tool units into the shared pool.
router.post("/receipts", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const { tool, serials, qty, note } = req.body;
  const t = db.prepare("SELECT * FROM tools WHERE name = ?").get(tool);
  if (!t) return res.status(400).json({ error: "Unknown tool" });

  const id = dailySequenceId(db, "tool_receipts", "TR");
  let addedQty = 0;

  const tx = db.transaction(() => {
    if (t.serialized) {
      if (!Array.isArray(serials) || serials.length === 0) throw new Error("Serial Number wajib diisi untuk alat serialized");
      const seen = new Set();
      serials.forEach((raw) => {
        const sn = (raw || "").trim();
        if (!sn) throw new Error("Ada Serial Number kosong");
        if (seen.has(sn)) throw new Error(`Serial Number duplikat dalam penerimaan ini: ${sn}`);
        seen.add(sn);
        if (db.prepare("SELECT 1 FROM tool_serials WHERE sn = ?").get(sn)) throw new Error(`Serial Number sudah terdaftar di sistem: ${sn}`);
      });
      const insertSn = db.prepare("INSERT INTO tool_serials (sn, tool, status, current_ref, received_date, received_ref) VALUES (?, ?, 'Available', NULL, ?, ?)");
      serials.forEach((raw) => insertSn.run(raw.trim(), tool, isoDate(), id));
      addedQty = serials.length;
    } else {
      addedQty = Number(qty) || 0;
      if (addedQty <= 0) throw new Error("Qty harus lebih dari 0");
    }

    db.prepare("INSERT INTO tool_receipts (id, date, tool, qty, note, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, isoDate(), tool, addedQty, note || "", req.user.name);
    adjustToolStock(tool, "available", addedQty);
  });

  try {
    tx();
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }

  res.status(201).json({ id, tool, qty: addedQty, serialized: !!t.serialized });
});

// ---------- Peminjaman Alat (tool checkouts) ----------
function loadCheckout(id) {
  const co = db.prepare("SELECT * FROM tool_checkouts WHERE id = ?").get(id);
  if (!co) return null;
  const items = db.prepare("SELECT tool, qty FROM tool_checkout_items WHERE checkout_id = ?").all(id).map((item) => ({
    ...item,
    serials: db.prepare("SELECT sn FROM tool_serials WHERE current_ref = ? AND tool = ?").all(id, item.tool).map((s) => s.sn),
  }));
  const history = db.prepare("SELECT time, text FROM tool_checkout_history WHERE checkout_id = ? ORDER BY id").all(id);
  return {
    ...co, items, history,
    handoverPhoto: co.handover_photo, returnPhoto: co.return_photo,
    returnCondition: co.return_condition, returnNote: co.return_note,
    expectedReturn: co.expected_return, returnedDate: co.returned_date,
  };
}

function addHistory(id, text) {
  db.prepare("INSERT INTO tool_checkout_history (checkout_id, time, text) VALUES (?, ?, ?)").run(id, new Date().toISOString(), text);
}

router.get("/checkouts", requireAuth, (req, res) => {
  const ids = db.prepare("SELECT id FROM tool_checkouts ORDER BY id DESC").all().map((r) => r.id);
  res.json(ids.map(loadCheckout));
});

router.get("/checkouts/:id", requireAuth, (req, res) => {
  const co = loadCheckout(req.params.id);
  if (!co) return res.status(404).json({ error: "Checkout not found" });
  res.json(co);
});

router.post("/checkouts", requireAuth, requireRole(SPV, TECH, MANAGER), (req, res) => {
  const { homebase, purpose, note, expectedReturn, items } = req.body;
  if (!homebase || !purpose || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "homebase, purpose, and at least one item are required" });
  }
  for (const item of items) {
    const t = db.prepare("SELECT * FROM tools WHERE name = ?").get(item.tool);
    if (!t) return res.status(400).json({ error: `Unknown tool: ${item.tool}` });
    if (item.qty > t.available) return res.status(409).json({ error: `Stock alat ${item.tool} tidak cukup: diminta ${item.qty}, tersedia ${t.available}` });
  }

  const id = dailySequenceId(db, "tool_checkouts", "TC");
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO tool_checkouts (id, requester, homebase, purpose, note, status, date, expected_return) VALUES (?, ?, ?, ?, ?, 'Waiting Approval', ?, ?)`)
      .run(id, req.user.name, homebase, purpose, note || "", isoDate(), expectedReturn || null);
    const insertItem = db.prepare("INSERT INTO tool_checkout_items (checkout_id, tool, qty) VALUES (?, ?, ?)");
    items.forEach((i) => insertItem.run(id, i.tool, i.qty));
    addHistory(id, `Diajukan oleh ${req.user.name} (${req.user.role})`);
  });
  tx();

  res.status(201).json(loadCheckout(id));
});

// Single-stage approval (unlike Delivery's two-stage flow — tools have no
// division complexity, so Logistics/Manager approves AND picks the specific
// units to hand over in one step). Handover photo is optional.
router.post("/checkouts/:id/approve", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const co = loadCheckout(req.params.id);
  if (!co) return res.status(404).json({ error: "Checkout not found" });
  if (co.status !== "Waiting Approval") return res.status(409).json({ error: `Cannot approve status "${co.status}"` });

  const serialSelections = req.body?.serialSelections || {};
  const handoverPhoto = req.body?.handoverPhoto || null;

  const toolRows = {};
  for (const item of co.items) {
    const t = db.prepare("SELECT * FROM tools WHERE name = ?").get(item.tool);
    if (!t || item.qty > t.available) {
      return res.status(409).json({ error: `Stock alat ${item.tool} berubah dan tidak lagi cukup` });
    }
    toolRows[item.tool] = t;
  }

  for (const item of co.items) {
    if (!toolRows[item.tool].serialized) continue;
    const chosen = serialSelections[item.tool];
    if (chosen) {
      if (chosen.length !== item.qty) return res.status(400).json({ error: `Pilih tepat ${item.qty} unit untuk ${item.tool}` });
      if (new Set(chosen).size !== chosen.length) return res.status(400).json({ error: `Ada unit terpilih dua kali untuk ${item.tool}` });
      for (const sn of chosen) {
        const row = db.prepare("SELECT * FROM tool_serials WHERE sn = ?").get(sn);
        if (!row || row.tool !== item.tool || row.status !== "Available") {
          return res.status(409).json({ error: `Serial Number ${sn} tidak tersedia untuk ${item.tool}` });
        }
      }
    } else {
      const available = db.prepare("SELECT COUNT(*) AS n FROM tool_serials WHERE tool = ? AND status = 'Available'").get(item.tool).n;
      if (available < item.qty) return res.status(409).json({ error: `Unit Available untuk ${item.tool} tidak mencukupi` });
    }
  }

  const tx = db.transaction(() => {
    co.items.forEach((item) => {
      adjustToolStock(item.tool, "available", -item.qty);
      adjustToolStock(item.tool, "checked_out", item.qty);
      if (toolRows[item.tool].serialized) {
        const chosen = serialSelections[item.tool]
          || db.prepare("SELECT sn FROM tool_serials WHERE tool = ? AND status = 'Available' ORDER BY sn LIMIT ?").all(item.tool, item.qty).map((r) => r.sn);
        const markOut = db.prepare("UPDATE tool_serials SET status = 'Checked Out', current_ref = ? WHERE sn = ?");
        chosen.forEach((sn) => markOut.run(co.id, sn));
      }
    });
    db.prepare("UPDATE tool_checkouts SET status = 'Checked Out', handover_photo = ? WHERE id = ?").run(handoverPhoto, co.id);
    addHistory(co.id, `Disetujui oleh ${req.user.name} — alat diserahkan`);
  });
  tx();

  res.json(loadCheckout(co.id));
});

router.post("/checkouts/:id/reject", requireAuth, requireRole(LOGISTICS, MANAGER), (req, res) => {
  const co = db.prepare("SELECT * FROM tool_checkouts WHERE id = ?").get(req.params.id);
  if (!co) return res.status(404).json({ error: "Checkout not found" });
  if (co.status !== "Waiting Approval") return res.status(409).json({ error: `Cannot reject status "${co.status}"` });
  db.prepare("UPDATE tool_checkouts SET status = 'Rejected' WHERE id = ?").run(co.id);
  addHistory(co.id, `Ditolak oleh ${req.user.name}`);
  res.json(loadCheckout(co.id));
});

// Return: the whole checkout comes back at once (no partial returns in v1).
// Condition is noted per the transaction as a whole — "Rusak" moves every
// unit in it to Under Repair instead of back to Available.
router.post("/checkouts/:id/return", requireAuth, requireRole(LOGISTICS, MANAGER, SPV, TECH), (req, res) => {
  const co = loadCheckout(req.params.id);
  if (!co) return res.status(404).json({ error: "Checkout not found" });
  if (co.status !== "Checked Out") return res.status(409).json({ error: `Cannot return status "${co.status}"` });

  const { returnCondition, returnNote, returnPhoto } = req.body || {};
  const condition = returnCondition === "Rusak" ? "Rusak" : "Baik";
  const nextSnStatus = condition === "Rusak" ? "Under Repair" : "Available";
  const nextField = condition === "Rusak" ? "under_repair" : "available";

  const tx = db.transaction(() => {
    co.items.forEach((item) => {
      adjustToolStock(item.tool, "checked_out", -item.qty);
      adjustToolStock(item.tool, nextField, item.qty);
      db.prepare(`UPDATE tool_serials SET status = ?, current_ref = NULL WHERE current_ref = ? AND tool = ? AND status = 'Checked Out'`)
        .run(nextSnStatus, co.id, item.tool);
    });
    db.prepare("UPDATE tool_checkouts SET status = 'Returned', return_condition = ?, return_note = ?, return_photo = ?, returned_date = ? WHERE id = ?")
      .run(condition, returnNote || "", returnPhoto || null, isoDate(), co.id);
    addHistory(co.id, `Dikembalikan oleh ${req.user.name} — kondisi: ${condition}`);
  });
  tx();

  res.json(loadCheckout(co.id));
});

module.exports = router;
