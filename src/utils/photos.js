// Where photos live. New photos go to the Railway Storage Bucket and the DB
// keeps only a reference ("obj:<key>"); older photos are still data URLs in
// their columns and keep working untouched. Every read path runs a stored
// value through photoUrl() so the browser gets something it can <img src>:
// a short-lived presigned URL for bucket photos, the data URL as-is for old
// ones. With no bucket configured (local dev, tests) photos stay data URLs.
const crypto = require("node:crypto");
const { getObjectStore } = require("./objectStore");

const REF_PREFIX = "obj:";
const MAX_BYTES = 10 * 1024 * 1024;
const URL_TTL_SECONDS = 12 * 60 * 60; // outlives a working day's session; the app refreshes data long before

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Accepts what a form sends for one photo and returns what to store:
//  - a data URL          -> uploaded to the bucket, "obj:<folder>/<yyyy>/<mm>/<uuid>.<ext>"
//  - a URL we presigned  -> mapped back to its "obj:" ref (nothing re-uploaded)
//  - an "obj:" ref        -> kept as-is
// Anything else is rejected.
async function storePhoto(value, folder, store = getObjectStore(), { allowPdf = false } = {}) {
  if (!value) return null;
  if (typeof value !== "string") throw badRequest("Format foto tidak valid");
  if (value.startsWith(REF_PREFIX)) return value;
  if (/^https?:\/\//.test(value)) {
    const key = store && store.keyFromUrl(value);
    if (!key) throw badRequest("Link foto tidak dikenali");
    return REF_PREFIX + key;
  }
  const m = /^data:(image\/(jpeg|png|webp|gif)|application\/(pdf));base64,(.+)$/.exec(value);
  if (!m || (m[3] === "pdf" && !allowPdf)) throw badRequest(allowPdf ? "File harus berupa foto (JPG/PNG) atau PDF" : "Setiap file harus berupa foto (JPG/PNG)");
  if (!store) return value; // no bucket configured — legacy behaviour
  const body = Buffer.from(m[4], "base64");
  if (body.length > MAX_BYTES) throw badRequest("Ukuran foto terlalu besar");
  const now = new Date();
  const ext = m[3] || (m[2] === "jpeg" ? "jpg" : m[2]);
  const key = `${folder}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.${ext}`;
  await store.putObject(key, body, m[1]);
  return REF_PREFIX + key;
}

// Uploads several photos with a little parallelism; returns refs in order.
async function storePhotos(values, folder, store = getObjectStore(), concurrency = 4) {
  const out = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const i = next++;
      out[i] = await storePhoto(values[i], folder, store);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return out;
}

// Best-effort cleanup when the DB write that would have referenced these
// photos fails — never throws.
async function discardPhotos(refs, store = getObjectStore()) {
  if (!store) return;
  await Promise.all((refs || []).filter((r) => typeof r === "string" && r.startsWith(REF_PREFIX))
    .map((r) => store.deleteObject(r.slice(REF_PREFIX.length)).catch(() => {})));
}

function photoUrl(value, store = getObjectStore()) {
  if (!value || typeof value !== "string" || !value.startsWith(REF_PREFIX)) return value || null;
  return store ? store.presignGet(value.slice(REF_PREFIX.length), URL_TTL_SECONDS) : null;
}

// Startup check so a misconfigured bucket shows up in the deploy log
// instead of as a failed upload in the field.
async function selfTest(store = getObjectStore()) {
  if (!store) return "not configured (photos stay in the database)";
  const key = `_selftest/${crypto.randomUUID()}.txt`;
  await store.putObject(key, Buffer.from("ok"), "text/plain");
  const res = await fetch(store.presignGet(key, 60));
  const text = await res.text();
  await store.deleteObject(key);
  if (!res.ok || text !== "ok") throw new Error(`presigned GET returned ${res.status}`);
  return "OK";
}

// Walks a JSON-able response body and turns every stored photo ref
// ("obj:...") into a viewable URL. Mounted as response middleware in
// server.js so NO route can forget it — a ref must never reach the browser.
// Only plain arrays/objects are traversed; everything else is returned as-is.
function presignDeep(value, store = getObjectStore()) {
  if (typeof value === "string") return value.startsWith(REF_PREFIX) ? photoUrl(value, store) : value;
  if (Array.isArray(value)) return value.map((v) => presignDeep(v, store));
  if (value && typeof value === "object" && (value.constructor === Object || Object.getPrototypeOf(value) === null)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = presignDeep(value[k], store);
    return out;
  }
  return value;
}

module.exports = { storePhoto, storePhotos, discardPhotos, photoUrl, presignDeep, selfTest, REF_PREFIX };
