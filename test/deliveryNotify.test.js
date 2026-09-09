const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { announceDelivery, buildMessage, EVENTS } = require("../src/utils/deliveryNotify");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT, name TEXT, role TEXT, status TEXT, telegram_chat_id TEXT);
    CREATE TABLE user_divisions (user_id TEXT, customer TEXT);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, type TEXT, title TEXT, body TEXT,
      ref_type TEXT, ref_id TEXT, actor TEXT, created_at TEXT, read_at TEXT
    );
  `);
  db.exec(`
    INSERT INTO users VALUES
      ('u_mgr','Budi','Admin / Manager Logistics','Active',NULL),
      ('u_log_msg','Sari','Logistics Staff','Active','555'),
      ('u_spv','Rina','SPV','Active','999');
    INSERT INTO user_divisions VALUES ('u_log_msg','MSG');
  `);
  return db;
}

const DR = { id: "DR-260909-001", customer: "MSG", homebase: "Merauke", site: "SDN 1", keperluan: "Instalasi", itemCount: 3, requester: "Rina" };

test("created → notifies managers only, not the requester", () => {
  const db = freshDb();
  announceDelivery(DR, { event: "created", actor: "Rina" }, db);
  const rows = db.prepare("SELECT user_id, title FROM notifications").all();
  assert.deepEqual(rows.map((r) => r.user_id), ["u_mgr"]);
  assert.match(rows[0].title, /menunggu approval/i);
});

test("approved → requester + division Logistics, actor (manager) skipped", () => {
  const db = freshDb();
  announceDelivery(DR, { event: "approved", actor: "Budi" }, db);
  const rows = db.prepare("SELECT user_id FROM notifications ORDER BY user_id").all();
  assert.deepEqual(rows.map((r) => r.user_id), ["u_log_msg", "u_spv"]);
});

test("cancelled with releasedStock=false → only the requester", () => {
  const db = freshDb();
  announceDelivery(DR, { event: "cancelled", actor: "Budi", note: "test", releasedStock: false }, db);
  const rows = db.prepare("SELECT user_id, body FROM notifications").all();
  assert.deepEqual(rows.map((r) => r.user_id), ["u_spv"]);
  assert.equal(rows[0].body, "test");
});

test("cancelled with releasedStock=true → requester + Logistics", () => {
  const db = freshDb();
  announceDelivery(DR, { event: "cancelled", actor: "Budi", note: "batal", releasedStock: true }, db);
  const rows = db.prepare("SELECT DISTINCT user_id FROM notifications ORDER BY user_id").all();
  assert.deepEqual(rows.map((r) => r.user_id), ["u_log_msg", "u_spv"]);
});

test("unknown event is a no-op, not a throw", () => {
  const db = freshDb();
  announceDelivery(DR, { event: "nope", actor: "X" }, db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0);
});

test("buildMessage renders status, destination, actor and note", () => {
  const msg = buildMessage(DR, EVENTS.rejected, { actor: "Budi", note: "Stok tidak cukup" });
  assert.match(msg, /Delivery DR-260909-001/);
  assert.match(msg, /Ditolak/);
  assert.match(msg, /Tujuan: Merauke · SDN 1/);
  assert.match(msg, /Diproses oleh: Budi/);
  assert.match(msg, /Catatan: Stok tidak cukup/);
});

test("buildMessage escapes HTML in free-text fields", () => {
  const msg = buildMessage({ ...DR, site: "<b>x</b>" }, EVENTS.shipped, { actor: "Sari" });
  assert.match(msg, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(msg, /<b>x<\/b>/);
});
