const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

require("dotenv").config();

const DB_FILE = process.env.DB_FILE || "./terex.db";
const dbPath = path.resolve(__dirname, "..", DB_FILE);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
db.exec(schema);

module.exports = db;
