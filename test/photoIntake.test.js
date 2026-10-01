// photoIntake, presignDeep and the DB->bucket photo migration, against a
// fake bucket and node:sqlite. No network.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { intake } = require("../src/utils/photoIntake");
const { presignDeep } = require("../src/utils/photos");
const { remaining, migrateBatch } = require("../src/utils/photoMigration");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(path.join(__dirname, "../src/schema.sql"), "utf8"));
  return db;
}
function fakeStore({ failOn } = {}) {
  const objects = new Map();
  return {
    objects,
    putObject: async (key, body) => { if (failOn && body.toString() === failOn) throw new Error("bucket down"); objects.set(key, body); },
    deleteObject: async (key) => { objects.delete(key); },
    presignGet: (key) => `https://fake.bucket/${key}?sig=1`,
    keyFromUrl: (url) => (url.startsWith("https://fake.bucket/") ? url.slice("https://fake.bucket/".length).split("?")[0] : null),
  };
}
const jpg = (text) => `data:image/jpeg;base64,${Buffer.from(text).toString("base64")}`;

test("intake uploads fresh photos, keeps order, maps echoed URLs back, leaves empties null", async () => {
  const db = freshDb();
  const store = fakeStore();
  const p = await intake(db, [{ value: jpg("A"), name: "a" }, { value: "", name: "none" }, { value: "https://fake.bucket/returns/old.jpg?sig=1", name: "old" }, { value: jpg("B"), name: "b" }], { folder: "returns", store });
  assert.match(p.refs[0], /^obj:returns\/\d{4}\/\d{2}\/.+\.jpg$/);
  assert.equal(p.refs[1], null);
  assert.equal(p.refs[2], "obj:returns/old.jpg");
  assert.match(p.refs[3], /^obj:returns\//);
  assert.equal(store.objects.size, 2);
});

test("discard removes only what this intake uploaded; commit claims originals with the Drive path", async () => {
  const db = freshDb();
  const store = fakeStore();
  store.objects.set("returns/old.jpg", Buffer.from("old"));
  const p = await intake(db, [{ value: jpg("A"), name: "SN-1/2" }, { value: "https://fake.bucket/returns/old.jpg?sig=1", name: "old" }], { folder: "returns", store });
  p.commit("LMS Terex/Return Faulty/RF-1");
  const rows = db.prepare("SELECT compressed_ref, drive_path, drive_name, status FROM photo_originals").all();
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ compressed_ref: p.refs[0], drive_path: "LMS Terex/Return Faulty/RF-1", drive_name: "SN-1-2", status: "claimed" }]);
  await p.discard();
  assert.deepEqual([...store.objects.keys()], ["returns/old.jpg"]);
});

test("a failed upload rolls back the photos already uploaded and rethrows", async () => {
  const db = freshDb();
  const store = fakeStore({ failOn: "BAD" });
  await assert.rejects(() => intake(db, [{ value: jpg("A") }, { value: jpg("BAD") }, { value: jpg("C") }], { folder: "x", store, concurrency: 1 }), /bucket down/);
  assert.equal(store.objects.size, 0);
});

test("dropReplaced deletes old refs the new version no longer uses", async () => {
  const db = freshDb();
  const store = fakeStore();
  store.objects.set("x/keep.jpg", Buffer.from("k"));
  store.objects.set("x/gone.jpg", Buffer.from("g"));
  const p = await intake(db, [{ value: "https://fake.bucket/x/keep.jpg?sig=1" }], { folder: "x", store });
  await p.dropReplaced(["obj:x/keep.jpg", "obj:x/gone.jpg", null, "data:image/png;base64,AAAA"]);
  assert.deepEqual([...store.objects.keys()], ["x/keep.jpg"]);
});

test("presignDeep turns every obj: ref in a response into a URL and leaves the rest alone", () => {
  const store = fakeStore();
  const body = { id: "RF-1", docs: { before: "obj:returns/a.jpg", note: "objective: none" }, items: [{ serials: [{ sn: "S1", photo: "obj:returns/b.jpg" }, { sn: "S2", photo: null }] }], legacy: "data:image/png;base64,AAAA", n: 3 };
  assert.deepEqual(presignDeep(body, store), {
    id: "RF-1", docs: { before: "https://fake.bucket/returns/a.jpg?sig=1", note: "objective: none" },
    items: [{ serials: [{ sn: "S1", photo: "https://fake.bucket/returns/b.jpg?sig=1" }, { sn: "S2", photo: null }] }],
    legacy: "data:image/png;base64,AAAA", n: 3,
  });
});

test("migration moves data-URL photos into the bucket in batches and skips rows it can't move", async () => {
  const db = freshDb();
  const store = fakeStore();
  db.exec(`INSERT INTO returns (id, technician, homebase, status, date, doc_before, doc_after, doc_weighing) VALUES
    ('RF-1','T','H','Completed','2026-01-01','${jpg("b1")}','${jpg("a1")}','data:text/plain;base64,AAAA'),
    ('RF-2','T','H','Completed','2026-01-02','obj:returns/already.jpg','${jpg("a2")}',NULL)`);
  assert.equal(remaining(db).total, 4);
  let cursor;
  let moved = 0, failed = 0, rounds = 0;
  for (;;) {
    const r = await migrateBatch(db, store, { limit: 2, cursor });
    moved += r.migrated; failed += r.failed; cursor = r.cursor; rounds++;
    if (r.done) break;
    assert.ok(rounds < 50, "must terminate");
  }
  assert.equal(moved, 3);
  assert.equal(failed, 1); // the text/plain "photo" stays in the DB untouched
  assert.deepEqual(remaining(db), { total: 1, byColumn: { "returns.doc_weighing": 1 } });
  const rf1 = db.prepare("SELECT doc_before, doc_after FROM returns WHERE id = 'RF-1'").get();
  assert.match(rf1.doc_before, /^obj:returns\//);
  assert.match(rf1.doc_after, /^obj:returns\//);
  assert.equal(db.prepare("SELECT doc_before FROM returns WHERE id = 'RF-2'").get().doc_before, "obj:returns/already.jpg");
  assert.equal(store.objects.size, 3);
});
