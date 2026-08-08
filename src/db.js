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

module.exports = db;
