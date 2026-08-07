const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT * FROM materials ORDER BY name").all();
  res.json(rows.map((r) => ({ ...r, serialized: !!r.serialized })));
});

router.get("/movements", requireAuth, (req, res) => {
  const { material } = req.query;
  const rows = material
    ? db.prepare("SELECT * FROM stock_movements WHERE material = ? ORDER BY id DESC").all(material)
    : db.prepare("SELECT * FROM stock_movements ORDER BY id DESC").all();
  res.json(rows);
});

module.exports = router;
