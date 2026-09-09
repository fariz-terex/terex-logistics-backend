// Verifikasi file backup terex.db tanpa perlu DB Browser.
// Pakai: node verify-backup.js "C:\path\ke\terex-backup.db"
// Butuh Node 22.5+ (modul bawaan node:sqlite). Node v24 di komputer ini sudah cukup.

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const file = process.argv[2];
if (!file) {
  console.error('Pakai: node verify-backup.js "path\\ke\\terex-backup.db"');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error("File tidak ditemukan: " + path.resolve(file));
  process.exit(1);
}

const size = fs.statSync(file).size;
const head = fs.readFileSync(file).subarray(0, 16).toString("latin1");
console.log("File      :", path.resolve(file));
console.log("Ukuran    :", (size / 1024 / 1024).toFixed(2), "MB");
console.log("Header    :", head.startsWith("SQLite format 3") ? "OK (SQLite format 3)" : "BUKAN file SQLite yang valid!");
console.log("");

let db;
try {
  db = new DatabaseSync(file, { readOnly: true });
} catch (e) {
  console.error("Gagal membuka sebagai database SQLite:", e.message);
  process.exit(1);
}

const q = (sql) => { try { return db.prepare(sql).all(); } catch { return null; } };
const one = (sql) => { const r = q(sql); return r && r[0] ? Object.values(r[0])[0] : "?"; };

const tables = (q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name") || []).map((r) => r.name);
console.log("Jumlah tabel:", tables.length);
console.log("");

console.log("--- Isi tabel kunci ---");
for (const t of ["users", "materials", "homebases", "clusters", "serial_numbers", "material_stock", "deliveries", "returns"]) {
  if (tables.includes(t)) console.log(`  ${t.padEnd(16)} : ${one(`SELECT COUNT(*) FROM ${t}`)} baris`);
}
console.log("");

if (tables.includes("serial_numbers")) {
  console.log("--- serial_numbers ---");
  console.log("  Total unit            :", one("SELECT COUNT(*) FROM serial_numbers"));
  console.log("  Unit MSG              :", one("SELECT COUNT(*) FROM serial_numbers WHERE customer='MSG'"));
  console.log("  Unit MSG hasil import :", one("SELECT COUNT(*) FROM serial_numbers WHERE customer='MSG' AND received_ref='IMPORT-MSG'"));
  const byStatus = q("SELECT status, COUNT(*) n FROM serial_numbers WHERE customer='MSG' GROUP BY status ORDER BY n DESC") || [];
  console.log("  MSG per status        :", byStatus.map((r) => `${r.status}=${r.n}`).join(", ") || "-");
  const withDates = one(`SELECT COUNT(*) FROM serial_numbers WHERE customer='MSG' AND (
     received_date IS NOT NULL OR installed_date IS NOT NULL OR replacement_date IS NOT NULL
     OR shipped_to_warehouse_date IS NOT NULL OR returned_to_customer_date IS NOT NULL)`);
  console.log("  MSG dgn min. 1 tanggal :", withDates);
  const sample = q(`SELECT sn, status, received_date, installed_date, install_site, replacement_date,
     shipped_to_warehouse_date, returned_to_customer_date
     FROM serial_numbers WHERE customer='MSG' AND installed_date IS NOT NULL LIMIT 3`) || [];
  console.log("  Contoh 3 unit MSG dgn tanggal install:");
  for (const r of sample) console.log("   ", JSON.stringify(r));
}
console.log("");
console.log(">>> Backup VALID kalau: header OK, ada ~418 unit MSG, dan tabel lain berisi data.");
db.close();
