const db = require("../db");

const MANAGER = "Admin / Manager Logistics";

// Manager is unscoped (sees/acts on every division). Everyone else is
// pinned to their assigned division (Customer).
function scopeOf(user) {
  return user.role === MANAGER ? null : (user.customer || null);
}

// A division's stock row for a material, or all zeros if that division has
// never received any of it.
function getDivisionStock(material, customer) {
  return db.prepare("SELECT * FROM material_stock WHERE material = ? AND customer = ?").get(material, customer)
    || { ready: 0, faulty: 0, reserved: 0, in_transit: 0 };
}

// Applies a signed delta to a division's stock row (creating it at zero
// first if needed) and mirrors the same delta into materials' global
// aggregate, so Manager's unscoped view always matches the sum across every
// division. Call once per (material, field, delta) inside a transaction.
function adjustStock(material, customer, field, delta) {
  db.prepare(`INSERT INTO material_stock (material, customer) VALUES (?, ?) ON CONFLICT(material, customer) DO NOTHING`).run(material, customer);
  db.prepare(`UPDATE material_stock SET ${field} = MAX(0, ${field} + ?) WHERE material = ? AND customer = ?`).run(delta, material, customer);
  db.prepare(`UPDATE materials SET ${field} = MAX(0, ${field} + ?) WHERE name = ?`).run(delta, material);
}

module.exports = { scopeOf, getDivisionStock, adjustStock, MANAGER };
