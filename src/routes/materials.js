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

module.exports = router;
