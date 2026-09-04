const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { paddedSequenceId } = require("../utils/ids");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";

// SQLite's FK enforcement already blocks deleting a row still referenced
// elsewhere (Area used by a Homebase, Homebase used by a Site, etc.) — this
// just turns that raw "FOREIGN KEY constraint failed" into something a
// person can actually act on, instead of a cryptic SQLite message.
function runDelete(res, sql, param, entityLabel) {
  try {
    const result = db.prepare(sql).run(param);
    if (result.changes === 0) return res.status(404).json({ error: `${entityLabel} not found` });
    return res.json({ deleted: param });
  } catch (err) {
    if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY" || /FOREIGN KEY/i.test(err.message)) {
      return res.status(409).json({ error: `Tidak bisa dihapus — ${entityLabel} ini masih dipakai di data lain (mis. Site, Homebase, atau riwayat transaksi)` });
    }
    throw err;
  }
}

function runBulkDelete(res, sql, codes, entityLabel) {
  if (!Array.isArray(codes) || codes.length === 0) return res.status(400).json({ error: `Pilih minimal satu ${entityLabel}` });
  const del = db.prepare(sql);
  let deleted = 0;
  const blocked = [];
  const tx = db.transaction((list) => {
    list.forEach((c) => {
      try {
        deleted += del.run(c).changes;
      } catch (err) {
        if (err.code === "SQLITE_CONSTRAINT_FOREIGNKEY" || /FOREIGN KEY/i.test(err.message)) blocked.push(c);
        else throw err;
      }
    });
  });
  tx(codes);
  res.json({ deleted, blocked });
}

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
router.delete("/areas/:code", requireAuth, requireRole(MANAGER), (req, res) => {
  runDelete(res, "DELETE FROM areas WHERE code = ?", req.params.code, "Area");
});
router.post("/areas/bulk-delete", requireAuth, requireRole(MANAGER), (req, res) => {
  runBulkDelete(res, "DELETE FROM areas WHERE code = ?", req.body.codes, "Area");
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
router.delete("/homebases/:code", requireAuth, requireRole(MANAGER), (req, res) => {
  runDelete(res, "DELETE FROM homebases WHERE code = ?", req.params.code, "Homebase");
});
router.post("/homebases/bulk-delete", requireAuth, requireRole(MANAGER), (req, res) => {
  runBulkDelete(res, "DELETE FROM homebases WHERE code = ?", req.body.codes, "Homebase");
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

// Customer has no formal FK from anywhere (every other table just stores
// its name as plain text), so SQLite won't protect it automatically the
// way Area/Homebase/Material/Tools are — this checks the same tables the
// rest of the app actually scopes by by hand before allowing a delete.
const CUSTOMER_DEPENDENT_TABLES = [
  { table: "user_divisions", column: "customer", label: "User" },
  { table: "sites", column: "customer", label: "Master Site" },
  { table: "deliveries", column: "customer", label: "Delivery Request" },
  { table: "returns", column: "customer", label: "Return Material Faulty" },
  { table: "reconciliations", column: "customer", label: "Reconciliation" },
  { table: "material_stock", column: "customer", label: "stock material" },
  { table: "serial_numbers", column: "customer", label: "Serial Number" },
];
function customerInUse(name) {
  for (const { table, column, label } of CUSTOMER_DEPENDENT_TABLES) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(name);
    if (row.n > 0) return label;
  }
  return null;
}
router.delete("/customers/:id", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Customer not found" });
  const usedBy = customerInUse(row.name);
  if (usedBy) return res.status(409).json({ error: `Tidak bisa dihapus — divisi ini masih dipakai di data ${usedBy}` });
  db.prepare("DELETE FROM customers WHERE id = ?").run(row.id);
  res.json({ deleted: row.id });
});
router.post("/customers/bulk-delete", requireAuth, requireRole(MANAGER), (req, res) => {
  const ids = Array.isArray(req.body.codes) ? req.body.codes : [];
  if (ids.length === 0) return res.status(400).json({ error: "Pilih minimal satu Customer" });
  let deleted = 0;
  const blocked = [];
  const tx = db.transaction((list) => {
    list.forEach((id) => {
      const row = db.prepare("SELECT * FROM customers WHERE id = ?").get(id);
      if (!row) return;
      if (customerInUse(row.name)) { blocked.push(id); return; }
      db.prepare("DELETE FROM customers WHERE id = ?").run(id);
      deleted += 1;
    });
  });
  tx(ids);
  res.json({ deleted, blocked });
});

// ---------- Clusters (PIM sub-allocations within a division) ----------
// Read is open to any authenticated user (the Goods Receipt form needs the
// list to populate its dropdown); writes are Manager-only, same as every
// other master. Optional ?customer= filter so the receipt form can ask for
// just the active clusters of the division being received into.
router.get("/clusters", requireAuth, (req, res) => {
  const { customer, status } = req.query;
  let sql = "SELECT * FROM clusters WHERE 1=1";
  const params = [];
  if (customer) { sql += " AND customer = ?"; params.push(customer); }
  if (status) { sql += " AND status = ?"; params.push(status); }
  sql += " ORDER BY name";
  res.json(db.prepare(sql).all(...params));
});
router.post("/clusters", requireAuth, requireRole(MANAGER), (req, res) => {
  const { name, customer, pic } = req.body;
  if (!name || !customer) return res.status(400).json({ error: "name and customer are required" });
  if (!db.prepare("SELECT 1 FROM customers WHERE name = ?").get(customer)) {
    return res.status(400).json({ error: `Customer "${customer}" tidak ditemukan di Master Customer` });
  }
  if (db.prepare("SELECT 1 FROM clusters WHERE name = ? AND customer = ?").get(name, customer)) {
    return res.status(409).json({ error: `Cluster "${name}" sudah ada untuk divisi ${customer}` });
  }
  const code = paddedSequenceId(db, "clusters", "CL");
  db.prepare("INSERT INTO clusters (code, name, customer, pic, status) VALUES (?, ?, ?, ?, 'Active')")
    .run(code, name, customer, pic || "");
  res.status(201).json(db.prepare("SELECT * FROM clusters WHERE code = ?").get(code));
});
router.patch("/clusters/:code/toggle-status", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM clusters WHERE code = ?").get(req.params.code);
  if (!row) return res.status(404).json({ error: "Cluster not found" });
  const next = row.status === "Active" ? "Inactive" : "Active";
  db.prepare("UPDATE clusters SET status = ? WHERE code = ?").run(next, row.code);
  res.json(db.prepare("SELECT * FROM clusters WHERE code = ?").get(row.code));
});

// Like Customer, cluster has no formal FK from serial_numbers (it's a plain
// text column there), so guard the delete by hand: a cluster that's tagged
// on any unit, or referenced by any transfer, can't be removed.
function clusterInUse(name, customer) {
  const onUnit = db.prepare("SELECT COUNT(*) AS n FROM serial_numbers WHERE cluster = ? AND customer = ?").get(name, customer).n;
  if (onUnit > 0) return "Serial Number";
  const onTransfer = db.prepare("SELECT COUNT(*) AS n FROM cluster_transfers WHERE (cluster_from = ? OR cluster_to = ?) AND customer = ?").get(name, name, customer).n;
  if (onTransfer > 0) return "Transfer Antar Cluster";
  return null;
}
router.delete("/clusters/:code", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM clusters WHERE code = ?").get(req.params.code);
  if (!row) return res.status(404).json({ error: "Cluster not found" });
  const usedBy = clusterInUse(row.name, row.customer);
  if (usedBy) return res.status(409).json({ error: `Tidak bisa dihapus — cluster ini masih dipakai di data ${usedBy}` });
  db.prepare("DELETE FROM clusters WHERE code = ?").run(row.code);
  res.json({ deleted: row.code });
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
router.patch("/sites/:code/toggle-status", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM sites WHERE code = ?").get(req.params.code);
  if (!row) return res.status(404).json({ error: "Site not found" });
  const next = row.status === "Active" ? "Inactive" : "Active";
  db.prepare("UPDATE sites SET status = ? WHERE code = ?").run(next, row.code);
  res.json(db.prepare("SELECT * FROM sites WHERE code = ?").get(row.code));
});

// Permanent delete — unlike the rest of Master Data (which only ever
// toggles Active/Inactive), Site supports a real delete because bulk
// imports are the primary way this table gets populated, and a bad import
// (wrong column mapping, wrong file) needs a clean way to undo itself
// rather than leaving hundreds of Inactive junk rows behind.
router.delete("/sites/:code", requireAuth, requireRole(MANAGER), (req, res) => {
  const result = db.prepare("DELETE FROM sites WHERE code = ?").run(req.params.code);
  if (result.changes === 0) return res.status(404).json({ error: "Site not found" });
  res.json({ deleted: req.params.code });
});

// Bulk delete by a list of codes — the practical case is undoing an entire
// bad import in one action instead of hundreds of individual clicks.
router.post("/sites/bulk-delete", requireAuth, requireRole(MANAGER), (req, res) => {
  const codes = Array.isArray(req.body.codes) ? req.body.codes : [];
  if (codes.length === 0) return res.status(400).json({ error: "Pilih minimal satu Site Code" });
  const del = db.prepare("DELETE FROM sites WHERE code = ?");
  const tx = db.transaction((list) => {
    let count = 0;
    list.forEach((c) => { count += del.run(c).changes; });
    return count;
  });
  const deleted = tx(codes);
  res.json({ deleted });
});

// ---------- Users ----------
router.get("/users", requireAuth, requireRole(MANAGER), (req, res) => {
  const rows = db.prepare("SELECT id, name, username, role, assignment, status FROM users ORDER BY name").all();
  const divisionRows = db.prepare("SELECT user_id, customer FROM user_divisions").all();
  const divisionsByUser = {};
  divisionRows.forEach((r) => { (divisionsByUser[r.user_id] ||= []).push(r.customer); });
  res.json(rows.map((u) => ({ ...u, customers: (divisionsByUser[u.id] || []).sort() })));
});
router.post("/users", requireAuth, requireRole(MANAGER), (req, res) => {
  const { name, username, password, role, assignment, customers } = req.body;
  if (!name || !username || !password || !role) return res.status(400).json({ error: "name, username, password, role are required" });
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username.toLowerCase())) return res.status(409).json({ error: "Username already taken" });
  // Logistics Staff / SPV / Technician are scoped to one or more divisions
  // (Customer) — Manager stays unscoped (sees every division) regardless of
  // what's sent.
  const divisionList = Array.isArray(customers) ? customers.filter((c) => c?.trim()) : [];
  if (role !== MANAGER) {
    if (divisionList.length === 0) return res.status(400).json({ error: "Minimal satu Divisi (Customer) wajib diisi untuk role ini" });
    for (const c of divisionList) {
      if (!db.prepare("SELECT 1 FROM customers WHERE name = ?").get(c)) return res.status(400).json({ error: `Customer "${c}" tidak ditemukan di Master Customer` });
    }
  }
  const id = paddedSequenceId(db, "users", "USR");
  const hash = bcrypt.hashSync(password, 10);
  const finalDivisions = role === MANAGER ? [] : divisionList;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO users (id, name, username, password_hash, role, assignment, status) VALUES (?, ?, ?, ?, ?, ?, 'Active')`)
      .run(id, name, username.toLowerCase(), hash, role, assignment || "");
    const insertDivision = db.prepare("INSERT INTO user_divisions (user_id, customer) VALUES (?, ?)");
    finalDivisions.forEach((c) => insertDivision.run(id, c));
  });
  tx();
  res.status(201).json({ id, name, username: username.toLowerCase(), role, assignment: assignment || "", customers: finalDivisions.sort(), status: "Active" });
});
router.patch("/users/:id/toggle-status", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "User not found" });
  const next = row.status === "Active" ? "Inactive" : "Active";
  db.prepare("UPDATE users SET status = ? WHERE id = ?").run(next, row.id);
  const divisions = db.prepare("SELECT customer FROM user_divisions WHERE user_id = ? ORDER BY customer").all(row.id).map((r) => r.customer);
  res.json({ id: row.id, name: row.name, username: row.username, role: row.role, assignment: row.assignment, customers: divisions, status: next });
});

const VALID_ROLES = ["Admin / Manager Logistics", "Logistics Staff", "SPV", "Technician", "Manager Divisi"];

router.patch("/users/:id", requireAuth, requireRole(MANAGER), (req, res) => {
  const row = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "User not found" });

  const { name, username, role, assignment, password, customers } = req.body;

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

  // Only touch division membership if the caller actually sent a list —
  // otherwise leave whatever's already assigned untouched (e.g. a
  // name-only edit shouldn't wipe someone's divisions).
  let nextDivisions = null;
  if (nextRole === MANAGER) {
    nextDivisions = []; // Manager is always unscoped, regardless of what was previously set
  } else if (customers !== undefined) {
    nextDivisions = Array.isArray(customers) ? customers.filter((c) => c?.trim()) : [];
    if (nextDivisions.length === 0) return res.status(400).json({ error: "Minimal satu Divisi (Customer) wajib diisi untuk role ini" });
    for (const c of nextDivisions) {
      if (!db.prepare("SELECT 1 FROM customers WHERE name = ?").get(c)) return res.status(400).json({ error: `Customer "${c}" tidak ditemukan di Master Customer` });
    }
  } else {
    const existing = db.prepare("SELECT COUNT(*) AS n FROM user_divisions WHERE user_id = ?").get(row.id).n;
    if (existing === 0) return res.status(400).json({ error: "Minimal satu Divisi (Customer) wajib diisi untuk role ini" });
  }

  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET name = ?, username = ?, role = ?, assignment = ?, password_hash = ? WHERE id = ?")
      .run(nextName, nextUsername, nextRole, nextAssignment, nextHash, row.id);
    if (nextDivisions !== null) {
      db.prepare("DELETE FROM user_divisions WHERE user_id = ?").run(row.id);
      const insertDivision = db.prepare("INSERT INTO user_divisions (user_id, customer) VALUES (?, ?)");
      nextDivisions.forEach((c) => insertDivision.run(row.id, c));
    }
  });
  tx();

  const finalDivisions = db.prepare("SELECT customer FROM user_divisions WHERE user_id = ? ORDER BY customer").all(row.id).map((r) => r.customer);
  res.json({ id: row.id, name: nextName, username: nextUsername, role: nextRole, assignment: nextAssignment, customers: finalDivisions, status: row.status });
});

module.exports = router;
