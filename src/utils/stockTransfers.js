// Business logic for the Transfer Stock lifecycle (Homebase -> Homebase),
// used by routes/stock.js. Kept here rather than inline in the route so it
// can be unit-tested directly against a real db (test/stockTransfers.test.js)
// — the same reason computeStockConsistency in stockConsistency.js takes
// `db` as an injectable first argument instead of importing the live one.
// Each function throws a plain Error with a user-facing message on
// failure; the route translates that into the right HTTP status.
const { dailySequenceId, isoDate } = require("./ids");

// Raw BEGIN/COMMIT/ROLLBACK instead of better-sqlite3's db.transaction(fn)
// wrapper — both better-sqlite3 (production) and node:sqlite's DatabaseSync
// (used in this file's tests, since better-sqlite3 needs a native build
// this environment can't compile) support plain .exec()/.prepare(), so this
// keeps the module runnable against either driver.
function withTransaction(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Creates a PENDING transfer only — nothing moves yet. Used to apply the
// stock change instantly on submit; now waits for a Logistics/Manager
// approval (see approveTransfer below) like the other two request types.
// Validated here for immediate feedback to the requester, but re-validated
// again at approval time since stock can change in between.
function createTransferRequest(db, { material, customer, homebaseFrom, homebaseTo, qty, serials, note, performedBy }) {
  db = db || require("../db");
  if (!material || !customer || !homebaseFrom || !homebaseTo) throw new Error("material, customer, homebaseFrom, homebaseTo are required");
  if (homebaseFrom === homebaseTo) throw new Error("Homebase asal dan tujuan tidak boleh sama");

  const mat = db.prepare("SELECT * FROM materials WHERE name = ?").get(material);
  if (!mat) throw new Error("Material not found");

  let finalQty;
  if (mat.serialized) {
    if (!Array.isArray(serials) || serials.length === 0) throw new Error("Pilih minimal satu Serial Number untuk dipindahkan");
    finalQty = serials.length;
    for (const sn of serials) {
      const row = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(sn);
      if (!row || row.material !== material || row.customer !== customer || row.status !== "Delivered" || row.homebase !== homebaseFrom) {
        throw new Error(`Serial Number ${sn} tidak tersedia di homebase ${homebaseFrom}`);
      }
    }
  } else {
    finalQty = Number(qty);
    if (!finalQty || finalQty <= 0) throw new Error("Qty harus lebih dari 0");
    const source = db.prepare("SELECT qty FROM material_stock_homebase WHERE material = ? AND customer = ? AND homebase = ?").get(material, customer, homebaseFrom);
    if (!source || source.qty < finalQty) throw new Error(`Stock ${material} di ${homebaseFrom} tidak cukup (tersedia: ${source ? source.qty : 0})`);
  }

  const id = dailySequenceId(db, "stock_transfers", "TR");
  const date = isoDate();
  withTransaction(db, () => {
    db.prepare(`INSERT INTO stock_transfers (id, material, customer, homebase_from, homebase_to, qty, performed_by, date, note, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Waiting Logistics Approval')`)
      .run(id, material, customer, homebaseFrom, homebaseTo, finalQty, performedBy, date, note || "");
    if (mat.serialized) {
      const insertSerial = db.prepare("INSERT INTO stock_transfer_serials (transfer_id, sn) VALUES (?, ?)");
      serials.forEach((sn) => insertSerial.run(id, sn));
    }
  });

  return { id, material, customer, homebaseFrom, homebaseTo, date, status: "Waiting Logistics Approval", serials: mat.serialized ? serials : [] };
}

// Performs the stock mutation that used to run at creation — deferred here
// so a Logistics/Manager sign-off happens first. Re-validates live rather
// than trusting what was true when the transfer was requested: the source
// unit/qty could have moved again in the meantime.
function approveTransfer(db, id) {
  db = db || require("../db");
  const transfer = db.prepare("SELECT * FROM stock_transfers WHERE id = ?").get(id);
  if (!transfer) throw new Error("Transfer not found");
  if (transfer.status !== "Waiting Logistics Approval") throw new Error(`Transfer ini berstatus "${transfer.status}" — tidak bisa di-approve`);

  const mat = db.prepare("SELECT * FROM materials WHERE name = ?").get(transfer.material);
  withTransaction(db, () => {
    if (mat && mat.serialized) {
      const serials = db.prepare("SELECT sn FROM stock_transfer_serials WHERE transfer_id = ?").all(transfer.id).map((r) => r.sn);
      const rows = serials.map((sn) => db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(sn));
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.status !== "Delivered" || row.homebase !== transfer.homebase_from) {
          throw new Error(`Serial Number ${serials[i]} sudah tidak tersedia di homebase ${transfer.homebase_from} — tidak bisa di-approve`);
        }
      }
      const update = db.prepare("UPDATE serial_numbers SET homebase = ? WHERE sn = ?");
      serials.forEach((sn) => update.run(transfer.homebase_to, sn));
    } else {
      const source = db.prepare("SELECT qty FROM material_stock_homebase WHERE material = ? AND customer = ? AND homebase = ?")
        .get(transfer.material, transfer.customer, transfer.homebase_from);
      if (!source || source.qty < transfer.qty) {
        throw new Error(`Stock ${transfer.material} di ${transfer.homebase_from} sudah tidak cukup (tersedia: ${source ? source.qty : 0}) — tidak bisa di-approve`);
      }
      db.prepare("UPDATE material_stock_homebase SET qty = qty - ? WHERE material = ? AND customer = ? AND homebase = ?")
        .run(transfer.qty, transfer.material, transfer.customer, transfer.homebase_from);
      db.prepare(`
        INSERT INTO material_stock_homebase (material, customer, homebase, qty) VALUES (?, ?, ?, ?)
        ON CONFLICT(material, customer, homebase) DO UPDATE SET qty = qty + excluded.qty
      `).run(transfer.material, transfer.customer, transfer.homebase_to, transfer.qty);
    }
    db.prepare("UPDATE stock_transfers SET status = 'Completed' WHERE id = ?").run(transfer.id);
  });

  return db.prepare("SELECT * FROM stock_transfers WHERE id = ?").get(id);
}

// Rejects a pending transfer — nothing to unwind, stock never moved.
function rejectTransfer(db, id, { reason, rejectedBy }) {
  db = db || require("../db");
  const transfer = db.prepare("SELECT * FROM stock_transfers WHERE id = ?").get(id);
  if (!transfer) throw new Error("Transfer not found");
  if (transfer.status !== "Waiting Logistics Approval") throw new Error(`Transfer ini berstatus "${transfer.status}" — tidak bisa ditolak`);

  db.prepare("UPDATE stock_transfers SET status = 'Rejected', rejected_by = ?, rejected_reason = ? WHERE id = ?")
    .run(rejectedBy, reason || "", id);
  return db.prepare("SELECT * FROM stock_transfers WHERE id = ?").get(id);
}

// Reverses an already-APPROVED transfer — for fixing a mistaken entry, not
// a normal business-flow undo. Only safe to reverse automatically while
// nothing has touched the units/qty since (see inline checks). If not, this
// rejects with a clear reason instead of silently producing wrong numbers.
function cancelTransfer(db, id, { cancelledBy }) {
  db = db || require("../db");
  const transfer = db.prepare("SELECT * FROM stock_transfers WHERE id = ?").get(id);
  if (!transfer) throw new Error("Transfer not found");
  if (transfer.status !== "Completed") throw new Error(`Transfer ini berstatus "${transfer.status}" — hanya transfer yang sudah Completed yang bisa dibatalkan`);

  const mat = db.prepare("SELECT * FROM materials WHERE name = ?").get(transfer.material);
  withTransaction(db, () => {
    if (mat && mat.serialized) {
      const serials = db.prepare("SELECT sn FROM stock_transfer_serials WHERE transfer_id = ?").all(transfer.id).map((r) => r.sn);
      const rows = serials.map((sn) => db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(sn));
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.status !== "Delivered" || row.homebase !== transfer.homebase_to) {
          throw new Error(`Serial Number ${serials[i]} sudah berubah sejak transfer ini (status/homebase tidak lagi cocok) — tidak bisa dibatalkan otomatis`);
        }
      }
      const update = db.prepare("UPDATE serial_numbers SET homebase = ? WHERE sn = ?");
      serials.forEach((sn) => update.run(transfer.homebase_from, sn));
    } else {
      const dest = db.prepare("SELECT qty FROM material_stock_homebase WHERE material = ? AND customer = ? AND homebase = ?")
        .get(transfer.material, transfer.customer, transfer.homebase_to);
      if (!dest || dest.qty < transfer.qty) {
        throw new Error(`Stock ${transfer.material} di ${transfer.homebase_to} sudah berkurang sejak transfer ini (tersedia: ${dest ? dest.qty : 0}) — tidak bisa dibatalkan otomatis`);
      }
      db.prepare("UPDATE material_stock_homebase SET qty = qty - ? WHERE material = ? AND customer = ? AND homebase = ?")
        .run(transfer.qty, transfer.material, transfer.customer, transfer.homebase_to);
      db.prepare(`
        INSERT INTO material_stock_homebase (material, customer, homebase, qty) VALUES (?, ?, ?, ?)
        ON CONFLICT(material, customer, homebase) DO UPDATE SET qty = qty + excluded.qty
      `).run(transfer.material, transfer.customer, transfer.homebase_from, transfer.qty);
    }
    db.prepare("UPDATE stock_transfers SET status = 'Cancelled', cancelled_by = ?, cancelled_at = ? WHERE id = ?")
      .run(cancelledBy, new Date().toISOString(), transfer.id);
  });

  return db.prepare("SELECT * FROM stock_transfers WHERE id = ?").get(id);
}

module.exports = { createTransferRequest, approveTransfer, rejectTransfer, cancelTransfer };
