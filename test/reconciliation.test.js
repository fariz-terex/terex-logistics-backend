// Run: npm test   (needs Node 22+ for the built-in node:sqlite + node:test)
// Same setup as test/stockTransfers.test.js — real schema.sql on node:sqlite.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { homebaseSystemQty, homebaseSystemQtyMap, withSystemQty, applyApproval } = require("../src/utils/reconciliation");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(fs.readFileSync(path.join(__dirname, "../src/schema.sql"), "utf8"));
  db.exec("INSERT INTO customers (id, name, status) VALUES ('CUST001','MSG','Active')");
  db.exec(`
    INSERT INTO materials (id, name, category, unit, serialized, min_stock, status, ready, faulty, reserved, in_transit)
    VALUES ('MAT001','Widget Serialized','Cat','Unit',1,0,'Active',50,0,0,0),
           ('MAT002','Cable Non-Serial','Cat','Unit',0,0,'Active',50,0,0,0)
  `);
  db.exec("INSERT INTO material_stock (material, customer, ready) VALUES ('Widget Serialized','MSG',50), ('Cable Non-Serial','MSG',50)");
  db.exec(`
    INSERT INTO serial_numbers (sn, material, status, customer, homebase) VALUES
      ('SN1','Widget Serialized','Delivered','MSG','Bengkulu'),
      ('SN2','Widget Serialized','Delivered','MSG','Bengkulu'),
      ('SN3','Widget Serialized','Delivered','MSG','Bengkulu'),
      ('SN4','Widget Serialized','Installed','MSG','Bengkulu'),
      ('SN5','Widget Serialized','Delivered','MSG','Malinau')
  `);
  db.exec("INSERT INTO material_stock_homebase (material, customer, homebase, qty) VALUES ('Cable Non-Serial','MSG','Bengkulu', 20)");
  db.exec("INSERT INTO reconciliations (id, homebase, period, status, date, customer) VALUES ('RC1','Bengkulu','P','Waiting Logistics Review','2026-09-24','MSG')");
  return db;
}

test("homebaseSystemQty: serialized counts only Delivered units at that homebase", () => {
  const db = freshDb();
  assert.equal(homebaseSystemQty(db, "Widget Serialized", "MSG", "Bengkulu"), 3);
  assert.equal(homebaseSystemQty(db, "Widget Serialized", "MSG", "Malinau"), 1);
  assert.equal(homebaseSystemQty(db, "Widget Serialized", "RGR", "Bengkulu"), 0);
});

test("homebaseSystemQty: non-serialized reads the homebase ledger, not warehouse Ready", () => {
  const db = freshDb();
  assert.equal(homebaseSystemQty(db, "Cable Non-Serial", "MSG", "Bengkulu"), 20);
  assert.equal(homebaseSystemQty(db, "Cable Non-Serial", "MSG", "Malinau"), 0);
});

test("homebaseSystemQtyMap: every material with stock at the homebase", () => {
  const db = freshDb();
  assert.deepEqual(homebaseSystemQtyMap(db, "MSG", "Bengkulu"), { "Widget Serialized": 3, "Cable Non-Serial": 20 });
});

test("withSystemQty: overrides whatever systemQty the client sent", () => {
  const db = freshDb();
  const items = withSystemQty(db, [{ material: "Cable Non-Serial", systemQty: 999, actualQty: 18 }], "MSG", "Bengkulu");
  assert.equal(items[0].systemQty, 20);
  assert.equal(items[0].actualQty, 18);
});

test("applyApproval (non-serialized): adjusts homebase ledger by the discrepancy, warehouse Ready untouched", () => {
  const db = freshDb();
  const notes = applyApproval(db, { id: "RC1", customer: "MSG", homebase: "Bengkulu", items: [{ material: "Cable Non-Serial", serialized: false, systemQty: 20, actualQty: 18, serials: [] }] });
  assert.equal(homebaseSystemQty(db, "Cable Non-Serial", "MSG", "Bengkulu"), 18);
  assert.equal(db.prepare("SELECT ready FROM material_stock WHERE material = 'Cable Non-Serial'").get().ready, 50);
  const mov = db.prepare("SELECT * FROM stock_movements WHERE ref = 'RC1'").get();
  assert.equal(mov.qty, -2);
  assert.equal(mov.remaining, 18);
  assert.equal(db.prepare("SELECT status FROM reconciliations WHERE id = 'RC1'").get().status, "Completed");
  assert.equal(notes.length, 1);
});

test("applyApproval (non-serialized): a surplus adds to the homebase, creating the ledger row if needed", () => {
  const db = freshDb();
  db.exec("UPDATE reconciliations SET homebase = 'Malinau' WHERE id = 'RC1'");
  applyApproval(db, { id: "RC1", customer: "MSG", homebase: "Malinau", items: [{ material: "Cable Non-Serial", serialized: false, systemQty: 0, actualQty: 4, serials: [] }] });
  assert.equal(homebaseSystemQty(db, "Cable Non-Serial", "MSG", "Malinau"), 4);
});

test("applyApproval (non-serialized): applies a delta, so stock that arrived after submit isn't wiped", () => {
  const db = freshDb();
  db.exec("UPDATE material_stock_homebase SET qty = 30 WHERE homebase = 'Bengkulu'"); // +10 delivered after submit
  applyApproval(db, { id: "RC1", customer: "MSG", homebase: "Bengkulu", items: [{ material: "Cable Non-Serial", serialized: false, systemQty: 20, actualQty: 18, serials: [] }] });
  assert.equal(homebaseSystemQty(db, "Cable Non-Serial", "MSG", "Bengkulu"), 28);
});

test("applyApproval (serialized): names missing + unexpected SNs, leaves SN statuses and warehouse Ready alone", () => {
  const db = freshDb();
  const notes = applyApproval(db, { id: "RC1", customer: "MSG", homebase: "Bengkulu", items: [{ material: "Widget Serialized", serialized: true, systemQty: 3, actualQty: 2, serials: ["SN1", "SN9"] }] });
  assert.ok(notes.some((n) => /tidak ditemukan/.test(n) && n.includes("SN2") && n.includes("SN3")));
  assert.ok(notes.some((n) => /tidak tercatat/.test(n) && n.includes("SN9")));
  assert.equal(db.prepare("SELECT status FROM serial_numbers WHERE sn = 'SN2'").get().status, "Delivered");
  assert.equal(db.prepare("SELECT ready FROM material_stock WHERE material = 'Widget Serialized'").get().ready, 50);
  assert.equal(db.prepare("SELECT qty FROM stock_movements WHERE ref = 'RC1'").get().qty, -1);
});

test("applyApproval: no discrepancy -> no movement rows, still Completed", () => {
  const db = freshDb();
  const notes = applyApproval(db, { id: "RC1", customer: "MSG", homebase: "Bengkulu", items: [
    { material: "Widget Serialized", serialized: true, systemQty: 3, actualQty: 3, serials: ["SN1", "SN2", "SN3"] },
    { material: "Cable Non-Serial", serialized: false, systemQty: 20, actualQty: 20, serials: [] },
  ] });
  assert.equal(notes.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM stock_movements").get().n, 0);
  assert.equal(db.prepare("SELECT status FROM reconciliations WHERE id = 'RC1'").get().status, "Completed");
});
