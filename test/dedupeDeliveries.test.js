const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { removeDuplicateDeliveries } = require("../src/utils/dedupeDeliveries");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(path.join(__dirname, "../src/schema.sql"), "utf8"));
  // columns db.js adds by ALTER TABLE on a real database
  const cols = db.prepare("PRAGMA table_info(deliveries)").all().map((c) => c.name);
  if (!cols.includes("customer")) db.exec("ALTER TABLE deliveries ADD COLUMN customer TEXT");
  return db;
}

function addDelivery(db, id, over = {}) {
  const d = { requester: "Wafi Nur", homebase: "Malinau", site: "", keperluan: "CM / PM", note: "", status: "Waiting Logistics Approval", date: "2026-10-01", customer: "Teleglobal", items: [["Modem", 2, "material"]], ...over };
  db.prepare("INSERT INTO deliveries (id, requester, homebase, site, keperluan, note, status, date, customer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, d.requester, d.homebase, d.site, d.keperluan, d.note, d.status, d.date, d.customer);
  d.items.forEach(([m, q, t]) => db.prepare("INSERT INTO delivery_items (delivery_id, material, qty, item_type) VALUES (?, ?, ?, ?)").run(id, m, q, t));
  db.prepare("INSERT INTO delivery_history (delivery_id, time, text) VALUES (?, ?, ?)").run(id, "2026-10-01T04:26:00Z", "Dibuat");
}
const ids = (db) => db.prepare("SELECT id FROM deliveries ORDER BY id").all().map((r) => r.id);

test("deletes exact untouched copies, keeps the original, leaves anything different alone", () => {
  const db = makeDb();
  addDelivery(db, "DR-001", { requester: "Orang Lain" });
  addDelivery(db, "DR-002");
  addDelivery(db, "DR-003");
  addDelivery(db, "DR-004");
  addDelivery(db, "DR-005", { status: "Waiting Stock Assignment" }); // already approved
  addDelivery(db, "DR-006", { items: [["Modem", 3, "material"]] });  // different qty
  addDelivery(db, "DR-007", { homebase: "Bengkulu" });                // different destination

  const r = removeDuplicateDeliveries(db, "DR-002", ["DR-002", "DR-003", "DR-004", "DR-005", "DR-006", "DR-007", "DR-999"]);
  assert.deepEqual(r.deleted, ["DR-003", "DR-004"]);
  assert.deepEqual(r.skipped.map((s) => s.id), ["DR-002", "DR-005", "DR-006", "DR-007"]);
  assert.deepEqual(ids(db), ["DR-001", "DR-002", "DR-005", "DR-006", "DR-007"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_items WHERE delivery_id IN ('DR-003','DR-004')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_history WHERE delivery_id IN ('DR-003','DR-004')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_items WHERE delivery_id = 'DR-002'").get().n, 1);

  const again = removeDuplicateDeliveries(db, "DR-002", ["DR-003", "DR-004"]);
  assert.deepEqual(again.deleted, []);
  assert.deepEqual(again.skipped, []);
});

test("does nothing when the request to keep does not exist", () => {
  const db = makeDb();
  addDelivery(db, "DR-003");
  const r = removeDuplicateDeliveries(db, "DR-002", ["DR-003"]);
  assert.deepEqual(r.deleted, []);
  assert.deepEqual(ids(db), ["DR-003"]);
});
