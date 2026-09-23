// Run: npm test   (needs Node 22+ for the built-in node:sqlite + node:test)
// Runs against the real schema.sql via node:sqlite's DatabaseSync — same
// driver test/stockConsistency.test.js uses. utils/stockTransfers.js avoids
// better-sqlite3-only APIs (raw BEGIN/COMMIT instead of db.transaction())
// specifically so it works against either driver.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { createTransferRequest, approveTransfer, rejectTransfer, cancelTransfer } = require("../src/utils/stockTransfers");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(fs.readFileSync(path.join(__dirname, "../src/schema.sql"), "utf8"));
  db.exec("INSERT INTO customers (id, name, status) VALUES ('CUST001','MSG','Active')");
  db.exec(`
    INSERT INTO materials (id, name, category, unit, serialized, min_stock, status, ready, faulty, reserved, in_transit)
    VALUES ('MAT001','Widget Serialized','Cat','Unit',1,0,'Active',0,0,0,0),
           ('MAT002','Cable Non-Serial','Cat','Unit',0,0,'Active',0,0,0,0)
  `);
  return db;
}

test("createTransferRequest (serialized): stays Waiting Logistics Approval, homebase NOT moved yet", () => {
  const db = freshDb();
  db.exec("INSERT INTO serial_numbers (sn, material, status, customer, homebase) VALUES ('SN1','Widget Serialized','Delivered','MSG','Bengkulu')");

  const created = createTransferRequest(db, { material: "Widget Serialized", customer: "MSG", homebaseFrom: "Bengkulu", homebaseTo: "Malinau", serials: ["SN1"], performedBy: "Sari" });
  assert.equal(created.status, "Waiting Logistics Approval");

  const row = db.prepare("SELECT * FROM stock_transfers WHERE id = ?").get(created.id);
  assert.equal(row.status, "Waiting Logistics Approval");
  assert.equal(db.prepare("SELECT homebase FROM serial_numbers WHERE sn = 'SN1'").get().homebase, "Bengkulu", "must NOT have moved yet");
});

test("createTransferRequest (serialized): rejects a SN not Delivered at the source homebase", () => {
  const db = freshDb();
  db.exec("INSERT INTO serial_numbers (sn, material, status, customer, homebase) VALUES ('SN1','Widget Serialized','Installed','MSG','Bengkulu')");
  assert.throws(
    () => createTransferRequest(db, { material: "Widget Serialized", customer: "MSG", homebaseFrom: "Bengkulu", homebaseTo: "Malinau", serials: ["SN1"], performedBy: "Sari" }),
    /tidak tersedia di homebase Bengkulu/
  );
});

test("createTransferRequest (non-serialized): rejects insufficient qty at source", () => {
  const db = freshDb();
  db.exec("INSERT INTO material_stock_homebase (material, customer, homebase, qty) VALUES ('Cable Non-Serial','MSG','Bengkulu', 3)");
  assert.throws(
    () => createTransferRequest(db, { material: "Cable Non-Serial", customer: "MSG", homebaseFrom: "Bengkulu", homebaseTo: "Malinau", qty: 5, performedBy: "Sari" }),
    /tidak cukup/
  );
});

test("approveTransfer (serialized): moves homebase only now, sets Completed", () => {
  const db = freshDb();
  db.exec("INSERT INTO serial_numbers (sn, material, status, customer, homebase) VALUES ('SN1','Widget Serialized','Delivered','MSG','Bengkulu')");
  const created = createTransferRequest(db, { material: "Widget Serialized", customer: "MSG", homebaseFrom: "Bengkulu", homebaseTo: "Malinau", serials: ["SN1"], performedBy: "Sari" });

  const approved = approveTransfer(db, created.id);
  assert.equal(approved.status, "Completed");
  assert.equal(db.prepare("SELECT homebase FROM serial_numbers WHERE sn = 'SN1'").get().homebase, "Malinau");
});

test("approveTransfer (non-serialized): decrements source, credits destination in material_stock_homebase", () => {
  const db = freshDb();
  db.exec("INSERT INTO material_stock_homebase (material, customer, homebase, qty) VALUES ('Cable Non-Serial','MSG','Bengkulu', 10)");
  const created = createTransferRequest(db, { material: "Cable Non-Serial", customer: "MSG", homebaseFrom: "Bengkulu", homebaseTo: "Malinau", qty: 4, performedBy: "Sari" });

  approveTransfer(db, created.id);
  assert.equal(db.prepare("SELECT qty FROM material_stock_homebase WHERE material='Cable Non-Serial' AND homebase='Bengkulu'").get().qty, 6);
  assert.equal(db.prepare("SELECT qty FROM material_stock_homebase WHERE material='Cable Non-Serial' AND homebase='Malinau'").get().qty, 4);
});

test("approveTransfer re-validates live: fails if source qty dropped below the requested amount after the request was made", () => {
  const db = freshDb();
  db.exec("INSERT INTO material_stock_homebase (material, customer, homebase, qty) VALUES ('Cable Non-Serial','MSG','Bengkulu', 10)");
  const created = createTransferRequest(db, { material: "Cable Non-Serial", customer: "MSG", homebaseFrom: "Bengkulu", homebaseTo: "Malinau", qty: 8, performedBy: "Sari" });

  // Something else consumes most of Bengkulu's stock in the meantime.
  db.exec("UPDATE material_stock_homebase SET qty = 2 WHERE material='Cable Non-Serial' AND homebase='Bengkulu'");

  assert.throws(() => approveTransfer(db, created.id), /sudah tidak cukup/);
  // Rejected approval must not have partially applied.
  assert.equal(db.prepare("SELECT qty FROM material_stock_homebase WHERE material='Cable Non-Serial' AND homebase='Bengkulu'").get().qty, 2);
  assert.equal(db.prepare("SELECT status FROM stock_transfers WHERE id = ?").get(created.id).status, "Waiting Logistics Approval");
});

test("approveTransfer refuses to run twice on the same transfer", () => {
  const db = freshDb();
  db.exec("INSERT INTO material_stock_homebase (material, customer, homebase, qty) VALUES ('Cable Non-Serial','MSG','Bengkulu', 10)");
  const created = createTransferRequest(db, { material: "Cable Non-Serial", customer: "MSG", homebaseFrom: "Bengkulu", homebaseTo: "Malinau", qty: 4, performedBy: "Sari" });
  approveTransfer(db, created.id);
  assert.throws(() => approveTransfer(db, created.id), /tidak bisa di-approve/);
});

test("rejectTransfer: sets Rejected, records who/why, never touches stock", () => {
  const db = freshDb();
  db.exec("INSERT INTO material_stock_homebase (material, customer, homebase, qty) VALUES ('Cable Non-Serial','MSG','Bengkulu', 10)");
  const created = createTransferRequest(db, { material: "Cable Non-Serial", customer: "MSG", homebaseFrom: "Bengkulu", homebaseTo: "Malinau", qty: 4, performedBy: "Sari" });

  const rejected = rejectTransfer(db, created.id, { reason: "Salah homebase tujuan", rejectedBy: "Manager" });
  assert.equal(rejected.status, "Rejected");
  assert.equal(rejected.rejected_by, "Manager");
  assert.equal(rejected.rejected_reason, "Salah homebase tujuan");
  assert.equal(db.prepare("SELECT qty FROM material_stock_homebase WHERE material='Cable Non-Serial' AND homebase='Bengkulu'").get().qty, 10, "stock must be untouched");
});

test("cancelTransfer: only works on a Completed transfer, reverses the move", () => {
  const db = freshDb();
  db.exec("INSERT INTO material_stock_homebase (material, customer, homebase, qty) VALUES ('Cable Non-Serial','MSG','Bengkulu', 10)");
  const created = createTransferRequest(db, { material: "Cable Non-Serial", customer: "MSG", homebaseFrom: "Bengkulu", homebaseTo: "Malinau", qty: 4, performedBy: "Sari" });

  // Cancelling before approval is refused — nothing moved yet, so nothing to reverse.
  assert.throws(() => cancelTransfer(db, created.id, { cancelledBy: "Manager" }), /hanya transfer yang sudah Completed/);

  approveTransfer(db, created.id);
  const cancelled = cancelTransfer(db, created.id, { cancelledBy: "Manager" });
  assert.equal(cancelled.status, "Cancelled");
  assert.equal(db.prepare("SELECT qty FROM material_stock_homebase WHERE material='Cable Non-Serial' AND homebase='Bengkulu'").get().qty, 10);
  assert.equal(db.prepare("SELECT qty FROM material_stock_homebase WHERE material='Cable Non-Serial' AND homebase='Malinau'").get().qty, 0);
});
