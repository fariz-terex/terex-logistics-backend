const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { notify, activeManagerIds, activeLogisticsIdsForDivision, userIdsByName } = require("../src/utils/notify");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT, name TEXT, role TEXT, status TEXT);
    CREATE TABLE user_divisions (user_id TEXT, customer TEXT);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, type TEXT, title TEXT, body TEXT,
      ref_type TEXT, ref_id TEXT, actor TEXT, created_at TEXT, read_at TEXT
    );
  `);
  db.exec(`
    INSERT INTO users VALUES
      ('u_mgr','Budi','Admin / Manager Logistics','Active'),
      ('u_mgr2','Old Manager','Admin / Manager Logistics','Inactive'),
      ('u_log_msg','Sari','Logistics Staff','Active'),
      ('u_log_pim','Andi','Logistics Staff','Active'),
      ('u_spv','Rina','SPV','Active');
    INSERT INTO user_divisions VALUES ('u_log_msg','MSG'), ('u_log_pim','PIM');
  `);
  return db;
}

test("activeManagerIds returns only active managers", () => {
  const db = freshDb();
  assert.deepEqual(activeManagerIds(db), ["u_mgr"]);
});

test("activeLogisticsIdsForDivision is scoped to the division", () => {
  const db = freshDb();
  assert.deepEqual(activeLogisticsIdsForDivision("MSG", db), ["u_log_msg"]);
  assert.deepEqual(activeLogisticsIdsForDivision("PIM", db), ["u_log_pim"]);
  assert.deepEqual(activeLogisticsIdsForDivision("RGR", db), []);
  assert.deepEqual(activeLogisticsIdsForDivision(null, db), []);
});

test("userIdsByName resolves the requester name to id(s)", () => {
  const db = freshDb();
  assert.deepEqual(userIdsByName("Rina", db), ["u_spv"]);
  assert.deepEqual(userIdsByName("Nobody", db), []);
});

test("notify writes one row per recipient, dedupes, and skips the actor", () => {
  const db = freshDb();
  notify(["u_spv", "u_spv", "u_log_msg", "u_mgr"], {
    type: "delivery.status", title: "DR-1 disetujui", body: "b",
    refType: "delivery", refId: "DR-1", actor: "Budi", // Budi == u_mgr
  }, db);
  const rows = db.prepare("SELECT user_id, title, ref_id, read_at FROM notifications ORDER BY user_id").all();
  assert.deepEqual(rows.map((r) => r.user_id), ["u_log_msg", "u_spv"]); // u_mgr skipped (actor), u_spv deduped
  assert.equal(rows[0].ref_id, "DR-1");
  assert.equal(rows[0].read_at, null);
});

test("notify with an empty recipient list is a no-op", () => {
  const db = freshDb();
  notify([], { type: "x", title: "y" }, db);
  notify(userIdsByName("Nobody", db), { type: "x", title: "y" }, db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0);
});

test("notify only recipient == actor produces nothing", () => {
  const db = freshDb();
  notify(activeManagerIds(db), { type: "x", title: "y", actor: "Budi" }, db); // Budi is the only active manager
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0);
});
