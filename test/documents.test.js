// Same setup as test/stockTransfers.test.js — real schema.sql on node:sqlite.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { nextDocNumber, createDocument, createShipmentDocuments, itemsFromSerials, loadDocument, divisionCode } = require("../src/utils/documents");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(fs.readFileSync(path.join(__dirname, "../src/schema.sql"), "utf8"));
  db.exec(`
    INSERT INTO materials (id, name, category, unit, serialized, min_stock, status, ready, faulty, reserved, in_transit)
    VALUES ('MAT001','Modem HT3300','Modem','Unit',1,0,'Active',0,0,0,0),
           ('MAT002','Kabel UTP','Kabel','Meter',0,0,'Active',0,0,0,0)
  `);
  return db;
}

const base = { kind: "customer_receipt", customer: "MSG", sourceType: "receipt", sourceRef: "WR-1", items: [{ material: "Kabel UTP", qty: 5 }] };

test("numbers run per type, per division, per month", () => {
  const db = freshDb();
  assert.equal(createDocument(db, { ...base, type: "BMB", date: "2026-09-10" }).number, "TRX/BMB/MSG/2026/09/0001");
  assert.equal(createDocument(db, { ...base, type: "BMB", date: "2026-09-11" }).number, "TRX/BMB/MSG/2026/09/0002");
  assert.equal(createDocument(db, { ...base, type: "BMB", customer: "PIM", date: "2026-09-11" }).number, "TRX/BMB/PIM/2026/09/0001");
  assert.equal(createDocument(db, { ...base, type: "BMB", date: "2026-10-01" }).number, "TRX/BMB/MSG/2026/10/0001");
  assert.equal(createDocument(db, { ...base, type: "BKB", kind: "delivery", date: "2026-09-12" }).number, "TRX/BKB/MSG/2026/09/0001");
});

test("MAX+1, not COUNT+1: a deleted document never causes a duplicate number", () => {
  const db = freshDb();
  createDocument(db, { ...base, type: "BMB", date: "2026-09-10" });
  const second = createDocument(db, { ...base, type: "BMB", date: "2026-09-10" });
  createDocument(db, { ...base, type: "BMB", date: "2026-09-10" });
  db.prepare("DELETE FROM documents WHERE id = ?").run(second.id);
  assert.equal(nextDocNumber(db, "BMB", "MSG", "2026-09-20"), "TRX/BMB/MSG/2026/09/0004");
});

test("division code is upper-cased and stripped to one clean segment", () => {
  assert.equal(divisionCode("Teleglobal"), "TELEGLOBAL");
  assert.equal(divisionCode("PT X / Y"), "PTXY");
});

test("items keep serials, derive qty from them and look up the unit", () => {
  const db = freshDb();
  const { id } = createDocument(db, { ...base, type: "BMB", items: [{ material: "Modem HT3300", serials: ["SN1", "SN2"] }, { material: "Kabel UTP", qty: 20 }] });
  const doc = loadDocument(db, id);
  assert.deepEqual(doc.items, [
    { material: "Modem HT3300", itemType: "material", qty: 2, unit: "Unit", serials: ["SN1", "SN2"] },
    { material: "Kabel UTP", itemType: "material", qty: 20, unit: "Meter", serials: [] },
  ]);
  assert.equal(doc.kindLabel, "Penerimaan dari Customer");
});

test("rejects unknown type/kind and empty documents", () => {
  const db = freshDb();
  assert.throws(() => createDocument(db, { ...base, type: "XYZ" }), /tidak dikenal/);
  assert.throws(() => createDocument(db, { ...base, type: "BMB", kind: "delivery" }), /tidak dikenal/);
  assert.throws(() => createDocument(db, { ...base, type: "BMB", items: [] }), /minimal satu barang/);
});

test("createShipmentDocuments makes a BKB and its Surat Jalan, linked both ways", () => {
  const db = freshDb();
  const { bkb, sj } = createShipmentDocuments(db, { kind: "delivery", customer: "MSG", sourceType: "delivery", sourceRef: "DR-1", date: "2026-09-15", items: [{ material: "Kabel UTP", qty: 3 }] });
  assert.equal(bkb.number, "TRX/BKB/MSG/2026/09/0001");
  assert.equal(sj.number, "TRX/SJ/MSG/2026/09/0001");
  assert.equal(loadDocument(db, bkb.id).related.number, sj.number);
  assert.equal(loadDocument(db, sj.id).related.number, bkb.number);
});

test("itemsFromSerials groups units per material", () => {
  assert.deepEqual(itemsFromSerials([{ sn: "A", material: "M1" }, { sn: "B", material: "M2" }, { sn: "C", material: "M1" }]), [
    { material: "M1", qty: 2, serials: ["A", "C"] },
    { material: "M2", qty: 1, serials: ["B"] },
  ]);
});
