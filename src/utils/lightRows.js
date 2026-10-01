// List endpoints must not ship photos: a list row only needs to know
// WHETHER a photo exists, never its content (older rows hold whole base64
// images in these columns — sending them in every list load made the
// Delivery/Return lists tens of MB for an unscoped Manager). The detail
// endpoint (`GET /:id`) still returns the real values.
//
// lightSelect() builds a column list for `SELECT ... FROM <table>` where each
// photo column is replaced by a 0/1 "has a value" flag under the same name,
// so SQLite never even reads the photo off disk.
const cache = new Map();

function hasValue(column) {
  return `(${column} IS NOT NULL AND ${column} != '') AS ${column}`;
}

function lightSelect(db, table, photoColumns) {
  const key = `${table}|${photoColumns.join(",")}`;
  if (!cache.has(key)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    cache.set(key, columns.map((c) => (photoColumns.includes(c) ? hasValue(c) : c)).join(", "));
  }
  return cache.get(key);
}

// 0/1 from SQLite -> true/null, the shape the frontend's truthiness checks
// ("sudah ada foto?") expect in place of the photo itself.
const flag = (v) => (v ? true : null);

module.exports = { lightSelect, hasValue, flag };
