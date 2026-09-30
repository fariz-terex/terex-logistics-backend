// Original-photo archiving: linking staged originals to stored compressed
// copies, the archive worker (fake bucket + fake Drive), and the Drive
// client's HTTP calls (fake fetch). No network.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const originals = require("../src/utils/originals");
const { runArchiveOnce } = require("../src/utils/archiveWorker");
const { createDriveClient, authUrl } = require("../src/utils/googleDrive");

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync(path.join(__dirname, "../src/schema.sql"), "utf8"));
  return db;
}
const dataUrl = (text) => `data:image/jpeg;base64,${Buffer.from(text).toString("base64")}`;
const sha = (text) => crypto.createHash("sha256").update(Buffer.from(text)).digest("hex");

test("hashDataUrl hashes the decoded bytes (same as the browser's digest)", () => {
  assert.equal(originals.hashDataUrl(dataUrl("compressed-1")), sha("compressed-1"));
  assert.equal(originals.hashDataUrl("https://x/y.jpg"), null);
});

test("stage then claim, or claim then stage — both meet on the hash", () => {
  const db = freshDb();
  originals.stageOriginal(db, { hash: sha("A"), stagingKey: "originals/a.jpg" });
  originals.claimOriginals(db, [{ value: dataUrl("A"), ref: "obj:x/a.jpg", path: "LMS Terex/Reconciliation/RC-1", name: "SN-1.jpg" }]);
  originals.claimOriginals(db, [{ value: dataUrl("B"), ref: "obj:x/b.jpg", path: "LMS Terex/Reconciliation/RC-1", name: "SN-2.jpg" }]);
  originals.stageOriginal(db, { hash: sha("B"), stagingKey: "originals/b.jpg" });
  const batch = originals.archiveBatch(db);
  assert.deepEqual(batch.map((r) => [r.staging_key, r.compressed_ref, r.drive_name, r.status]), [
    ["originals/a.jpg", "obj:x/a.jpg", "SN-1.jpg", "claimed"],
    ["originals/b.jpg", "obj:x/b.jpg", "SN-2.jpg", "claimed"],
  ]);
});

test("a second staging of the same compressed photo is refused; claimed-but-unstaged rows wait", () => {
  const db = freshDb();
  assert.equal(originals.stageOriginal(db, { hash: sha("A"), stagingKey: "k1" }), true);
  assert.equal(originals.stageOriginal(db, { hash: sha("A"), stagingKey: "k2" }), false);
  originals.claimOriginals(db, [{ value: dataUrl("C"), ref: "obj:c", path: "P", name: "c.jpg" }]);
  assert.equal(originals.archiveBatch(db).length, 0); // A unclaimed, C not staged yet
});

test("claimOriginals skips values that aren't fresh uploads (echoed URLs)", () => {
  const db = freshDb();
  originals.claimOriginals(db, [{ value: "https://bucket/x.jpg?sig", ref: "obj:x.jpg", path: "P", name: "x.jpg" }]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM photo_originals").get().n, 0);
});

function fakeStore(files) {
  const objects = new Map(Object.entries(files));
  return {
    objects,
    getObject: async (key) => { if (!objects.has(key)) throw new Error("missing"); return { body: Buffer.from(objects.get(key)), contentType: "image/jpeg" }; },
    deleteObject: async (key) => { objects.delete(key); },
  };
}

test("worker uploads claimed originals into their folder, then deletes the staged copy", async () => {
  const db = freshDb();
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('gdrive_refresh_token', 'rt')").run();
  originals.stageOriginal(db, { hash: sha("A"), stagingKey: "originals/a.jpg" });
  originals.claimOriginals(db, [{ value: dataUrl("A"), ref: "obj:x/a.jpg", path: "LMS Terex/Reconciliation/RC-1", name: "SN-1.jpg" }]);
  const store = fakeStore({ "originals/a.jpg": "ORIGINAL-BYTES" });
  const uploads = [];
  const fakeDrive = { ensureFolder: async (p) => `folder:${p}`, uploadFile: async (f) => { uploads.push({ ...f, body: f.body.toString() }); return { id: "F1", webViewLink: "https://drive/F1" }; } };
  const r = await runArchiveOnce(db, store, { env: { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }, createDriveClient: () => fakeDrive });
  assert.deepEqual(r, { archived: 1, failed: 0, cleaned: 0 });
  assert.deepEqual(uploads, [{ name: "SN-1.jpg", parentId: "folder:LMS Terex/Reconciliation/RC-1", mimeType: "image/jpeg", body: "ORIGINAL-BYTES" }]);
  assert.equal(store.objects.has("originals/a.jpg"), false);
  assert.equal(originals.originalLink(db, "obj:x/a.jpg"), "https://drive/F1");
});

test("worker records failures and gives up after MAX_ATTEMPTS; does nothing without a connected account", async () => {
  const db = freshDb();
  originals.stageOriginal(db, { hash: sha("A"), stagingKey: "originals/a.jpg" });
  originals.claimOriginals(db, [{ value: dataUrl("A"), ref: "obj:a", path: "P", name: "a.jpg" }]);
  const store = fakeStore({ "originals/a.jpg": "X" });
  const env = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" };
  assert.deepEqual(await runArchiveOnce(db, store, { env, createDriveClient: () => { throw new Error("should not be called"); } }), { archived: 0, failed: 0, cleaned: 0 });
  db.prepare("INSERT INTO app_settings (key, value) VALUES ('gdrive_refresh_token', 'rt')").run();
  const broken = { ensureFolder: async () => { throw new Error("quota"); }, uploadFile: async () => ({}) };
  for (let i = 0; i < originals.MAX_ATTEMPTS; i++) await runArchiveOnce(db, store, { env, createDriveClient: () => broken });
  const row = db.prepare("SELECT status, attempts, error FROM photo_originals").get();
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, originals.MAX_ATTEMPTS);
  assert.match(row.error, /quota/);
  assert.equal(store.objects.has("originals/a.jpg"), true, "staged original kept for a later retry/inspection");
});

test("worker cleans up originals nobody claimed after a few days", async () => {
  const db = freshDb();
  originals.stageOriginal(db, { hash: sha("A"), stagingKey: "originals/a.jpg" });
  db.prepare("UPDATE photo_originals SET created_at = '2020-01-01T00:00:00.000Z'").run();
  const store = fakeStore({ "originals/a.jpg": "X" });
  const r = await runArchiveOnce(db, store, { env: {} });
  assert.equal(r.cleaned, 1);
  assert.equal(store.objects.size, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM photo_originals").get().n, 0);
});

test("drive client: refreshes a token, creates missing folders once, uploads resumably", async () => {
  const calls = [];
  const cache = new Map();
  const fetchImpl = async (url, init = {}) => {
    calls.push(`${init.method || "GET"} ${url.split("?")[0]}`);
    const json = (body, headers = {}) => ({ ok: true, status: 200, json: async () => body, text: async () => "", headers: { get: (h) => headers[h.toLowerCase()] } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "AT", expires_in: 3600 });
    if (url.includes("/drive/v3/files?q=")) return json({ files: [] });
    if (url.includes("/drive/v3/files?fields=id")) return json({ id: `id-${JSON.parse(init.body).name}` });
    if (url.includes("uploadType=resumable")) return json({}, { location: "https://upload/session/1" });
    if (url === "https://upload/session/1") return json({ id: "FILE", webViewLink: "https://drive/FILE" });
    throw new Error(`unexpected ${url}`);
  };
  const drive = createDriveClient({ refreshToken: "rt", env: { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s" }, fetchImpl, folderCache: { get: (p) => cache.get(p), set: (p, id) => cache.set(p, id) } });
  assert.equal(await drive.ensureFolder("LMS Terex/Reconciliation"), "id-Reconciliation");
  assert.equal(await drive.ensureFolder("LMS Terex/Reconciliation"), "id-Reconciliation"); // cached, no new calls
  const file = await drive.uploadFile({ name: "a.jpg", parentId: "id-Reconciliation", mimeType: "image/jpeg", body: Buffer.from("x") });
  assert.deepEqual(file, { id: "FILE", webViewLink: "https://drive/FILE" });
  assert.deepEqual(calls, [
    "POST https://oauth2.googleapis.com/token",
    "GET https://www.googleapis.com/drive/v3/files", "POST https://www.googleapis.com/drive/v3/files",
    "GET https://www.googleapis.com/drive/v3/files", "POST https://www.googleapis.com/drive/v3/files",
    "POST https://www.googleapis.com/upload/drive/v3/files", "PUT https://upload/session/1",
  ]);
});

test("authUrl asks for offline drive.file access for the logistik account", () => {
  const url = new URL(authUrl("STATE", { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "s" }));
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("login_hint"), "logistik.terex@gmail.com");
  assert.equal(url.searchParams.get("state"), "STATE");
});
