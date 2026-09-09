// Run: npm test   (needs Node 22+ for the built-in node:sqlite + node:test)
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { computeStockConsistency } = require("../src/utils/stockConsistency");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE materials (name TEXT, serialized INTEGER, ready INT, faulty INT, reserved INT, in_transit INT);
    CREATE TABLE material_stock (material TEXT, customer TEXT, ready INT, faulty INT, reserved INT, in_transit INT);
    CREATE TABLE serial_numbers (sn TEXT, material TEXT, status TEXT, customer TEXT);
    CREATE TABLE customers (name TEXT);
  `);
  db.exec("INSERT INTO customers VALUES ('PIM'),('MSG')");
  return db;
}

test("clean data → summary.clean is true, no findings", () => {
  const db = freshDb();
  db.exec("INSERT INTO materials VALUES ('Modem A',1, 3,1,0,0)");
  db.exec("INSERT INTO material_stock VALUES ('Modem A','PIM', 2,1,0,0), ('Modem A','MSG', 1,0,0,0)");
  db.exec(`INSERT INTO serial_numbers VALUES
    ('a1','Modem A','Ready','PIM'),('a2','Modem A','Ready','PIM'),
    ('a3','Modem A','Faulty','PIM'),('a4','Modem A','Ready','MSG')`);
  const r = computeStockConsistency(db);
  assert.equal(r.summary.clean, true);
  assert.deepEqual([r.globalVsDivisionSum, r.serialVsMaterialStock, r.negatives, r.orphans].map((x) => x.length), [0, 0, 0, 0]);
});

test("global aggregate not equal to sum of divisions is flagged", () => {
  const db = freshDb();
  db.exec("INSERT INTO materials VALUES ('Modem B',1, 5,0,0,0)");
  db.exec("INSERT INTO material_stock VALUES ('Modem B','PIM', 4,0,0,0)");
  db.exec("INSERT INTO serial_numbers VALUES ('b1','Modem B','Ready','PIM'),('b2','Modem B','Ready','PIM'),('b3','Modem B','Ready','PIM'),('b4','Modem B','Ready','PIM')");
  const r = computeStockConsistency(db);
  assert.equal(r.summary.globalVsDivisionSum, 1);
  assert.deepEqual(r.globalVsDivisionSum[0], { material: "Modem B", field: "ready", global: 5, divisionSum: 4, delta: 1 });
});

test("MSG-style ready = Ready + Delivered is treated as expected, not a real mismatch", () => {
  const db = freshDb();
  db.exec("INSERT INTO materials VALUES ('Modem C',1, 5,0,0,0)");
  db.exec("INSERT INTO material_stock VALUES ('Modem C','MSG', 5,0,0,0)");
  db.exec(`INSERT INTO serial_numbers VALUES
    ('c1','Modem C','Ready','MSG'),('c2','Modem C','Ready','MSG'),
    ('c3','Modem C','Delivered','MSG'),('c4','Modem C','Delivered','MSG'),('c5','Modem C','Delivered','MSG')`);
  const r = computeStockConsistency(db);
  assert.equal(r.summary.serialVsMaterialStock, 0, "no REAL mismatch");
  assert.equal(r.summary.serialVsMaterialStockExpectedMsg, 1, "one expected-MSG row");
  assert.equal(r.summary.clean, true);
  assert.equal(r.serialVsMaterialStock[0].matchesDeliveredInclusive, true);
});

test("real serial drift, negatives, and orphan customer are all flagged", () => {
  const db = freshDb();
  db.exec("INSERT INTO materials VALUES ('Modem D',1, 9,0,-1,0)");
  db.exec("INSERT INTO material_stock VALUES ('Modem D','PIM', 9,0,-1,0)");
  db.exec("INSERT INTO serial_numbers VALUES ('d1','Modem D','Ready','PIM'),('d2','Modem D','Ready','PIM')");
  db.exec("INSERT INTO materials VALUES ('Modem E',1, 1,0,0,0)");
  db.exec("INSERT INTO material_stock VALUES ('Modem E','GHOST', 1,0,0,0)");
  const r = computeStockConsistency(db);
  assert.equal(r.summary.clean, false);
  assert.ok(r.serialVsMaterialStock.some((x) => x.material === "Modem D" && x.field === "ready" && x.delta === 7));
  assert.equal(r.negatives.length, 2); // division row + mirrored global row
  assert.equal(r.orphans.length, 1);
  assert.equal(r.orphans[0].customer, "GHOST");
});

test("serial rows with no division (customer NULL) are reported", () => {
  const db = freshDb();
  db.exec("INSERT INTO materials VALUES ('Modem F',1, 0,0,0,0)");
  db.exec("INSERT INTO serial_numbers VALUES ('f1','Modem F','Ready',NULL)");
  const r = computeStockConsistency(db);
  const row = r.serialVsMaterialStock.find((x) => x.material === "Modem F");
  assert.ok(row && row.customer === null && row.count === 1);
});

test("'Unassigned' stock is reported separately, not flagged as an orphan or unclean", () => {
  const db = freshDb();
  db.exec("INSERT INTO materials VALUES ('Modem G',1, 3,0,0,0)");
  db.exec("INSERT INTO material_stock VALUES ('Modem G','Unassigned', 3,0,0,0)");
  const r = computeStockConsistency(db);
  assert.equal(r.orphans.length, 0);
  assert.equal(r.summary.unassignedStock, 1);
  assert.deepEqual(r.unassignedStock[0], { material: "Modem G", ready: 3, faulty: 0, reserved: 0, in_transit: 0 });
  assert.equal(r.summary.clean, true);
});

test("non-serialized material is not checked against serial_numbers", () => {
  const db = freshDb();
  db.exec("INSERT INTO materials VALUES ('Kabel',0, 100,0,0,0)");
  db.exec("INSERT INTO material_stock VALUES ('Kabel','PIM', 100,0,0,0)");
  const r = computeStockConsistency(db);
  assert.equal(r.summary.clean, true);
});
