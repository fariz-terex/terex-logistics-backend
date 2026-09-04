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
// Derives the next number from the HIGHEST existing id with this prefix, not
// the row COUNT — otherwise deleting a row in the middle (e.g. leaving TL001
// and TL003) makes the count-based version regenerate an id that already
// exists (TL003), hitting a UNIQUE/PRIMARY KEY constraint. Scanning for the
// max is robust to gaps. `idColumn` must name the table's id column ("code"
// for most masters, "id" for tools).
function paddedSequenceId(db, table, prefix, idColumn = "code") {
  const rows = db.prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE ${idColumn} LIKE ?`).all(`${prefix}%`);
  let max = 0;
  for (const r of rows) {
    const num = parseInt(String(r.id).slice(prefix.length), 10);
    if (!Number.isNaN(num) && num > max) max = num;
  }
  const seq = String(max + 1).padStart(3, "0");
  return `${prefix}${seq}`;
}

// Same gap-safe approach for stock movement ids (SM-000001, ...). Count-based
// numbering breaks identically once any movement row is ever deleted.
function nextStockMovementId(db) {
  const rows = db.prepare(`SELECT id FROM stock_movements WHERE id LIKE 'SM-%'`).all();
  let max = 0;
  for (const r of rows) {
    const num = parseInt(String(r.id).slice(3), 10);
    if (!Number.isNaN(num) && num > max) max = num;
  }
  return "SM-" + String(max + 1).padStart(6, "0");
}

module.exports = { todayCode, isoDate, dailySequenceId, paddedSequenceId, nextStockMovementId };
