// One place for "a route is saving some photos": upload each to the bucket
// (photos.storePhoto), and — once the DB write succeeded — register their
// originals for the Google Drive archive under a folder for that record.
//
//   const p = await intake(db, [{ value, name }, ...], { folder: "returns" });
//   ...write p.refs[i] to the DB (inside the route's transaction)...
//   on failure: await p.discard();      on success: p.commit("LMS Terex/Return Faulty/RF-1");
//
// `value` is whatever the form sent: a fresh data URL (uploaded), a URL we
// presigned earlier (mapped back to its ref, nothing re-uploaded), an "obj:"
// ref, or empty (-> null). `name` is the Drive file name (no extension).
const { storePhoto, discardPhotos } = require("./photos");
const originals = require("./originals");

// Express 4 doesn't catch a rejected async handler — without this an error
// after the first `await` would be an unhandled rejection instead of going
// to server.js's central error handler.
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const safeName = (s) => String(s || "").replace(/[\\/:*?"<>|]+/g, "-").trim();
const isFresh = (value) => typeof value === "string" && value.startsWith("data:");

async function intake(db, entries, { folder, allowPdf = false, store, concurrency = 4 } = {}) {
  const refs = new Array(entries.length).fill(null);
  let next = 0;
  let failure = null;
  async function worker() {
    while (next < entries.length && !failure) {
      const i = next++;
      try {
        refs[i] = entries[i].value ? await storePhoto(entries[i].value, folder, store, { allowPdf }) : null;
      } catch (err) {
        failure = err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) || 1 }, worker));
  // Only what THIS call uploaded is ours to delete again.
  const freshRefs = () => refs.filter((r, i) => r && isFresh(entries[i].value));
  if (failure) {
    await discardPhotos(freshRefs(), store);
    throw failure;
  }
  return {
    refs,
    discard: () => discardPhotos(freshRefs(), store),
    // Never throws: the record is already saved; a missed claim only means
    // that original isn't archived.
    commit(drivePath) {
      try {
        originals.claimOriginals(db, entries.map((e, i) => ({ value: e.value, ref: refs[i], path: drivePath, name: safeName(e.name) })));
      } catch (err) {
        console.error(`[originals] claim ${drivePath}: ${err.message}`);
      }
    },
    // After replacing a record's photos: delete the old ones it no longer uses.
    dropReplaced: (oldRefs) => {
      const kept = new Set(refs);
      return discardPhotos((oldRefs || []).filter((r) => r && !kept.has(r)), store);
    },
  };
}

module.exports = { intake, asyncRoute, safeName };
