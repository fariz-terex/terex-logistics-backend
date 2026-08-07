// Generates human-readable, sequential IDs matching the front-end's existing
// numbering scheme (DR-YYMMDD-NNN, RF-YYMMDD-NNN, etc.) so records created by
// the real backend look identical to the ones from the original prototype.

function todayCode() {
  const d = new Date();
  const yy = String(d.getFullYear()).slice(2);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

// Generic "PREFIX-YYMMDD-NNN" id, NNN = count of existing rows with same
// date-prefix + 1 (per-day sequence, matches DR-/RF-/RC- pattern).
function dailySequenceId(db, table, prefix) {
  const code = todayCode();
  const like = `${prefix}-${code}-%`;
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id LIKE ?`).get(like);
  const seq = String(row.n + 1).padStart(3, "0");
  return `${prefix}-${code}-${seq}`;
}

// Generic "PREFIX###" sequential id used by master data (HB001, AR001, ...).
function paddedSequenceId(db, table, prefix, idColumn = "code") {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  const seq = String(row.n + 1).padStart(3, "0");
  return `${prefix}${seq}`;
}

function nextStockMovementId(db) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM stock_movements`).get();
  return "SM-" + String(row.n + 1).padStart(6, "0");
}

module.exports = { todayCode, isoDate, dailySequenceId, paddedSequenceId, nextStockMovementId };
