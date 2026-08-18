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

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

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

module.exports = db;
