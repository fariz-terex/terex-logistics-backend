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
router.post("/areas/import", requireAuth, requireRole(MANAGER), (req, res) => {
  const rows = req.body.rows || [];
  const startCount = db.prepare("SELECT COUNT(*) AS n FROM areas").get().n;
  const seen = new Set();
  const results = rows.map((r, idx) => {
    const errors = [];
    const name = (r.name || "").trim();
    if (!name) errors.push("Area Name kosong");
    else if (db.prepare("SELECT 1 FROM areas WHERE name = ?").get(name)) errors.push("Area Name sudah ada");
    else if (seen.has(name.toLowerCase())) errors.push("Duplikat dalam file ini");
    seen.add(name.toLowerCase());
    return { name, status: r.status || "Active", errors, _seq: startCount + idx + 1 };
  });
  const insert = db.prepare("INSERT INTO areas (code, name, status) VALUES (?, ?, ?)");
  const tx = db.transaction((validRows) => validRows.forEach((r) => insert.run(`AR${String(r._seq).padStart(3, "0")}`, r.name, r.status)));
  const validRows = results.filter((r) => r.errors.length === 0);
  tx(validRows);
  res.json({ imported: validRows.length, total: results.length, results });
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
router.post("/homebases/import", requireAuth, requireRole(MANAGER), (req, res) => {
  const rows = req.body.rows || [];
  const startCount = db.prepare("SELECT COUNT(*) AS n FROM homebases").get().n;
  const seen = new Set();
  const results = rows.map((r, idx) => {
    const errors = [];
    const name = (r.name || "").trim();
    if (!name) errors.push("Nama Homebase kosong");
    else if (db.prepare("SELECT 1 FROM homebases WHERE name = ?").get(name)) errors.push("Nama Homebase sudah ada");
    else if (seen.has(name.toLowerCase())) errors.push("Duplikat dalam file ini");
    if (!r.area) errors.push("Area kosong");
    else if (!db.prepare("SELECT 1 FROM areas WHERE name = ?").get(r.area)) errors.push("Area tidak ditemukan di Master Area");
    seen.add(name.toLowerCase());
    return { name, area: r.area || "", address: r.address || "", pic: r.pic || "", phone: r.phone || "", status: r.status || "Active", errors, _seq: startCount + idx + 1 };
  });
  const insert = db.prepare(`INSERT INTO homebases (code, name, area, address, pic, phone, status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const tx = db.transaction((validRows) => validRows.forEach((r) => insert.run(`HB${String(r._seq).padStart(3, "0")}`, r.name, r.area, r.address, r.pic, r.phone, r.status)));
  const validRows = results.filter((r) => r.errors.length === 0);
  tx(validRows);
  res.json({ imported: validRows.length, total: results.length, results });
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
router.post("/customers/import", requireAuth, requireRole(MANAGER), (req, res) => {
  const rows = req.body.rows || [];
  const startCount = db.prepare("SELECT COUNT(*) AS n FROM customers").get().n;
  const seen = new Set();
  const results = rows.map((r, idx) => {
    const errors = [];
    const name = (r.name || "").trim();
    if (!name) errors.push("Customer Name kosong");
    else if (db.prepare("SELECT 1 FROM customers WHERE name = ?").get(name)) errors.push("Customer Name sudah ada");
    else if (seen.has(name.toLowerCase())) errors.push("Duplikat dalam file ini");
    seen.add(name.toLowerCase());
    return { name, status: r.status || "Active", errors, _seq: startCount + idx + 1 };
  });
  const insert = db.prepare("INSERT INTO customers (id, name, status) VALUES (?, ?, ?)");
  const tx = db.transaction((validRows) => validRows.forEach((r) => insert.run(`CUST${String(r._seq).padStart(3, "0")}`, r.name, r.status)));
  const validRows = results.filter((r) => r.errors.length === 0);
  tx(validRows);
  res.json({ imported: validRows.length, total: results.length, results });
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
  const rows = db.prepare("SELECT id, name, username, role, assignment, customer, status FROM users ORDER BY name").all();
  res.json(rows);
});
router.post("/users", requireAuth, requireRole(MANAGER), (req, res) => {
  const { name, username, password, role, assignment, customer } = req.body;
  if (!name || !username || !password || !role) return res.status(400).json({ error: "name, username, password, role are required" });
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username.toLowerCase())) return res.status(409).json({ error: "Username already taken" });
  // Logistics Staff / SPV / Technician are scoped to one division (Customer)
  // each — Manager stays unscoped (sees every division) regardless of what's sent.
  if (role !== MANAGER) {
    if (!customer?.trim()) return res.status(400).json({ error: "Divisi (Customer) wajib diisi untuk role ini" });
    if (!db.prepare("SELECT 1 FROM customers WHERE name = ?").get(customer)) return res.status(400).json({ error: `Customer "${customer}" tidak ditemukan di Master Customer` });
  }
  const id = paddedSequenceId(db, "users", "USR");
  const hash = bcrypt.hashSync(password, 10);
  const finalCustomer = role === MANAGER ? null : customer;
  db.prepare(`INSERT INTO users (id, name, username, password_hash, role, assignment, customer, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'Active')`)
    .run(id, name, username.toLowerCase(), hash, role, assignment || "", finalCustomer);
  res.status(201).json({ id, name, username: username.toLowerCase(), role, assignment: assignment || "", customer: finalCustomer, status: "Active" });
});
router.patch("/users/:id/toggle-status", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "User not found" });
  const next = row.status === "Active" ? "Inactive" : "Active";
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(next, row.id);
  res.json({ id: row.id, name: row.name, username: row.username, role: row.role, assignment: row.assignment, customer: row.customer, status: next });
});

const VALID_ROLES = ["Admin / Manager Logistics", "Logistics Staff", "SPV", "Technician"];

router.patch("/users/:id", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "User not found" });

  const { name, username, role, assignment, password, customer } = req.body;

  if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: `Invalid role: ${role}` });

  let nextUsername = row.username;
  if (username && username.trim().toLowerCase() !== row.username) {
    nextUsername = username.trim().toLowerCase();
    if (!nextUsername) return res.status(400).json({ error: "Username cannot be empty" });
    if (db.prepare("SELECT 1 FROM users WHERE username = ? AND id != ?").get(nextUsername, row.id)) {
      return res.status(409).json({ error: "Username already taken" });
    }
  }

  const nextName = name?.trim() ? name.trim() : row.name;
  const nextRole = role || row.role;
  const nextAssignment = assignment !== undefined ? assignment : row.assignment;
  // Password is optional on edit — blank/omitted means "keep the current password".
  const nextHash = password?.trim() ? bcrypt.hashSync(password, 10) : row.password_hash;

  let nextCustomer = customer !== undefined ? customer : row.customer;
  if (nextRole === MANAGER) {
    nextCustomer = null; // Manager is always unscoped, regardless of what was previously set
  } else {
    if (!nextCustomer?.trim()) return res.status(400).json({ error: "Divisi (Customer) wajib diisi untuk role ini" });
    if (!db.prepare("SELECT 1 FROM customers WHERE name = ?").get(nextCustomer)) return res.status(400).json({ error: `Customer "${nextCustomer}" tidak ditemukan di Master Customer` });
  }

  db.prepare("UPDATE users SET name = ?, username = ?, role = ?, assignment = ?, password_hash = ?, customer = ? WHERE id = ?")
    .run(nextName, nextUsername, nextRole, nextAssignment, nextHash, nextCustomer, row.id);

  res.json({ id: row.id, name: nextName, username: nextUsername, role: nextRole, assignment: nextAssignment, customer: nextCustomer, status: row.status });
});

module.exports = router;
