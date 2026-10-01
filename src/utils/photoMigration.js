// Moves photos that older code stored INSIDE the database (base64 data URLs
// in the columns below) into the bucket, replacing each with its "obj:" ref.
// Run in small batches from Settings (Manager) — never at startup — and
// resumable: the cursor says where the last batch stopped, so a row that
// can't be moved (unsupported/garbled data) is skipped instead of retried
// forever. db and store are injected (node:sqlite + a fake store in tests).
const { storePhoto } = require("./photos");

// [table, column, bucket folder, allowPdf]
const TARGETS = [
  ["deliveries", "doc_overall", "deliveries", false],
  ["deliveries", "doc_after_packing", "deliveries", false],
  ["deliveries", "resi_photo", "deliveries", false],
  ["deliveries", "delivered_photo", "deliveries", false],
  ["deliveries", "bast_document", "deliveries/bast", true],
  ["delivery_serial_photos", "photo", "deliveries/units", false],
  ["returns", "doc_before", "returns", false],
  ["returns", "doc_after", "returns", false],
  ["returns", "doc_weighing", "returns", false],
  ["returns", "resi_photo", "returns", false],
  ["return_serials", "photo", "returns/units", false],
  ["reconciliations", "photo", "reconciliations", false],
  ["serial_numbers", "install_photo", "installs", false],
  ["material_swaps", "photo", "swaps", false],
  ["material_swaps", "old_photo", "swaps", false],
  ["tool_checkouts", "handover_photo", "tools", false],
  ["tool_checkouts", "return_photo", "tools", false],
];

function hasColumn(db, table, column) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column); } catch { return false; }
}

// How many data-URL photos are still inside the database, per column.
function remaining(db) {
  const byColumn = {};
  let total = 0;
  for (const [table, column] of TARGETS) {
    if (!hasColumn(db, table, column)) continue;
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE 'data:%'`).get().n;
    if (n) byColumn[`${table}.${column}`] = n;
    total += n;
  }
  return { total, byColumn };
}

// Moves up to `limit` photos starting after `cursor` ({ t: target index,
// rid: last rowid seen }). Returns { migrated, failed, cursor, done }.
async function migrateBatch(db, store, { limit = 10, cursor = { t: 0, rid: 0 } } = {}) {
  const out = { migrated: 0, failed: 0, cursor: { ...cursor }, done: false };
  if (!store) throw new Error("Bucket foto belum dikonfigurasi");
  let budget = limit;
  while (budget > 0 && out.cursor.t < TARGETS.length) {
    const [table, column, folder, allowPdf] = TARGETS[out.cursor.t];
    const rows = hasColumn(db, table, column)
      ? db.prepare(`SELECT rowid AS rid, ${column} AS value FROM ${table} WHERE ${column} LIKE 'data:%' AND rowid > ? ORDER BY rowid LIMIT ?`).all(out.cursor.rid, budget)
      : [];
    if (rows.length === 0) { out.cursor = { t: out.cursor.t + 1, rid: 0 }; continue; }
    for (const row of rows) {
      try {
        const ref = await storePhoto(row.value, folder, store, { allowPdf });
        // Only swap if the cell still holds what we uploaded (nobody replaced it meanwhile).
        db.prepare(`UPDATE ${table} SET ${column} = ? WHERE rowid = ? AND ${column} = ?`).run(ref, row.rid, row.value);
        out.migrated++;
      } catch {
        out.failed++;
      }
      out.cursor.rid = row.rid;
      budget--;
    }
  }
  out.done = out.cursor.t >= TARGETS.length;
  return out;
}

module.exports = { TARGETS, remaining, migrateBatch };
