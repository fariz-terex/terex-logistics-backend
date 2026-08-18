// Populates the database with the same sample data used by the original
// front-end prototype, so switching the UI over to this API doesn't change
// what you see. Exported as a function so it can be called both from the
// CLI (`npm run seed`, always wipes+reseeds) and automatically on server
// boot when the database is empty (see server.js — never wipes existing data).

const bcrypt = require("bcryptjs");
const db = require("./db");

const DEMO_PASSWORD = "password123";

function reset() {
  const tables = [
    "reconciliation_serials", "reconciliation_items", "reconciliation_history", "reconciliations",
    "return_serials", "return_items", "return_history", "returns",
    "delivery_items", "delivery_history", "deliveries",
    "serial_numbers", "receipts", "material_stock",
    "stock_movements", "sites", "customers", "homebases", "areas", "materials", "users",
  ];
  tables.forEach((t) => db.prepare(`DELETE FROM ${t}`).run());
}

function seedDatabase() {
  reset();

  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  const insertUser = db.prepare(`INSERT INTO users (id, name, username, password_hash, role, assignment, customer, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'Active')`);
  insertUser.run("USR001", "Fariz Asad", "fariz", hash, "Admin / Manager Logistics", "Semua Area", null);
  insertUser.run("USR002", "Sari Dewi", "sari", hash, "Logistics Staff", "Warehouse Pusat", "Paramitra");
  insertUser.run("USR003", "Andi Wijaya", "andi", hash, "SPV", "Merauke", "Paramitra");
  insertUser.run("USR004", "Yohanes K.", "yohanes", hash, "Technician", "Maumere", "Telkomsel Regional");

  const insertArea = db.prepare("INSERT INTO areas (code, name, status) VALUES (?, ?, 'Active')");
  [["AR001", "Papua"], ["AR002", "Kalimantan"], ["AR003", "Nusra"], ["AR004", "Sumatera"]].forEach((a) => insertArea.run(...a));

  const insertHomebase = db.prepare(`INSERT INTO homebases (code, name, area, address, pic, phone, status) VALUES (?, ?, ?, ?, ?, ?, 'Active')`);
  [
    ["HB001", "Merauke", "Papua", "Jl. Trikora No. 12, Merauke", "Budi Santoso", "0812-1111-2222"],
    ["HB002", "Tabonji", "Papua", "Jl. Kamp. Tabonji, Yahukimo", "Andi Wijaya", "0812-3333-4444"],
    ["HB003", "Long Payau", "Kalimantan", "Jl. Poros Long Payau, Malinau", "Rudi Hartono", "0813-5555-6666"],
    ["HB004", "Pontianak", "Kalimantan", "Jl. Ahmad Yani No. 8, Pontianak", "Sari Dewi", "0813-7777-8888"],
    ["HB005", "Maumere", "Nusra", "Jl. Sudirman No. 3, Maumere", "Yohanes K.", "0814-1111-2222"],
    ["HB006", "Ende", "Nusra", "Jl. Melati No. 9, Ende", "Maria F.", "0814-3333-4444"],
    ["HB007", "Pekanbaru", "Sumatera", "Jl. Riau No. 21, Pekanbaru", "Doni Saputra", "0815-1111-2222"],
  ].forEach((h) => insertHomebase.run(...h));

  const insertCustomer = db.prepare("INSERT INTO customers (id, name, status) VALUES (?, ?, 'Active')");
  [["CUST001", "Paramitra"], ["CUST002", "Telkomsel Regional"], ["CUST003", "XL Axiata"]].forEach((c) => insertCustomer.run(...c));

  const insertSite = db.prepare(`INSERT INTO sites (code, terminal_id, name, customer, area, homebase, status) VALUES (?, ?, ?, ?, ?, ?, 'Active')`);
  [
    ["ST0001", "TID-001", "Long Pada", "Paramitra", "Kalimantan", "Long Payau"],
    ["ST0002", "TID-002", "Apau Ping", "Paramitra", "Kalimantan", "Long Payau"],
    ["ST0003", "TID-003", "Long Ketaman", "Paramitra", "Kalimantan", "Long Payau"],
    ["ST0004", "TID-004", "Merauke Barat", "Telkomsel Regional", "Papua", "Merauke"],
    ["ST0005", "TID-005", "Kampung Yame", "Telkomsel Regional", "Papua", "Tabonji"],
    ["ST0006", "TID-006", "Rumang", "XL Axiata", "Nusra", "Maumere"],
    ["ST0007", "TID-007", "Nampar Sepang", "XL Axiata", "Nusra", "Ende"],
  ].forEach((s) => insertSite.run(...s));

  const insertMaterial = db.prepare(`INSERT INTO materials (id, name, category, unit, serialized, min_stock, status, ready, faulty, reserved, in_transit) VALUES (?, ?, ?, ?, ?, ?, 'Active', ?, ?, ?, ?)`);
  [
    ["MAT001", "Modem HT3300", "Modem", "Unit", 1, 5, 25, 3, 4, 2],
    ["MAT002", "LNB Ku-Band", "RF Component", "Unit", 1, 8, 40, 5, 3, 0],
    ["MAT003", "Router Mikrotik RB450Gx4", "Router", "Unit", 1, 4, 12, 2, 2, 0],
    ["MAT004", "DC to DC Meanwell 48-24V", "Power", "Unit", 0, 6, 18, 1, 0, 3],
    ["MAT005", "Inverter AC to DC", "Power", "Unit", 1, 3, 2, 0, 0, 0],
    ["MAT006", "Feedhorn 1.8M", "RF Component", "Unit", 0, 4, 9, 1, 1, 0],
    ["MAT007", "SCC Morningstar", "Controller", "Unit", 1, 3, 6, 0, 0, 0],
  ].forEach((m) => insertMaterial.run(...m));

  // Seed a Ready Serial Number pool for every serialized material, matching
  // its `ready` quantity above, so the new Goods Receipt / SN-picker features
  // have real data to work with immediately. Prefixes are kept distinct from
  // the SNs already referenced in the Return Faulty / Reconciliation seed
  // data below (HT33..., LNBKU..., RB45...) so nothing collides.
  // All demo stock is seeded under the "Paramitra" division (matching Sari
  // and Andi's assigned customer) so the division-scoping feature has real
  // data to demo against immediately.
  const DEMO_DIVISION = "Paramitra";
  const insertSerial = db.prepare(`INSERT INTO serial_numbers (sn, material, status, current_ref, received_date, received_ref, customer) VALUES (?, ?, 'Ready', NULL, ?, 'WR-SEED', ?)`);
  const seedSerials = [
    { material: "Modem HT3300", prefix: "MOD-R", count: 25 },
    { material: "LNB Ku-Band", prefix: "LNB-R", count: 40 },
    { material: "Router Mikrotik RB450Gx4", prefix: "RTR-R", count: 12 },
    { material: "Inverter AC to DC", prefix: "INV-R", count: 2 },
    { material: "SCC Morningstar", prefix: "SCC-R", count: 6 },
  ];
  seedSerials.forEach(({ material, prefix, count }) => {
    for (let i = 1; i <= count; i++) {
      insertSerial.run(`${prefix}${String(i).padStart(3, "0")}`, material, "2026-08-01", DEMO_DIVISION);
    }
  });

  // Mirror the materials' aggregate quantities into material_stock under the
  // same demo division, so Warehouse Stock looks identical whether Sari/Andi
  // (division-scoped) or Fariz (Manager, sees the global aggregate) are logged in.
  const insertStock = db.prepare(`INSERT INTO material_stock (material, customer, ready, faulty, reserved, in_transit) VALUES (?, ?, ?, ?, ?, ?)`);
  db.prepare("SELECT name, ready, faulty, reserved, in_transit FROM materials").all().forEach((m) => {
    insertStock.run(m.name, DEMO_DIVISION, m.ready, m.faulty, m.reserved, m.in_transit);
  });

  console.log("Seed complete.");
  console.log(`Demo login — any username above with password: ${DEMO_PASSWORD}`);
  console.log("e.g. fariz / sari / andi / yohanes");
}

module.exports = { seedDatabase };

if (require.main === module) {
  seedDatabase();
}
