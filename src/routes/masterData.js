const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { paddedSequenceId } = require("../utils/ids");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";

// ---------- Areas ----------
router.get("/areas", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM areas ORDER BY name").all());
});
router.post("/areas", requireAuth, requireRole(MANAGER), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const code = paddedSequenceId(db, "areas", "AR");
  db.prepare("INSERT INTO areas (code, name, status) VALUES (?, ?, 'Active')").run(code, name);
  res.status(201).json(db.prepare("SELECT * FROM areas WHERE code = ?").get(code));
});
router.patch("/areas/:code/toggle-status", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM areas WHERE code = ?").get(req.params.code);
  if (!row) return res.status(404).json({ error: "Area not found" });
  const next = row.status === "Active" ? "Inactive" : "Active";
  db.prepare("UPDATE areas SET status = ? WHERE code = ?").run(next, row.code);
  res.json(db.prepare("SELECT * FROM areas WHERE code = ?").get(row.code));
});

// ---------- Homebases ----------
router.get("/homebases", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM homebases ORDER BY name").all());
});
router.post("/homebases", requireAuth, requireRole(MANAGER), (req, res) => {
  const { name, area, address, pic, phone } = req.body;
  if (!name || !area) return res.status(400).json({ error: "name and area are required" });
  const areaExists = db.prepare("SELECT 1 FROM areas WHERE name = ?").get(area);
  if (!areaExists) return res.status(400).json({ error: `Area "${area}" not found in Master Area` });
  const code = paddedSequenceId(db, "homebases", "HB");
  db.prepare(`INSERT INTO homebases (code, name, area, address, pic, phone, status) VALUES (?, ?, ?, ?, ?, ?, 'Active')`)
    .run(code, name, area, address || "", pic || "", phone || "");
  res.status(201).json(db.prepare("SELECT * FROM homebases WHERE code = ?").get(code));
});
router.patch("/homebases/:code/toggle-status", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM homebases WHERE code = ?").get(req.params.code);
  if (!row) return res.status(404).json({ error: "Homebase not found" });
  const next = row.status === "Active" ? "Inactive" : "Active";
  db.prepare("UPDATE homebases SET status = ? WHERE code = ?").run(next, row.code);
  res.json(db.prepare("SELECT * FROM homebases WHERE code = ?").get(row.code));
});

// ---------- Customers ----------
router.get("/customers", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM customers ORDER BY name").all());
});
router.post("/customers", requireAuth, requireRole(MANAGER), (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const id = paddedSequenceId(db, "customers", "CUST");
  db.prepare("INSERT INTO customers (id, name, status) VALUES (?, ?, 'Active')").run(id, name);
  res.status(201).json(db.prepare("SELECT * FROM customers WHERE id = ?").get(id));
});
router.patch("/customers/:id/toggle-status", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Customer not found" });
  const next = row.status === "Active" ? "Inactive" : "Active";
  db.prepare("UPDATE customers SET status = ? WHERE id = ?").run(next, row.id);
  res.json(db.prepare("SELECT * FROM customers WHERE id = ?").get(row.id));
});

// ---------- Sites (incl. bulk import, matches Master Site CSV import) ----------
router.get("/sites", requireAuth, (req, res) => {
  res.json(db.prepare("SELECT * FROM sites ORDER BY name").all());
});
router.post("/sites/import", requireAuth, requireRole(MANAGER), (req, res) => {
  const rows = req.body.rows || [];
  const results = rows.map((r) => {
    const errors = [];
    if (!r.code) errors.push("Site Code kosong");
    else if (db.prepare("SELECT 1 FROM sites WHERE code = ?").get(r.code)) errors.push("Site Code duplikat");
    if (!r.name) errors.push("Nama Site kosong");
    if (!r.homebase) errors.push("Homebase kosong");
    else if (!db.prepare("SELECT 1 FROM homebases WHERE name = ?").get(r.homebase)) errors.push("Homebase tidak ditemukan di Master Homebase");
    return { ...r, errors };
  });

  const insert = db.prepare(`INSERT INTO sites (code, terminal_id, name, customer, area, homebase, status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction((validRows) => {
    validRows.forEach((r) => insert.run(r.code, r.terminalId || "", r.name, r.customer || "", r.area || "", r.homebase, r.status || "Active"));
  });
  const validRows = results.filter((r) => r.errors.length === 0);
  tx(validRows);

  res.json({ imported: validRows.length, total: results.length, results });
});
router.post("/sites", requireAuth, requireRole(MANAGER), (req, res) => {
  const { code, terminalId, name, customer, area, homebase, status } = req.body;
  if (!code || !name || !homebase) return res.status(400).json({ error: "code, name, homebase are required" });
  if (db.prepare("SELECT 1 FROM sites WHERE code = ?").get(code)) return res.status(409).json({ error: "Site Code already exists" });
  db.prepare(`INSERT INTO sites (code, terminal_id, name, customer, area, homebase, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(code, terminalId || "", name, customer || "", area || "", homebase, status || "Active");
  res.status(201).json(db.prepare("SELECT * FROM sites WHERE code = ?").get(code));
});

// ---------- Users ----------
router.get("/users", requireAuth, requireRole(MANAGER), (req, res) => {
  const rows = db.prepare("SELECT id, name, username, role, assignment, status FROM users ORDER BY name").all();
  res.json(rows);
});
router.post("/users", requireAuth, requireRole(MANAGER), (req, res) => {
  const { name, username, password, role, assignment } = req.body;
  if (!name || !username || !password || !role) return res.status(400).json({ error: "name, username, password, role are required" });
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username.toLowerCase())) return res.status(409).json({ error: "Username already taken" });
  const id = paddedSequenceId(db, "users", "USR");
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (id, name, username, password_hash, role, assignment, status) VALUES (?, ?, ?, ?, ?, ?, 'Active')`)
    .run(id, name, username.toLowerCase(), hash, role, assignment || "");
  res.status(201).json({ id, name, username: username.toLowerCase(), role, assignment: assignment || "", status: "Active" });
});
router.patch("/users/:id/toggle-status", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "User not found" });
  const next = row.status === "Active" ? "Inactive" : "Active";
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(next, row.id);
  res.json({ id: row.id, name: row.name, username: row.username, role: row.role, assignment: row.assignment, status: next });
});

module.exports = router;
