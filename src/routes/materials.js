const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { paddedSequenceId } = require("../utils/ids");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";

function serialize(row) {
  return { ...row, serialized: !!row.serialized };
}

router.get("/", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM materials ORDER BY name").all();
  res.json(rows.map(serialize));
});

router.post("/", requireAuth, requireRole(MANAGER), (req, res) => {
  const { name, category, unit, serialized, minStock } = req.body;
  if (!name || !category) return res.status(400).json({ error: "name and category are required" });

  const id = paddedSequenceId(db, "materials", "MAT");
  db.prepare(`
    INSERT INTO materials (id, name, category, unit, serialized, min_stock, status, ready, faulty, reserved, in_transit)
    VALUES (?, ?, ?, ?, ?, ?, 'Active', 0, 0, 0, 0)
  `).run(id, name, category, unit || "Unit", serialized ? 1 : 0, minStock || 0);

  res.status(201).json(serialize(db.prepare("SELECT * FROM materials WHERE id = ?").get(id)));
});

router.patch("/:id/toggle-status", requireAuth, requireRole(MANAGER), (req, res) => {
  const material = db.prepare("SELECT * FROM materials WHERE id = ?").get(req.params.id);
  if (!material) return res.status(404).json({ error: "Material not found" });
  const nextStatus = material.status === "Active" ? "Inactive" : "Active";
  db.prepare("UPDATE materials SET status = ? WHERE id = ?").run(nextStatus, material.id);
  res.json(serialize(db.prepare("SELECT * FROM materials WHERE id = ?").get(material.id)));
});

router.post("/import", requireAuth, requireRole(MANAGER), (req, res) => {
  const rows = req.body.rows || [];
  const startCount = db.prepare("SELECT COUNT(*) AS n FROM materials").get().n;
  const seenNames = new Set();
  const results = rows.map((r, idx) => {
    const errors = [];
    const name = (r.name || "").trim();
    if (!name) errors.push("Material Name kosong");
    else if (db.prepare("SELECT 1 FROM materials WHERE name = ?").get(name)) errors.push("Material Name sudah ada");
    else if (seenNames.has(name.toLowerCase())) errors.push("Duplikat dalam file ini");
    if (!r.category) errors.push("Category kosong");
    seenNames.add(name.toLowerCase());
    return { name, category: r.category || "", unit: r.unit || "Unit", serialized: r.serialized, minStock: Number(r.minStock) || 0, status: r.status || "Active", errors, _seq: startCount + idx + 1 };
  });

  const insert = db.prepare(`INSERT INTO materials (id, name, category, unit, serialized, min_stock, status, ready, faulty, reserved, in_transit) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`);
  const tx = db.transaction((validRows) => {
    validRows.forEach((r) => insert.run(`MAT${String(r._seq).padStart(3, "0")}`, r.name, r.category, r.unit, r.serialized ? 1 : 0, r.minStock, r.status));
  });
  const validRows = results.filter((r) => r.errors.length === 0);
  tx(validRows);

  res.json({ imported: validRows.length, total: results.length, results });
});

// SQLite's FK (material_stock/receipts/stock_movements/serial_numbers all
// REFERENCE materials(name)) already blocks deleting a material with any
// real history — this just turns that raw constraint error into a message
// someone can act on.
router.delete("/:id", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM materials WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Material not found" });
  try {
    db.prepare("DELETE FROM materials WHERE id = ?").run(row.id);
    res.json({ deleted: row.id });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY" || /FOREIGN KEY/i.test(err.message)) {
      return res.status(409).json({ error: "Tidak bisa dihapus — material ini sudah punya riwayat stock/transaksi" });
    }
    throw err;
  }
});
router.post("/bulk-delete", requireAuth, requireRole(MANAGER), (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length === 0) return res.status(400).json({ error: "Pilih minimal satu Material" });
  let deleted = 0;
  const blocked = [];
  const tx = db.transaction((list) => {
    list.forEach((id) => {
      try {
        const result = db.prepare("DELETE FROM materials WHERE id = ?").run(id);
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

module.exports = router;
