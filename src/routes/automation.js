const express = require("express");
const db = require("../db");
const { requireAutomationKey } = require("../middleware/automationAuth");
const { dailySequenceId, isoDate } = require("../utils/ids");
const { markFaulty, sendToCustomer, receiveFromCustomer } = require("../utils/faultyCycle");

const router = express.Router();
router.use(requireAutomationKey);

// Every call through this router is logged — success or rejection — before
// responding, so there's always a record even if n8n/Telegram never gets
// the response (network blip, workflow error, etc).
function logAndRespond(res, { action, division, sn, material, payload }, fn) {
  const id = dailySequenceId(db, "automation_log", "AUTO");
  try {
    const result = fn();
    db.prepare(`INSERT INTO automation_log (id, division, action, sn, material, result, detail, raw_payload, created_at) VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`)
      .run(id, division || null, action, sn || null, material || null, JSON.stringify(result), JSON.stringify(payload || {}), isoDate());
    res.status(201).json({ logId: id, ...result });
  } catch (err) {
    db.prepare(`INSERT INTO automation_log (id, division, action, sn, material, result, detail, raw_payload, created_at) VALUES (?, ?, ?, ?, ?, 'rejected', ?, ?, ?)`)
      .run(id, division || null, action, sn || null, material || null, err.message, JSON.stringify(payload || {}), isoDate());
    res.status(409).json({ logId: id, error: err.message });
  }
}

// Sheet says a unit has arrived at Warehouse Terex and is confirmed
// Faulty (e.g. PIM's Position="Warehouse Terex", IPT's PIC="Terex") — no
// formal Return Faulty request/photos, tagged clearly via automation_log
// and the "AUTO-" reference stamped onto the serial_numbers row instead.
router.post("/mark-faulty", (req, res) => {
  const { sn, material, customer, division, note, sourceRef } = req.body || {};
  logAndRespond(res, { action: "mark-faulty", division, sn, material, payload: req.body }, () =>
    markFaulty({ sn, material, customer, note, sourceRef, performedBy: req.user.name })
  );
});

router.post("/send-to-customer", (req, res) => {
  const { sn, ref, note, division } = req.body || {};
  logAndRespond(res, { action: "send-to-customer", division, sn, payload: req.body }, () =>
    sendToCustomer({ sn, ref, note, performedBy: req.user.name })
  );
});

router.post("/receive-from-customer", (req, res) => {
  const { sn, ref, note, division } = req.body || {};
  logAndRespond(res, { action: "receive-from-customer", division, sn, payload: req.body }, () =>
    receiveFromCustomer({ sn, ref, note, performedBy: req.user.name })
  );
});

// Lets n8n (or anyone debugging) pull recent activity — successes and
// rejections alike — instead of relying purely on Telegram delivery.
router.get("/log", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const rows = db.prepare("SELECT * FROM automation_log ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
  res.json(rows);
});

module.exports = router;
