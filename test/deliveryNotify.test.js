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
      ('u_spv_msg','Rina','SPV','Active','999'),
      ('u_spv_pim','Toni','SPV','Active','777'),
      ('u_mgrdiv_msg','Wati','Manager Divisi','Active','888');
    INSERT INTO user_divisions VALUES
      ('u_log_msg','MSG'), ('u_spv_msg','MSG'), ('u_spv_msg','RGR'),
      ('u_spv_pim','PIM'), ('u_mgrdiv_msg','MSG');
  `);
  return db;
}

const recipients = (db) => db.prepare("SELECT DISTINCT user_id FROM notifications ORDER BY user_id").all().map((r) => r.user_id);
// A DR for MSG, requested by Rina (u_spv_msg)
const DR = { id: "DR-260909-001", customer: "MSG", homebase: "Merauke", site: "SDN 1", keperluan: "Instalasi", itemCount: 3, requester: "Rina" };

test("created (by Logistics, not the SPV) → managers + division watchers of MSG", () => {
  const db = freshDb();
  announceDelivery(DR, { event: "created", actor: "Sari" }, db);
  assert.deepEqual(recipients(db), ["u_mgr", "u_mgrdiv_msg", "u_spv_msg"]);
});

test("created by the SPV → SPV (actor) is not notified about their own DR", () => {
  const db = freshDb();
  announceDelivery(DR, { event: "created", actor: "Rina" }, db);
  assert.deepEqual(recipients(db), ["u_mgr", "u_mgrdiv_msg"]); // Wati still gets it, Rina (actor) doesn't
});

test("SPV of a different division (PIM) never gets an MSG DR notification", () => {
  const db = freshDb();
  for (const event of ["created", "approved", "preparing", "shipped", "delivered", "rejected", "cancelled"]) {
    announceDelivery(DR, { event, actor: "Sari", note: "x", releasedStock: true }, db);
  }
  assert.ok(!recipients(db).includes("u_spv_pim"));
});

test("progress events (approved/preparing/shipped) do NOT reach the division watcher", () => {
  const db = freshDb();
  announceDelivery(DR, { event: "approved", actor: "Budi" }, db);
  announceDelivery(DR, { event: "preparing", actor: "Sari" }, db);
  announceDelivery(DR, { event: "shipped", actor: "Sari" }, db);
  // Rina is here as the REQUESTER, not as a watcher. Wati (Manager Divisi,
  // not the requester) must not appear.
  assert.ok(!recipients(db).includes("u_mgrdiv_msg"));
});

test("milestone events (delivered/rejected/cancelled) DO reach division watchers", () => {
  for (const event of ["delivered", "rejected", "cancelled"]) {
    const db = freshDb();
    announceDelivery(DR, { event, actor: "Budi", note: "n" }, db);
    assert.ok(recipients(db).includes("u_mgrdiv_msg"), `${event} should notify Manager Divisi`);
    assert.ok(recipients(db).includes("u_spv_msg"), `${event} should notify SPV`);
  }
});

test("approved → requester + division Logistics, actor (manager) skipped", () => {
  const db = freshDb();
  announceDelivery(DR, { event: "approved", actor: "Budi" }, db);
  assert.deepEqual(recipients(db), ["u_log_msg", "u_spv_msg"]);
});

test("cancelled with releasedStock=false → requester + division watchers (not Logistics)", () => {
  const db = freshDb();
  announceDelivery(DR, { event: "cancelled", actor: "Budi", note: "test", releasedStock: false }, db);
  assert.deepEqual(recipients(db), ["u_mgrdiv_msg", "u_spv_msg"]);
});

test("cancelled with releasedStock=true → also Logistics", () => {
  const db = freshDb();
  announceDelivery(DR, { event: "cancelled", actor: "Budi", note: "batal", releasedStock: true }, db);
  assert.deepEqual(recipients(db), ["u_log_msg", "u_mgrdiv_msg", "u_spv_msg"]);
});

test("unknown event is a no-op, not a throw", () => {
  const db = freshDb();
  announceDelivery(DR, { event: "nope", actor: "X" }, db);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 0);
});

test("buildMessage renders status, destination, actor and note; escapes HTML", () => {
  const msg = buildMessage(DR, EVENTS.rejected, { actor: "Budi", note: "Stok tidak cukup" });
  assert.match(msg, /Delivery DR-260909-001/);
  assert.match(msg, /Ditolak/);
  assert.match(msg, /Tujuan: Merauke · SDN 1/);
  assert.match(msg, /Diproses oleh: Budi/);
  assert.match(msg, /Catatan: Stok tidak cukup/);

  const esc = buildMessage({ ...DR, site: "<b>x</b>" }, EVENTS.shipped, { actor: "Sari" });
  assert.match(esc, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.doesNotMatch(esc, /<b>x<\/b>/);
});
