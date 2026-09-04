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

// The users-table rebuild above (ALTER TABLE users RENAME TO users_old)
// carries a real gotcha: SQLite automatically rewrites every OTHER table's
// foreign key definitions that pointed at "users" to point at "users_old"
// instead, since that's literally what the table is now called at that
// moment. user_divisions.user_id REFERENCES users(id) silently became
// REFERENCES users_old(id) — and stayed that way even after "users_old"
// was dropped and "users" was recreated fresh, because nothing told
// user_divisions to point back at the new table. Every subsequent INSERT
// into user_divisions then failed FK validation against a table that no
// longer existed. Fix: rebuild user_divisions with its reference pointed
// at the correct (current) "users" table.
const userDivTableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='user_divisions'").get();
if (userDivTableInfo && userDivTableInfo.sql.includes('"users_old"')) {
  console.log("[db] fixing user_divisions foreign key — it was still pointing at the now-dropped 'users_old' table");
  db.pragma("foreign_keys = OFF");
  db.exec(`
    ALTER TABLE user_divisions RENAME TO user_divisions_old;

    CREATE TABLE user_divisions (
      user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      customer TEXT NOT NULL,
      PRIMARY KEY (user_id, customer)
    );

    INSERT INTO user_divisions (user_id, customer)
      SELECT user_id, customer FROM user_divisions_old;

    DROP TABLE user_divisions_old;
  `);
  db.pragma("foreign_keys = ON");

  // Same stale-reference precaution as above, now that user_divisions has
  // also gone through a rename/create/drop cycle.
  db.close();
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

// ===================== TRANSFER STOK ANTAR HOMEBASE =====================
// Just a plain ADD COLUMN, not a rebuild — no CHECK constraint involved,
// so none of the rename/create/drop staleness precautions above apply here.
const serialColumnsForHomebase = db.prepare("PRAGMA table_info(serial_numbers)").all().map((c) => c.name);
if (!serialColumnsForHomebase.includes("homebase")) {
  console.log("[db] adding homebase column to serial_numbers");
  db.exec("ALTER TABLE serial_numbers ADD COLUMN homebase TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_serials_homebase ON serial_numbers(homebase)");

  // Backfill: every serialized unit that's already Delivered or Installed
  // has a real physical homebase, we just never recorded it as such before
  // — it's recoverable from the delivery that shipped it there.
  console.log("[db] backfilling serial_numbers.homebase from delivery history");
  db.exec(`
    UPDATE serial_numbers
    SET homebase = (
      SELECT d.homebase FROM deliveries d WHERE d.id = serial_numbers.current_ref
    )
    WHERE status IN ('Delivered', 'Installed')
      AND current_ref IS NOT NULL
      AND homebase IS NULL
  `);
}

// Backfill material_stock_homebase from every historical Delivered
// delivery's non-serialized material line items — this table didn't exist
// before Transfer Stock, so without this, all pre-existing delivered
// quantities would be invisible to it despite genuinely being at a
// homebase already.
const transferTablesExist = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_stock_homebase'").get();
if (transferTablesExist) {
  const alreadyBackfilled = db.prepare("SELECT COUNT(*) AS n FROM material_stock_homebase").get().n;
  if (alreadyBackfilled === 0) {
    const hasAnyDelivered = db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'Delivered'").get().n;
    if (hasAnyDelivered > 0) {
      console.log("[db] backfilling material_stock_homebase from delivery history");
      db.exec(`
        INSERT INTO material_stock_homebase (material, customer, homebase, qty)
        SELECT di.material, d.customer, d.homebase, SUM(di.qty)
        FROM delivery_items di
        JOIN deliveries d ON d.id = di.delivery_id
        JOIN materials m ON m.name = di.material
        WHERE d.status = 'Delivered' AND di.item_type = 'material' AND m.serialized = 0
          AND d.customer IS NOT NULL AND d.customer != ''
          AND d.homebase IS NOT NULL AND d.homebase != ''
        GROUP BY di.material, d.customer, d.homebase
      `);
    }
  }
}

// ============= FAULTY -> SENT TO CUSTOMER -> READY CYCLE =============
// Same CHECK-constraint-rebuild situation as the earlier 'Installed'
// migration — this one carries every column forward INCLUDING `homebase`,
// which didn't exist yet at the time of that first rebuild but does now
// (added by the Transfer Stock feature) and must not be silently dropped.
const snTableInfoV2 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='serial_numbers'").get();
if (snTableInfoV2 && !snTableInfoV2.sql.includes("'Sent to Customer'")) {
  console.log("[db] rebuilding serial_numbers table to support 'Sent to Customer' status");
  db.exec(`
    ALTER TABLE serial_numbers RENAME TO serial_numbers_old;

    CREATE TABLE serial_numbers (
      sn             TEXT PRIMARY KEY,
      material       TEXT NOT NULL REFERENCES materials(name),
      status         TEXT NOT NULL DEFAULT 'Ready' CHECK (status IN ('Ready','Reserved','In Transit','Delivered','Installed','Faulty','Sent to Customer')),
      current_ref    TEXT,
      received_date  TEXT,
      received_ref   TEXT,
      customer       TEXT,
      installed_date TEXT,
      installed_by   TEXT,
      install_photo  TEXT,
      install_site   TEXT,
      homebase       TEXT
    );

    INSERT INTO serial_numbers (sn, material, status, current_ref, received_date, received_ref, customer, installed_date, installed_by, install_photo, install_site, homebase)
      SELECT sn, material, status, current_ref, received_date, received_ref, customer, installed_date, installed_by, install_photo, install_site, homebase FROM serial_numbers_old;

    DROP TABLE serial_numbers_old;

    CREATE INDEX IF NOT EXISTS idx_serials_material_status ON serial_numbers(material, status);
    CREATE INDEX IF NOT EXISTS idx_serials_homebase ON serial_numbers(homebase);
  `);

  // Same stale-reference precaution used for every prior rebuild — cheap
  // insurance against the connection holding on to state from a table
  // that technically no longer exists under that name.
  db.close();
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

// ===================== PIM CLUSTERS =====================
// Add the per-unit `cluster` tag to serial_numbers. Deliberately a plain
// ADD COLUMN with NO CHECK constraint — exactly like the `homebase` column
// added by Transfer Stock — so it never triggers the rename/create/drop
// rebuild cycle that serial_numbers' CHECK constraint has needed twice
// before (and which caused the stale-FK-to-dropped-table bug). Valid
// cluster values are enforced in the application layer against the clusters
// table, not by the database. NULL for every existing unit and for every
// non-PIM unit — only PIM units ever carry a cluster.
const serialColumnsForCluster = db.prepare("PRAGMA table_info(serial_numbers)").all().map((c) => c.name);
if (!serialColumnsForCluster.includes("cluster")) {
  console.log("[db] adding cluster column to serial_numbers");
  db.exec("ALTER TABLE serial_numbers ADD COLUMN cluster TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_serials_cluster ON serial_numbers(cluster)");
}

// The clusters master and cluster_transfers tables are created by schema.sql
// on a fresh volume, but an already-deployed database won't have them yet —
// CREATE TABLE IF NOT EXISTS here is a no-op when they already exist and
// creates them when they don't.
db.exec(`
  CREATE TABLE IF NOT EXISTS clusters (
    code     TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    customer TEXT NOT NULL,
    pic      TEXT DEFAULT '',
    status   TEXT NOT NULL DEFAULT 'Active',
    UNIQUE (name, customer)
  );
  CREATE TABLE IF NOT EXISTS cluster_transfers (
    id             TEXT PRIMARY KEY,
    material       TEXT NOT NULL,
    customer       TEXT NOT NULL,
    sn             TEXT NOT NULL,
    cluster_from   TEXT NOT NULL,
    cluster_to     TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected')),
    requested_by   TEXT NOT NULL,
    requested_date TEXT NOT NULL,
    request_note   TEXT DEFAULT '',
    decided_by     TEXT,
    decided_date   TEXT,
    decision_note  TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_cluster_transfers_sn ON cluster_transfers(sn);
  CREATE INDEX IF NOT EXISTS idx_cluster_transfers_status ON cluster_transfers(status);
`);

// Seed the six PIM clusters idempotently — INSERT OR IGNORE keyed on the
// UNIQUE(name, customer) constraint, so this only ever inserts a cluster
// that isn't already there (a Manager renaming/deactivating one later won't
// get it silently re-added, since the name stays the same). Runs every boot
// but does nothing once all six exist.
const PIM_DIVISION = "PIM";
const PIM_CLUSTERS = [
  { code: "CL-PIM-01", name: "ACEH-1",    pic: "Fajar" },
  { code: "CL-PIM-02", name: "ACEH-2",    pic: "Fajar" },
  { code: "CL-PIM-03", name: "ACEH-3",    pic: "Fajar" },
  { code: "CL-PIM-04", name: "BANTEN-1",  pic: "Fajar" },
  { code: "CL-PIM-05", name: "JABAR-1B",  pic: "Sjahnell" },
  { code: "CL-PIM-06", name: "KALTENG-1", pic: "Sjahnell" },
];
const insertCluster = db.prepare("INSERT OR IGNORE INTO clusters (code, name, customer, pic, status) VALUES (?, ?, ?, ?, 'Active')");
PIM_CLUSTERS.forEach((c) => insertCluster.run(c.code, c.name, PIM_DIVISION, c.pic));

module.exports = db;
