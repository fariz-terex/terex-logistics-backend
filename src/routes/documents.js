// Read-only access to BMB / BKB / Surat Jalan. Documents are created by the
// flows that move goods (see utils/documents.js), never through this route.
const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { scopeOf, scopeAllows } = require("../utils/stock");
const { TYPES, KIND_LABELS, loadDocument } = require("../utils/documents");
const { photoUrl } = require("../utils/photos");

const router = express.Router();

// GET /api/documents?type=BMB[&customer=MSG][&month=2026-09][&kind=...][&q=...]
router.get("/", requireAuth, (req, res) => {
  const { type, customer, month, kind, q } = req.query;
  if (!TYPES.includes(type)) return res.status(400).json({ error: "type harus BMB, BKB, atau SJ" });
  const where = ["d.type = ?"];
  const params = [type];
  const scope = scopeOf(req.user);
  if (scope) {
    if (scope.length === 0) return res.json([]);
    where.push(`d.customer IN (${scope.map(() => "?").join(",")})`);
    params.push(...scope);
  }
  if (customer) { where.push("d.customer = ?"); params.push(customer); }
  if (month) { where.push("substr(d.date, 1, 7) = ?"); params.push(month); }
  if (kind) { where.push("d.kind = ?"); params.push(kind); }
  if (q) {
    // number, references, parties, or any item/SN on the document
    where.push(`(d.number LIKE ? OR d.source_ref LIKE ? OR d.external_ref LIKE ? OR d.party_from LIKE ? OR d.party_to LIKE ?
      OR EXISTS (SELECT 1 FROM document_items i WHERE i.document_id = d.id AND (i.material LIKE ? OR i.serials LIKE ?)))`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like, like);
  }
  const rows = db.prepare(`
    SELECT d.id, d.number, d.type, d.kind, d.customer, d.date, d.source_type, d.source_ref, d.party_from, d.party_to,
           d.external_ref, d.shipping_ref, d.created_by,
           (SELECT number FROM documents r WHERE r.id = d.related_id) AS related_number,
           (SELECT COUNT(*) FROM document_items i WHERE i.document_id = d.id) AS item_count,
           (SELECT COALESCE(SUM(qty), 0) FROM document_items i WHERE i.document_id = d.id) AS total_qty
    FROM documents d
    WHERE ${where.join(" AND ")}
    ORDER BY d.date DESC, d.id DESC
    LIMIT 1000
  `).all(...params);
  res.json(rows.map((r) => ({ ...r, kindLabel: KIND_LABELS[r.kind] || r.kind })));
});

router.get("/:id", requireAuth, (req, res) => {
  const doc = loadDocument(db, Number(req.params.id));
  if (!doc) return res.status(404).json({ error: "Dokumen tidak ditemukan" });
  if (!scopeAllows(scopeOf(req.user), doc.customer)) return res.status(403).json({ error: "Dokumen ini bukan milik divisi Anda" });
  res.json({ ...doc, external_file: photoUrl(doc.external_file) });
});

module.exports = router;
