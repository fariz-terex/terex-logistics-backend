// Background job: moves claimed ORIGINAL photos from the bucket's staging
// area to Google Drive, then deletes the staged copy; also removes staged
// originals nobody claimed within STALE_DAYS. Runs on an interval from
// server.js; each pass is small and never throws (failures are recorded on
// the row and retried, up to originals.MAX_ATTEMPTS).
const originals = require("./originals");
const { createDriveClient, isConfigured } = require("./googleDrive");

const STALE_DAYS = 3;

function getSetting(db, key) {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function driveFor(db, deps = {}) {
  const refreshToken = getSetting(db, "gdrive_refresh_token");
  if (!refreshToken || !isConfigured(deps.env)) return null;
  const folderCache = {
    get: (path) => db.prepare("SELECT id FROM drive_folders WHERE path = ?").get(path)?.id,
    set: (path, id) => db.prepare("INSERT INTO drive_folders (path, id) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET id = excluded.id").run(path, id),
  };
  return (deps.createDriveClient || createDriveClient)({ refreshToken, folderCache, env: deps.env, fetchImpl: deps.fetchImpl });
}

async function runArchiveOnce(db, store, deps = {}) {
  const result = { archived: 0, failed: 0, cleaned: 0 };
  if (!store) return result;

  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 3600 * 1000).toISOString();
  for (const row of originals.staleStaged(db, cutoff)) {
    if (row.staging_key) await store.deleteObject(row.staging_key).catch(() => {});
    originals.removeRow(db, row.id);
    result.cleaned++;
  }

  const drive = driveFor(db, deps);
  if (!drive) return result;
  for (const row of originals.archiveBatch(db, deps.batchSize || 5)) {
    try {
      const { body, contentType } = await store.getObject(row.staging_key);
      const parentId = await drive.ensureFolder(row.drive_path);
      const ext = (row.staging_key.split(".").pop() || "jpg").toLowerCase();
      const name = row.drive_name && /\.[a-z0-9]+$/i.test(row.drive_name) ? row.drive_name : `${row.drive_name || "foto"}.${ext}`;
      const file = await drive.uploadFile({ name, parentId, mimeType: contentType, body });
      originals.markArchived(db, row.id, { fileId: file.id, link: file.webViewLink });
      await store.deleteObject(row.staging_key).catch(() => {});
      result.archived++;
    } catch (err) {
      originals.markFailed(db, row.id, err.message || String(err));
      result.failed++;
    }
  }
  return result;
}

function startArchiveWorker(db, store, { intervalMs = 60_000, log = console } = {}) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runArchiveOnce(db, store);
      if (r.archived || r.failed || r.cleaned) log.log(`[originals] archived ${r.archived}, failed ${r.failed}, cleaned ${r.cleaned}`);
    } catch (err) {
      log.error(`[originals] worker error: ${err.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { runArchiveOnce, startArchiveWorker, getSetting, STALE_DAYS };
