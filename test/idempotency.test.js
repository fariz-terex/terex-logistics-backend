const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const { DatabaseSync } = require("node:sqlite");
const { idempotency } = require("../src/utils/idempotency");
const { lightSelect, flag } = require("../src/utils/lightRows");
const { photoUrl } = require("../src/utils/photos");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE idempotency_keys (key TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)");
  return db;
}

function fakeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.set = (k, v) => { res.headers[k] = v; return res; };
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (body) => { res.body = body; res.emit("finish"); return res; };
  return res;
}
const fakeReq = (key, extra = {}) => ({
  method: "POST", originalUrl: "/api/deliveries",
  headers: { authorization: "Bearer a", ...(key ? { "idempotency-key": key } : {}) }, ...extra,
});

test("a repeat with the same key gets the first answer and does not run the route again", () => {
  const mw = idempotency(makeDb());
  let runs = 0;
  const route = (res) => () => { runs += 1; res.status(201).json({ id: `DR-${runs}` }); };

  const r1 = fakeRes(); mw(fakeReq("key-12345678"), r1, route(r1));
  const r2 = fakeRes(); mw(fakeReq("key-12345678"), r2, route(r2));
  assert.equal(runs, 1);
  assert.equal(r2.statusCode, 201);
  assert.deepEqual(r2.body, { id: "DR-1" });
  assert.equal(r2.headers["Idempotent-Replay"], "true");

  const r3 = fakeRes(); mw(fakeReq("key-87654321"), r3, route(r3));
  assert.equal(runs, 2, "a different key is a different request");
});

test("keys are per caller and per URL; no key / GET are passed straight through", () => {
  const mw = idempotency(makeDb());
  let runs = 0;
  const route = (res) => () => { runs += 1; res.json({ n: runs }); };
  const call = (req) => { const res = fakeRes(); mw(req, res, route(res)); return res; };

  call(fakeReq("key-12345678"));
  call(fakeReq("key-12345678", { headers: { authorization: "Bearer b", "idempotency-key": "key-12345678" } }));
  call(fakeReq("key-12345678", { originalUrl: "/api/returns" }));
  assert.equal(runs, 3);
  call(fakeReq(null)); call(fakeReq(null));
  assert.equal(runs, 5);
  call(fakeReq("key-12345678", { method: "GET" })); call(fakeReq("key-12345678", { method: "GET" }));
  assert.equal(runs, 7);
});

test("a failed answer is not stored, so the retry really runs", () => {
  const mw = idempotency(makeDb());
  let runs = 0;
  const failing = (res) => () => { runs += 1; res.status(409).json({ error: "stok kurang" }); };
  const ok = (res) => () => { runs += 1; res.status(201).json({ id: "DR-1" }); };
  const r1 = fakeRes(); mw(fakeReq("key-12345678"), r1, failing(r1));
  const r2 = fakeRes(); mw(fakeReq("key-12345678"), r2, ok(r2));
  assert.equal(runs, 2);
  assert.equal(r2.statusCode, 201);
});

test("a duplicate arriving while the first is still running waits for it", async () => {
  const mw = idempotency(makeDb());
  let runs = 0;
  const r1 = fakeRes(); const r2 = fakeRes();
  let finishFirst;
  mw(fakeReq("key-12345678"), r1, () => { runs += 1; finishFirst = () => r1.status(201).json({ id: "DR-1" }); });
  mw(fakeReq("key-12345678"), r2, () => { runs += 1; r2.status(201).json({ id: "DR-2" }); });
  assert.equal(runs, 1);
  finishFirst();
  await new Promise((r) => setImmediate(r));
  assert.equal(runs, 1);
  assert.deepEqual(r2.body, { id: "DR-1" });
});

test("stored answers expire after 24 hours", () => {
  let t = 1_000_000;
  const mw = idempotency(makeDb(), { now: () => t });
  let runs = 0;
  const route = (res) => () => { runs += 1; res.json({ n: runs }); };
  let res = fakeRes(); mw(fakeReq("key-aaaaaaaa"), res, route(res));
  t += 25 * 60 * 60 * 1000;
  res = fakeRes(); mw(fakeReq("key-bbbbbbbb"), res, route(res)); // storing this one purges the old row
  res = fakeRes(); mw(fakeReq("key-aaaaaaaa"), res, route(res));
  assert.equal(runs, 3);
});

test("lightSelect swaps photo columns for has-a-value flags", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE things (id TEXT, name TEXT, photo TEXT, doc TEXT)");
  db.prepare("INSERT INTO things VALUES (?, ?, ?, ?)").run("A", "satu", "data:image/jpeg;base64,AAAA", null);
  db.prepare("INSERT INTO things VALUES (?, ?, ?, ?)").run("B", "dua", "", "obj:x/y.jpg");
  const cols = lightSelect(db, "things", ["photo", "doc"]);
  const rows = db.prepare(`SELECT ${cols} FROM things ORDER BY id`).all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { id: "A", name: "satu", photo: 1, doc: 0 },
    { id: "B", name: "dua", photo: 0, doc: 1 },
  ]);
  assert.equal(flag(1), true);
  assert.equal(flag(0), null);
});

test("photoUrl is stable inside a 6-hour window and stays valid at least 6 hours", () => {
  const calls = [];
  const store = { presignGet: (key, ttl, at) => { calls.push({ key, ttl, at }); return `https://b/${key}?d=${at.toISOString()}`; } };
  const base = Date.UTC(2026, 9, 1, 6, 0, 0);
  const a = photoUrl("obj:x/1.jpg", store, base + 60 * 1000);
  const b = photoUrl("obj:x/1.jpg", store, base + 5 * 60 * 60 * 1000 + 59 * 60 * 1000);
  const c = photoUrl("obj:x/1.jpg", store, base + 6 * 60 * 60 * 1000);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(calls[0].at.getTime(), base);
  assert.ok(calls[0].ttl >= 12 * 60 * 60, "signed up to 6h in the past, so the lifetime must cover that plus 6h of use");
  assert.equal(photoUrl("data:image/png;base64,AA", store), "data:image/png;base64,AA");
});
