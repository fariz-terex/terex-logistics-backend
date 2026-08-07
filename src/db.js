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

module.exports = db;
