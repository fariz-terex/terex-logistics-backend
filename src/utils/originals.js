// Bookkeeping that ties an ORIGINAL photo (staged by the browser right after
// the user picks it) to the compressed copy a form later submits, and then
// to where it belongs in Google Drive. The two uploads meet on the SHA-256
// of the compressed image bytes (the browser hashes what it compressed; the
// server hashes what it receives), and may arrive in either order.
// db is injected (node:sqlite in tests). See schema.sql photo_originals.
const crypto = require("node:crypto");

const now = () => new Date().toISOString();

// SHA-256 (hex) of a data URL's decoded bytes — must match the browser's
// crypto.subtle digest of the same bytes. null for anything else.
function hashDataUrl(value) {
  const m = /^data:[^;]+;base64,(.+)$/.exec(value || "");
  return m ? crypto.createHash("sha256").update(Buffer.from(m[1], "base64")).digest("hex") : null;
}

function upsert(db, hash, fields) {
  const existing = db.prepare("SELECT * FROM photo_originals WHERE compressed_hash = ?").get(hash);
  if (!existing) {
    db.prepare(`INSERT INTO photo_originals (compressed_hash, staging_key, compressed_ref, drive_path, drive_name, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(hash, fields.staging_key ?? null, fields.compressed_ref ?? null, fields.drive_path ?? null, fields.drive_name ?? null, fields.status || "staged", now(), now());
    return;
  }
  // Never demote an already archived row, and keep the first staged original.
  const next = { ...fields };
  if (existing.staging_key && next.staging_key) delete next.staging_key;
  if (existing.status === "archived") delete next.status;
  const keys = Object.keys(next);
  if (keys.length === 0) return;
  db.prepare(`UPDATE photo_originals SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
    .run(...keys.map((k) => next[k]), now(), existing.id);
}

// Browser staged an original. Returns false when an original for this
// compressed copy is already staged (the caller then drops the duplicate).
function stageOriginal(db, { hash, stagingKey }) {
  const existing = db.prepare("SELECT staging_key FROM photo_originals WHERE compressed_hash = ?").get(hash);
  if (existing && existing.staging_key) return false;
  upsert(db, hash, { staging_key: stagingKey });
  return true;
}

// A route stored photos and knows where they belong: [{ value, ref, path, name }]
// (value = the submitted data URL, ref = its stored "obj:" ref). Values that
// weren't freshly uploaded (e.g. a URL echoed back on resubmit) are skipped —
// their original was claimed the first time.
function claimOriginals(db, entries) {
  for (const e of entries) {
    const hash = hashDataUrl(e.value);
    if (!hash || !e.ref) continue;
    upsert(db, hash, { compressed_ref: e.ref, drive_path: e.path, drive_name: e.name, status: "claimed" });
  }
}

const MAX_ATTEMPTS = 5;

// Ready to go to Drive: claimed, original staged, not given up on.
function archiveBatch(db, limit = 5) {
  return db.prepare(`SELECT * FROM photo_originals
    WHERE status = 'claimed' AND staging_key IS NOT NULL AND drive_path IS NOT NULL AND attempts < ?
    ORDER BY id LIMIT ?`).all(MAX_ATTEMPTS, limit);
}

function markArchived(db, id, { fileId, link }) {
  db.prepare("UPDATE photo_originals SET status = 'archived', drive_file_id = ?, drive_link = ?, staging_key = NULL, error = NULL, updated_at = ? WHERE id = ?")
    .run(fileId, link, now(), id);
}

function markFailed(db, id, message) {
  db.prepare(`UPDATE photo_originals SET attempts = attempts + 1, error = ?,
    status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END, updated_at = ? WHERE id = ?`)
    .run(String(message).slice(0, 500), MAX_ATTEMPTS, now(), id);
}

// Originals nobody claimed (form abandoned, detection-only photo) after
// `olderThanIso` — the caller deletes their staged file, then the row.
function staleStaged(db, olderThanIso) {
  return db.prepare("SELECT id, staging_key FROM photo_originals WHERE status = 'staged' AND created_at < ?").all(olderThanIso);
}
const removeRow = (db, id) => db.prepare("DELETE FROM photo_originals WHERE id = ?").run(id);

// Drive link of the original behind a stored compressed ref (null if none yet).
function originalLink(db, ref) {
  if (!ref) return null;
  const row = db.prepare("SELECT drive_link FROM photo_originals WHERE compressed_ref = ? AND status = 'archived'").get(ref);
  return row ? row.drive_link : null;
}

function counts(db) {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM photo_originals GROUP BY status").all();
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

module.exports = { hashDataUrl, stageOriginal, claimOriginals, archiveBatch, markArchived, markFailed, staleStaged, removeRow, originalLink, counts, MAX_ATTEMPTS };
