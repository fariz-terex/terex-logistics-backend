// One-off cleanup (2026-10-01): a dropped connection + repeated clicks
// created 15 identical Delivery Requests (DR-261001-002 … 016). The user
// asked to keep 002 and delete the rest from the database.
//
// A candidate is only deleted when it is provably a copy of the kept one and
// nothing has happened to it yet: still "Waiting Logistics Approval", same
// requester / destination / purpose / note / division / date, the exact same
// items, and no unit or photo attached. Anything else is left alone and
// reported. Idempotent — a second run finds nothing to do.
// db is injected (node:sqlite in tests).
const UNTOUCHED = "Waiting Logistics Approval";
const SAME_FIELDS = ["requester", "homebase", "site", "keperluan", "note", "customer", "date"];

function itemsKey(db, id) {
  return db.prepare("SELECT material, qty, item_type FROM delivery_items WHERE delivery_id = ? ORDER BY material, item_type, qty")
    .all(id).map((i) => `${i.item_type}|${i.material}|${i.qty}`).join("\n");
}

function removeDuplicateDeliveries(db, keepId, candidateIds) {
  const result = { kept: keepId, deleted: [], skipped: [] };
  const keep = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(keepId);
  if (!keep) {
    result.skipped = candidateIds.map((id) => ({ id, why: `${keepId} tidak ditemukan` }));
    return result;
  }
  const keepItems = itemsKey(db, keepId);

  const check = (id) => {
    if (id === keepId) return "ini request yang dipertahankan";
    const d = db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id);
    if (!d) return null; // already gone
    if (d.status !== UNTOUCHED) return `status sudah "${d.status}"`;
    const diff = SAME_FIELDS.find((f) => (d[f] || "") !== (keep[f] || ""));
    if (diff) return `${diff} berbeda dari ${keepId}`;
    if (itemsKey(db, id) !== keepItems) return `item berbeda dari ${keepId}`;
    if (db.prepare("SELECT 1 FROM serial_numbers WHERE current_ref = ? LIMIT 1").get(id)) return "sudah ada unit yang terkait";
    if (db.prepare("SELECT 1 FROM tool_serials WHERE current_ref = ? LIMIT 1").get(id)) return "sudah ada alat yang terkait";
    if (db.prepare("SELECT 1 FROM delivery_serial_photos WHERE delivery_id = ? LIMIT 1").get(id)) return "sudah ada foto";
    return true;
  };

  db.exec("BEGIN");
  try {
    for (const id of candidateIds) {
      const verdict = check(id);
      if (verdict === null) continue;
      if (verdict !== true) { result.skipped.push({ id, why: verdict }); continue; }
      db.prepare("DELETE FROM delivery_items WHERE delivery_id = ?").run(id);
      db.prepare("DELETE FROM delivery_history WHERE delivery_id = ?").run(id);
      db.prepare("DELETE FROM notifications WHERE ref_type = 'delivery' AND ref_id = ?").run(id);
      db.prepare("DELETE FROM deliveries WHERE id = ?").run(id);
      result.deleted.push(id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return result;
}

module.exports = { removeDuplicateDeliveries };
