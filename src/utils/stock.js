const db = require("../db");

const MANAGER = "Admin / Manager Logistics";

// Manager is unscoped (sees/acts on every division). Everyone else is
// scoped to one or more assigned divisions (Customer) — a user can now
// cover multiple customers at once (e.g. a Logistics Staff handling two
// accounts), so this always returns an array, never a single string:
//   null       -> unscoped (Manager)
//   []         -> scoped, but no divisions assigned (sees/does nothing —
//                 not the same as unscoped, this is a misconfigured account)
//   [a, b, …]  -> scoped to exactly these divisions
function scopeOf(user) {
  if (user.role === MANAGER) return null;
  return Array.isArray(user.customers) ? user.customers : [];
}

// True if a scope (from scopeOf) permits acting on the given division.
// Manager (scope === null) is always allowed.
function scopeAllows(scope, customer) {
  return !scope || scope.includes(customer);
}

// Builds a "column IN (?, ?, …)" fragment plus its bound params for a scope
// array. Callers must check scope.length > 0 first — an empty IN() is
// invalid SQL, and semantically a user with zero divisions should see zero
// rows rather than however "IN ()" happens to behave.
function scopeClause(column, scope) {
  return { sql: `${column} IN (${scope.map(() => "?").join(",")})`, params: scope };
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

// Same idea as getDivisionStock/adjustStock above, but for the separate
// consumables table — kept as distinct functions rather than
// parameterizing the table name, since consumables only ever has
// ready/reserved/in_transit (no faulty) and mixing the two models would
// make both harder to reason about. Consumable is a SHARED, un-divisioned
// pool (same reasoning as Tools) — there is no per-division breakdown at
// all, so this just touches the consumables row directly.
function adjustConsumable(consumable, field, delta) {
  db.prepare(`UPDATE consumables SET ${field} = MAX(0, ${field} + ?) WHERE name = ?`).run(delta, consumable);
}

// A user's assigned divisions, straight from the DB (used at login time to
// build the JWT payload, and anywhere else the current list is needed).
function getUserDivisions(userId) {
  return db.prepare("SELECT customer FROM user_divisions WHERE user_id = ? ORDER BY customer").all(userId).map((r) => r.customer);
}

// Determines which division a NEW transaction (Delivery / Return /
// Reconciliation / Goods Receipt) should be credited to, given who's
// creating it:
//  - Manager has no division of their own — must say explicitly.
//  - Exactly one assigned division — used automatically, nothing to ask.
//  - Two or more assigned divisions (e.g. staff covering multiple
//    customers) — must say explicitly which one, validated against their list.
// Returns { customer } on success or { error } on failure.
function resolveCreateCustomer(user, bodyCustomer) {
  if (user.role === MANAGER) {
    if (!bodyCustomer?.trim()) return { error: "Pilih Divisi (Customer) untuk transaksi ini" };
    if (!db.prepare("SELECT 1 FROM customers WHERE name = ?").get(bodyCustomer)) {
      return { error: `Customer "${bodyCustomer}" tidak ditemukan di Master Customer` };
    }
    return { customer: bodyCustomer };
  }
  const mine = Array.isArray(user.customers) ? user.customers : [];
  if (mine.length === 0) return { error: "Akun Anda belum di-assign ke Divisi (Customer) manapun — hubungi Manager." };
  if (mine.length === 1) return { customer: mine[0] };
  if (!bodyCustomer?.trim()) return { error: "Akun Anda punya lebih dari satu Divisi — pilih salah satu untuk transaksi ini" };
  if (!mine.includes(bodyCustomer)) return { error: "Divisi tersebut bukan salah satu divisi Anda" };
  return { customer: bodyCustomer };
}

module.exports = { scopeOf, scopeAllows, scopeClause, getDivisionStock, adjustStock, adjustConsumable, getUserDivisions, resolveCreateCustomer, MANAGER };
