const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

require("dotenv").config();

const DB_FILE = process.env.DB_FILE || "./terex.db";
const dbPath = path.isAbsolute(DB_FILE) ? DB_FILE : path.resolve(__dirname, "..", DB_FILE);

console.log(`[db] DB_FILE env = ${JSON.stringify(process.env.DB_FILE)}`);
console.log(`[db] resolved dbPath = ${dbPath}`);

const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) {
  console.log(`[db] directory ${dir} did not exist — creating it`);
  fs.mkdirSync(dir, { recursive: true });
} else {
  console.log(`[db] directory ${dir} exists, contents: ${fs.readdirSync(dir).join(", ") || "(empty)"}`);
}

let db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
// If a write collides with another in-flight write, retry for up to 5s
// instead of throwing "database is locked" immediately. SQLite only allows
// one writer at a time — with WAL mode reads are unaffected, but without
// this, two users submitting at the same instant could otherwise see one
// request fail outright rather than just queue briefly.
db.pragma("busy_timeout = 5000");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

// Lightweight self-healing migration: schema.sql uses CREATE TABLE IF NOT
// EXISTS, so it never alters a table that already exists with an older
// shape. If a previously-deployed volume still has the old `users` table
// (email-based login), drop just that table and let the exec above's
// CREATE TABLE run again to rebuild it with the current shape. Demo/seed
// data only — acceptable to lose on a schema change; a real migration
// system would be needed before this holds real user data.
const usersColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (usersColumns.length > 0 && !usersColumns.includes("username")) {
  console.log("[db] users table has an outdated schema (missing 'username') — recreating it");
  db.exec("DROP TABLE users");
  db.exec(schema);
}

// Backfill: `serial_numbers` is a brand-new table (this migration was added
// alongside it), so any database that already had materials with a `ready`
// count before this deploy has zero matching SN rows — which would make
// every serialized material look like it has no Ready stock at all. Top up
// each serialized material's Ready pool with placeholder SNs until it
// matches `materials.ready`, so existing deployments don't lose the ability
// to approve deliveries the moment this ships.
const serializedMaterials = db.prepare("SELECT id, name, ready FROM materials WHERE serialized = 1").all();
serializedMaterials.forEach((mat) => {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM serial_numbers WHERE material = ? AND status = 'Ready'").get(mat.name).n;
  const missing = mat.ready - existing;
  if (missing > 0) {
    console.log(`[db] backfilling ${missing} placeholder Ready SN(s) for ${mat.name}`);
    const insertSn = db.prepare("INSERT INTO serial_numbers (sn, material, status, current_ref, received_date, received_ref) VALUES (?, ?, 'Ready', NULL, ?, 'BACKFILL')");
    for (let i = 1; i <= missing; i++) {
      const sn = `LEGACY-${mat.id}-${String(i).padStart(3, "0")}`;
      if (!db.prepare("SELECT 1 FROM serial_numbers WHERE sn = ?").get(sn)) {
        insertSn.run(sn, mat.name, isoDateForMigration());
      }
    }
  }
});

function isoDateForMigration() {
  return new Date().toISOString().slice(0, 10);
}

// One-time rename: any delivery still sitting at the old "Approved" status
// (from before this status was renamed to "Waiting Stock Assignment" for
// clarity) gets updated in place so it isn't orphaned by the rename.
const legacyApprovedCount = db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'Approved'").get().n;
if (legacyApprovedCount > 0) {
  console.log(`[db] renaming ${legacyApprovedCount} deliveries from status 'Approved' to 'Waiting Stock Assignment'`);
  db.exec("UPDATE deliveries SET status = 'Waiting Stock Assignment' WHERE status = 'Approved'");
}

// Add the shipment-documentation columns to any deliveries table created
// before this feature existed. ALTER TABLE ADD COLUMN is non-destructive —
// existing rows just get NULL in the new columns.
const deliveryColumns = db.prepare("PRAGMA table_info(deliveries)").all().map((c) => c.name);
if (!deliveryColumns.includes("doc_overall")) {
  console.log("[db] adding shipment documentation columns to deliveries");
  db.exec("ALTER TABLE deliveries ADD COLUMN doc_overall TEXT");
  db.exec("ALTER TABLE deliveries ADD COLUMN doc_after_packing TEXT");
  db.exec("ALTER TABLE deliveries ADD COLUMN resi_number TEXT");
}
if (!deliveryColumns.includes("resi_photo")) {
  console.log("[db] adding resi_photo column to deliveries");
  db.exec("ALTER TABLE deliveries ADD COLUMN resi_photo TEXT");
}
if (!deliveryColumns.includes("delivered_photo")) {
  console.log("[db] adding delivered_photo and received_by columns to deliveries");
  db.exec("ALTER TABLE deliveries ADD COLUMN delivered_photo TEXT");
  db.exec("ALTER TABLE deliveries ADD COLUMN received_by TEXT");
}

const returnColumns = db.prepare("PRAGMA table_info(returns)").all().map((c) => c.name);
if (!returnColumns.includes("resi_photo")) {
  console.log("[db] adding resi_photo column to returns");
  db.exec("ALTER TABLE returns ADD COLUMN resi_photo TEXT");
}

if (!deliveryColumns.includes("bast_document")) {
  console.log("[db] adding BAST document columns to deliveries");
  db.exec("ALTER TABLE deliveries ADD COLUMN bast_document TEXT");
  db.exec("ALTER TABLE deliveries ADD COLUMN bast_filename TEXT");
}

// ===================== DIVISION (Customer) SCOPING =====================
// Adds a `customer` column to every table that needs to be scoped to a
// division, plus the material_stock breakdown table. Existing rows that
// predate this feature (and therefore have no real division) are bucketed
// into a synthetic "Unassigned" division — Manager/global views still see
// their totals correctly (since materials.* stays the aggregate), but
// division-scoped users won't see "Unassigned" stock until it's manually
// re-received under a real division via Terima Barang.
const UNASSIGNED = "Unassigned";

if (!deliveryColumns.includes("customer")) {
  console.log("[db] adding customer (division) column to deliveries");
  db.exec("ALTER TABLE deliveries ADD COLUMN customer TEXT");
}

if (!deliveryColumns.includes("bkb_link")) {
  console.log("[db] adding bkb_link column to deliveries");
  db.exec("ALTER TABLE deliveries ADD COLUMN bkb_link TEXT");
}

const userColumnsForDivision = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userColumnsForDivision.includes("customer")) {
  console.log("[db] adding customer (division) column to users");
  db.exec("ALTER TABLE users ADD COLUMN customer TEXT");
}

const returnColumnsForDivision = db.prepare("PRAGMA table_info(returns)").all().map((c) => c.name);
if (!returnColumnsForDivision.includes("customer")) {
  console.log("[db] adding customer (division) column to returns");
  db.exec("ALTER TABLE returns ADD COLUMN customer TEXT");
}

const reconColumns = db.prepare("PRAGMA table_info(reconciliations)").all().map((c) => c.name);
if (!reconColumns.includes("customer")) {
  console.log("[db] adding customer (division) column to reconciliations");
  db.exec("ALTER TABLE reconciliations ADD COLUMN customer TEXT");
}

const movementColumns = db.prepare("PRAGMA table_info(stock_movements)").all().map((c) => c.name);
if (!movementColumns.includes("customer")) {
  console.log("[db] adding customer (division) column to stock_movements");
  db.exec("ALTER TABLE stock_movements ADD COLUMN customer TEXT");
}

const receiptColumns = db.prepare("PRAGMA table_info(receipts)").all().map((c) => c.name);
if (!receiptColumns.includes("customer")) {
  console.log("[db] adding customer (division) column to receipts");
  db.exec("ALTER TABLE receipts ADD COLUMN customer TEXT");
}

const serialColumns = db.prepare("PRAGMA table_info(serial_numbers)").all().map((c) => c.name);
if (!serialColumns.includes("customer")) {
  console.log("[db] adding customer (division) column to serial_numbers, backfilling as 'Unassigned'");
  db.exec("ALTER TABLE serial_numbers ADD COLUMN customer TEXT");
  db.exec(`UPDATE serial_numbers SET customer = '${UNASSIGNED}' WHERE customer IS NULL`);
}

// Backfill material_stock from materials' existing aggregate totals — only
// runs once (guarded by material_stock already being empty), so it never
// clobbers real per-division data collected after this feature shipped.
const materialStockCount = db.prepare("SELECT COUNT(*) AS n FROM material_stock").get().n;
if (materialStockCount === 0) {
  const existingMaterials = db.prepare("SELECT name, ready, faulty, reserved, in_transit FROM materials WHERE ready > 0 OR faulty > 0 OR reserved > 0 OR in_transit > 0").all();
  if (existingMaterials.length > 0) {
    console.log(`[db] backfilling material_stock for ${existingMaterials.length} material(s) into division '${UNASSIGNED}'`);
    const insertStock = db.prepare("INSERT INTO material_stock (material, customer, ready, faulty, reserved, in_transit) VALUES (?, ?, ?, ?, ?, ?)");
    existingMaterials.forEach((m) => insertStock.run(m.name, UNASSIGNED, m.ready, m.faulty, m.reserved, m.in_transit));
  }
}

// Users can now belong to more than one division — migrate anyone who still
// only has the old single-value users.customer into the new user_divisions
// table (a no-op once everyone's been migrated, since it only looks at
// users who have zero rows there yet).
const usersNeedingMigration = db.prepare(`
  SELECT id, customer FROM users
  WHERE customer IS NOT NULL AND id NOT IN (SELECT user_id FROM user_divisions)
`).all();
if (usersNeedingMigration.length > 0) {
  console.log(`[db] migrating ${usersNeedingMigration.length} user(s) from single-division to user_divisions`);
  const insertDivision = db.prepare("INSERT OR IGNORE INTO user_divisions (user_id, customer) VALUES (?, ?)");
  usersNeedingMigration.forEach((u) => insertDivision.run(u.id, u.customer));
}

// Delivery Request now carries tool line items alongside materials — old
// rows get 'material' via the column default, so existing deliveries keep
// working unchanged.
const deliveryItemColumns = db.prepare("PRAGMA table_info(delivery_items)").all().map((c) => c.name);
if (!deliveryItemColumns.includes("item_type")) {
  console.log("[db] adding item_type column to delivery_items");
  db.exec("ALTER TABLE delivery_items ADD COLUMN item_type TEXT NOT NULL DEFAULT 'material'");
}

// Adding "Installed" as a valid serial_numbers status means updating a
// CHECK constraint, which SQLite can't do via ALTER TABLE — the standard
// workaround is rename-recreate-copy-drop. Guarded by checking the table's
// actual CREATE statement for the literal 'Installed', so this only ever
// runs once, and only when the older constraint (without it) is present.
const snTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='serial_numbers'").get();
if (snTableInfo && !snTableInfo.sql.includes("'Installed'")) {
  console.log("[db] rebuilding serial_numbers table to support 'Installed' status and install-tracking columns");
  db.exec(`
    ALTER TABLE serial_numbers RENAME TO serial_numbers_old;

    CREATE TABLE serial_numbers (
      sn             TEXT PRIMARY KEY,
      material       TEXT NOT NULL REFERENCES materials(name),
      status         TEXT NOT NULL DEFAULT 'Ready' CHECK (status IN ('Ready','Reserved','In Transit','Delivered','Installed','Faulty')),
      current_ref    TEXT,
      received_date  TEXT,
      received_ref   TEXT,
      customer       TEXT,
      installed_date TEXT,
      installed_by   TEXT,
      install_photo  TEXT,
      install_site   TEXT
    );

    INSERT INTO serial_numbers (sn, material, status, current_ref, received_date, received_ref, customer)
      SELECT sn, material, status, current_ref, received_date, received_ref, customer FROM serial_numbers_old;

    DROP TABLE serial_numbers_old;

    CREATE INDEX IF NOT EXISTS idx_serials_material_status ON serial_numbers(material, status);
  `);
}

// old_sn/old_material used to be required (a swap always needed a known,
// already-Installed unit on the other end) — now the removed/faulty unit
// is optional and doesn't need to be a tracked Serial Number at all, so
// the NOT NULL constraints need to come off. Table is brand new (this
// whole feature just shipped), so a rebuild here is low-risk regardless.
const swapTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='material_swaps'").get();
if (swapTableInfo && swapTableInfo.sql.includes("old_sn       TEXT NOT NULL")) {
  console.log("[db] rebuilding material_swaps table to make old_sn/old_material optional");
  db.exec(`
    ALTER TABLE material_swaps RENAME TO material_swaps_old;

    CREATE TABLE material_swaps (
      id           TEXT PRIMARY KEY,
      site         TEXT NOT NULL,
      homebase     TEXT,
      old_sn       TEXT,
      old_material TEXT,
      new_sn       TEXT NOT NULL,
      new_material TEXT NOT NULL,
      performed_by TEXT NOT NULL,
      date         TEXT NOT NULL,
      photo        TEXT,
      note         TEXT,
      return_id    TEXT
    );

    INSERT INTO material_swaps (id, site, homebase, old_sn, old_material, new_sn, new_material, performed_by, date, photo, note, return_id)
      SELECT id, site, homebase, old_sn, old_material, new_sn, new_material, performed_by, date, photo, note, return_id FROM material_swaps_old;

    DROP TABLE material_swaps_old;
  `);
}

const swapColumns = db.prepare("PRAGMA table_info(material_swaps)").all().map((c) => c.name);
if (!swapColumns.includes("old_photo")) {
  console.log("[db] adding old_photo column to material_swaps");
  db.exec("ALTER TABLE material_swaps ADD COLUMN old_photo TEXT");
}

const deliveryColumnsForReject = db.prepare("PRAGMA table_info(deliveries)").all().map((c) => c.name);
if (!deliveryColumnsForReject.includes("rejection_reason")) {
  console.log("[db] adding rejection_reason column to deliveries");
  db.exec("ALTER TABLE deliveries ADD COLUMN rejection_reason TEXT");
}

// Adding "Manager Divisi" as a valid role means updating a CHECK
// constraint, same rebuild pattern as serial_numbers/material_swaps
// earlier. users.id is referenced by user_divisions via FK, so foreign key
// enforcement is switched off just for the rebuild (SQLite requires this —
// PRAGMA foreign_keys can't be toggled inside a transaction) and restored
// right after.
const usersTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get();
if (usersTableInfo && !usersTableInfo.sql.includes("'Manager Divisi'")) {
  console.log("[db] rebuilding users table to add 'Manager Divisi' role");
  db.pragma("foreign_keys = OFF");
  db.exec(`
    ALTER TABLE users RENAME TO users_old;

    CREATE TABLE users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('Admin / Manager Logistics','Logistics Staff','SPV','Technician','Manager Divisi')),
      assignment    TEXT DEFAULT '',
      customer      TEXT,
      status        TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive'))
    );

    INSERT INTO users (id, name, username, password_hash, role, assignment, customer, status)
      SELECT id, name, username, password_hash, role, assignment, customer, status FROM users_old;

    DROP TABLE users_old;
  `);
  db.pragma("foreign_keys = ON");
}

// Closing and reopening the connection here — unconditionally, every boot —
// is cheap insurance against a real SQLite/better-sqlite3 quirk: a
// rename -> create -> drop cycle on the same table name within one open
// connection (exactly what the rebuild migrations above do) can leave the
// connection holding a stale reference to the old table under its "_old"
// name, surfacing later as spurious "no such table: X_old" errors on
// statements prepared afterward in that same process — even though the
// schema itself is completely correct on disk. A fresh connection has no
// such stale state.
db.close();
db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

// Temporary diagnostics: dump every DB object (table/index/trigger) whose
// name mentions "users", so we can see the database's *actual* on-disk
// state in the logs — the "no such table: users_old" error persisted even
// after the reconnect fix, so something more specific than a stale
// connection cache is going on and needs to be seen directly.
try {
  const suspects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name LIKE '%user%' ORDER BY type, name").all();
  console.log("[diag] DB objects matching 'user':", JSON.stringify(suspects, null, 2));
} catch (diagErr) {
  console.log("[diag] failed to inspect sqlite_master:", diagErr.message);
}

module.exports = db;
