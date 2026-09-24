// Reconciliation's stock logic, used by routes/reconciliations.js. Kept here
// (db injected, raw BEGIN/COMMIT via withTransaction) for the same reason as
// utils/stockTransfers.js — so test/reconciliation.test.js can run it against
// node:sqlite without better-sqlite3.
//
// A reconciliation counts what's physically AT ONE HOMEBASE, so "System Qty"
// is the homebase-level stock — the exact same definition Transfer Stock
// uses (GET /stock/transfer-options):
//   serialized     -> COUNT of serial_numbers Delivered at that homebase
//   non-serialized -> material_stock_homebase.qty
// NOT material_stock.ready — that's warehouse stock, which delivered units
// have already left for good.
const { isoDate, nextStockMovementId } = require("./ids");
const { withTransaction } = require("./stockTransfers");

function homebaseSystemQty(db, material, customer, homebase) {
  const mat = db.prepare("SELECT serialized FROM materials WHERE name = ?").get(material);
  if (!mat) return 0;
  if (mat.serialized) {
    return db.prepare("SELECT COUNT(*) AS n FROM serial_numbers WHERE material = ? AND customer = ? AND homebase = ? AND status = 'Delivered'")
      .get(material, customer, homebase).n;
  }
  const row = db.prepare("SELECT qty FROM material_stock_homebase WHERE material = ? AND customer = ? AND homebase = ?").get(material, customer, homebase);
  return row ? row.qty : 0;
}

// Every material with stock > 0 at the homebase, as { [material]: qty } —
// what the create form needs to show System Qty for any row the user adds.
// Materials absent from the map have System Qty 0.
function homebaseSystemQtyMap(db, customer, homebase) {
  const map = {};
  db.prepare(`
    SELECT material, COUNT(*) AS qty FROM serial_numbers
    WHERE customer = ? AND homebase = ? AND status = 'Delivered'
    GROUP BY material
  `).all(customer, homebase).forEach((r) => { map[r.material] = r.qty; });
  db.prepare("SELECT material, qty FROM material_stock_homebase WHERE customer = ? AND homebase = ? AND qty > 0")
    .all(customer, homebase).forEach((r) => { map[r.material] = r.qty; });
  return map;
}

// Replaces whatever systemQty the client sent with the live homebase figure —
// the client's number is display-only and never trusted.
function withSystemQty(db, items, customer, homebase) {
  return items.map((item) => ({ ...item, systemQty: homebaseSystemQty(db, item.material, customer, homebase) }));
}

// Approval adjusts the HOMEBASE's stock, never warehouse Ready:
//  - non-serialized: material_stock_homebase moves by the discrepancy
//    recorded at submit (a delta, not "set to actualQty", so deliveries/
//    transfers that landed between submit and approve aren't wiped out).
//  - serialized: there's no "Lost" status to move a unit to, so SN statuses
//    are left alone — instead the Delivered-at-this-homebase units that
//    weren't reported (missing) and reported SNs the system doesn't have
//    here (unexpected) are named in the returned notes for the history log.
// Every discrepancy also gets a 'Reconciliation Adjustment' stock_movements
// row (qty = signed change at the homebase, remaining = homebase qty after).
// Returns an array of human-readable notes, one per item with a discrepancy.
function applyApproval(db, rc) {
  const notes = [];
  withTransaction(db, () => {
    rc.items.forEach((item) => {
      const disc = item.systemQty - item.actualQty;
      const mat = db.prepare("SELECT serialized FROM materials WHERE name = ?").get(item.material);
      let remaining;
      if (mat && mat.serialized) {
        const reported = new Set((item.serials || []).map((s) => s.trim()));
        const atHomebase = db.prepare("SELECT sn FROM serial_numbers WHERE material = ? AND customer = ? AND homebase = ? AND status = 'Delivered'")
          .all(item.material, rc.customer, rc.homebase).map((r) => r.sn);
        const missing = atHomebase.filter((sn) => !reported.has(sn));
        const unexpected = [...reported].filter((sn) => !atHomebase.includes(sn));
        if (missing.length) notes.push(`${item.material}: tidak ditemukan saat rekonsiliasi — ${missing.join(", ")}`);
        if (unexpected.length) notes.push(`${item.material}: ditemukan tapi tidak tercatat di ${rc.homebase} — ${unexpected.join(", ")}`);
        if (disc === 0) return;
        remaining = atHomebase.length;
      } else {
        if (disc === 0) return;
        db.prepare("INSERT INTO material_stock_homebase (material, customer, homebase, qty) VALUES (?, ?, ?, 0) ON CONFLICT(material, customer, homebase) DO NOTHING")
          .run(item.material, rc.customer, rc.homebase);
        db.prepare("UPDATE material_stock_homebase SET qty = MAX(0, qty - ?) WHERE material = ? AND customer = ? AND homebase = ?")
          .run(disc, item.material, rc.customer, rc.homebase);
        remaining = db.prepare("SELECT qty FROM material_stock_homebase WHERE material = ? AND customer = ? AND homebase = ?")
          .get(item.material, rc.customer, rc.homebase).qty;
        notes.push(`${item.material}: stock ${rc.homebase} disesuaikan ${disc > 0 ? "-" : "+"}${Math.abs(disc)} (sekarang ${remaining})`);
      }
      db.prepare(`INSERT INTO stock_movements (id, date, material, qty, ref, remaining, type, customer) VALUES (?, ?, ?, ?, ?, ?, 'Reconciliation Adjustment', ?)`)
        .run(nextStockMovementId(db), isoDate(), item.material, -disc, rc.id, remaining, rc.customer);
    });
    db.prepare("UPDATE reconciliations SET status = 'Completed' WHERE id = ?").run(rc.id);
  });
  return notes;
}

module.exports = { homebaseSystemQty, homebaseSystemQtyMap, withSystemQty, applyApproval };
