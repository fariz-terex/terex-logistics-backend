const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const toClient = (r) => ({
  id: r.id,
  type: r.type,
  title: r.title,
  body: r.body || "",
  refType: r.ref_type,
  refId: r.ref_id,
  actor: r.actor,
  createdAt: r.created_at,
  read: !!r.read_at,
});

// My notifications, newest first. ?unread=1 for unread only, ?limit=N (max 100),
// ?before=<id> to page backwards.
router.get("/", requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 30, 100);
  const unreadOnly = req.query.unread === "1";
  const before = req.query.before ? Number(req.query.before) : null;

  const clauses = ["user_id = ?"];
  const params = [req.user.id];
  if (unreadOnly) clauses.push("read_at IS NULL");
  if (before) { clauses.push("id < ?"); params.push(before); }

  const rows = db.prepare(
    `SELECT * FROM notifications WHERE ${clauses.join(" AND ")} ORDER BY id DESC LIMIT ?`
  ).all(...params, limit);
  res.json(rows.map(toClient));
});

router.get("/unread-count", requireAuth, (req, res) => {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL").get(req.user.id);
  res.json({ count: n });
});

router.post("/:id/read", requireAuth, (req, res) => {
  const info = db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL")
    .run(new Date().toISOString(), req.params.id, req.user.id);
  res.json({ updated: info.changes });
});

router.post("/read-all", requireAuth, (req, res) => {
  const info = db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL")
    .run(new Date().toISOString(), req.user.id);
  res.json({ updated: info.changes });
});

module.exports = router;
