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
  if (db.prepare("SELECT 1 FROM materials WHERE name = ?").get(name)) return res.status(409).json({ error: "Material Name sudah ada" });

  const id = paddedSequenceId(db, "materials", "MAT", "id");
  db.prepare(`
    INSERT INTO materials (id, name, category, unit, serialized, min_stock, status, ready, faulty, reserved, in_transit)
    VALUES (?, ?, ?, ?, ?, ?, 'Active', 0, 0, 0, 0)
  `).run(id, name, category, unit || "Unit", serialized ? 1 : 0, minStock || 0);

  res.status(201).json(serialize(db.prepare("SELECT * FROM materials WHERE id = ?").get(id)));
});

// Renames a material (e.g. fixing a typo). materials.name isn't just a
// label — it's referenced by name (not id) across a dozen tables, so a
// rename has to cascade everywhere that value is stored or every existing
// stock/history row would silently detach from the renamed material.
// Every table below has a plain `material` (or old_material/new_material)
// TEXT column that stores the name, whether or not it carries a formal FK.
const MATERIAL_NAME_CASCADE = [
  ["material_stock", "material"],
  ["material_stock_homebase", "material"],
  ["stock_movements", "material"],
  ["delivery_items", "material"],
  ["return_items", "material"],
  ["reconciliation_items", "material"],
  ["serial_numbers", "material"],
  ["stock_transfers", "material"],
  ["faulty_customer_returns", "material"],
  ["automation_log", "material"],
  ["receipts", "material"],
  ["material_swaps", "old_material"],
  ["material_swaps", "new_material"],
  ["cluster_transfers", "material"],
];

router.patch("/:id", requireAuth, requireRole(MANAGER), (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Nama material tidak boleh kosong" });

  const material = db.prepare("SELECT * FROM materials WHERE id = ?").get(req.params.id);
  if (!material) return res.status(404).json({ error: "Material not found" });
  if (name === material.name) return res.json(serialize(material));

  const clash = db.prepare("SELECT 1 FROM materials WHERE name = ? AND id != ?").get(name, material.id);
  if (clash) return res.status(409).json({ error: "Material Name sudah ada" });

  // Several of the cascaded tables have a real FK to materials(name), so
  // renaming the parent row would fail the moment it no longer matches
  // those child rows (and vice versa) — FK enforcement has to be off for
  // this rename, same as the users-table rebuild migration in db.js
  // (PRAGMA foreign_keys can't be toggled inside a transaction).
  const tx = db.transaction(() => {
    db.prepare("UPDATE materials SET name = ? WHERE id = ?").run(name, material.id);
    for (const [table, column] of MATERIAL_NAME_CASCADE) {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(name, material.name);
    }
  });
  db.pragma("foreign_keys = OFF");
  try {
    tx();
  } finally {
    db.pragma("foreign_keys = ON");
  }

  res.json(serialize(db.prepare("SELECT * FROM materials WHERE id = ?").get(material.id)));
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

// Shows exactly what a full cascade wipe would take with it, before
// anyone commits to it — every Delivery Request / Return / Reconciliation
// that has ever included this material as a line item, plus its stock
// history. Delivery/Return/Reconciliation sub-tables (items, history,
// photos) all cascade automatically via ON DELETE CASCADE once the parent
// row goes, so this only needs to count the parents themselves plus the
// standalone stock tables.
router.get("/:id/cascade-preview", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM materials WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Material not found" });
  const name = row.name;
  const count = (sql) => db.prepare(sql).get(name).n;
  res.json({
    material: name,
    deliveries: count("SELECT COUNT(DISTINCT delivery_id) AS n FROM delivery_items WHERE material = ?"),
    returns: count("SELECT COUNT(DISTINCT return_id) AS n FROM return_items ri JOIN returns r ON r.id = ri.return_id WHERE ri.material = ?"),
    reconciliations: count("SELECT COUNT(DISTINCT reconciliation_id) AS n FROM reconciliation_items WHERE material = ?"),
    serialNumbers: count("SELECT COUNT(*) AS n FROM serial_numbers WHERE material = ?"),
    receipts: count("SELECT COUNT(*) AS n FROM receipts WHERE material = ?"),
    stockMovements: count("SELECT COUNT(*) AS n FROM stock_movements WHERE material = ?"),
  });
});

// Actually performs the wipe described by the preview above. Deliberately
// separate from the plain DELETE endpoint (which stays FK-protected) so
// this destructive path always requires having seen the preview counts
// first — never a silent surprise.
router.delete("/:id/force", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM materials WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Material not found" });
  const name = row.name;

  const tx = db.transaction(() => {
    const deliveryIds = db.prepare("SELECT DISTINCT delivery_id AS id FROM delivery_items WHERE material = ?").all(name).map((r) => r.id);
    deliveryIds.forEach((id) => db.prepare("DELETE FROM deliveries WHERE id = ?").run(id));

    const returnIds = db.prepare("SELECT DISTINCT r.id AS id FROM returns r JOIN return_items ri ON ri.return_id = r.id WHERE ri.material = ?").all(name).map((r) => r.id);
    returnIds.forEach((id) => db.prepare("DELETE FROM returns WHERE id = ?").run(id));

    const reconIds = db.prepare("SELECT DISTINCT reconciliation_id AS id FROM reconciliation_items WHERE material = ?").all(name).map((r) => r.id);
    reconIds.forEach((id) => db.prepare("DELETE FROM reconciliations WHERE id = ?").run(id));

    db.prepare("DELETE FROM serial_numbers WHERE material = ?").run(name);
    db.prepare("DELETE FROM material_stock WHERE material = ?").run(name);
    db.prepare("DELETE FROM receipts WHERE material = ?").run(name);
    db.prepare("DELETE FROM stock_movements WHERE material = ?").run(name);
    db.prepare("DELETE FROM materials WHERE id = ?").run(row.id);
  });
  tx();

  res.json({ deleted: row.id });
});

module.exports = router;
