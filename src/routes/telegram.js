const express = require("express");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const { isConfigured, botUsername, newLinkCode, consumeLinkCode, sendMessage } = require("../utils/telegram");

const router = express.Router();

// --- user-facing (JWT) -----------------------------------------------

router.get("/status", requireAuth, (req, res) => {
  const u = db.prepare("SELECT telegram_chat_id FROM users WHERE id = ?").get(req.user.id);
  res.json({ configured: isConfigured(), linked: !!(u && u.telegram_chat_id), botUsername: botUsername() || null });
});

router.post("/link-code", requireAuth, (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "Integrasi Telegram belum dikonfigurasi di server" });
  const code = newLinkCode(req.user.id);
  res.json({ code, url: `https://t.me/${botUsername()}?start=${code}` });
});

router.post("/unlink", requireAuth, (req, res) => {
  db.prepare("UPDATE users SET telegram_chat_id = NULL WHERE id = ?").run(req.user.id);
  res.json({ ok: true });
});

// --- Telegram webhook ------------------------------------------------
// Registered once via setWebhook with url .../webhook/<SECRET> and
// secret_token=<SECRET>. Both the path segment and the header are checked.
router.post("/webhook/:secret", (req, res) => {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || req.params.secret !== secret) return res.sendStatus(403);
  const headerToken = req.get("X-Telegram-Bot-Api-Secret-Token");
  if (headerToken && headerToken !== secret) return res.sendStatus(403);

  res.sendStatus(200); // acknowledge immediately, then process

  try {
    const msg = req.body && req.body.message;
    const chatId = msg && msg.chat && msg.chat.id;
    const text = (msg && msg.text) || "";
    if (!chatId) return;

    const m = text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]+)/);
    if (m) {
      const userId = consumeLinkCode(m[1]);
      if (userId) {
        db.prepare("UPDATE users SET telegram_chat_id = ? WHERE id = ?").run(String(chatId), userId);
        const user = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
        sendMessage(chatId, `✅ Terhubung, <b>${user ? user.name : ""}</b>. Notifikasi LMS Terex akan dikirim ke chat ini.`);
      } else {
        sendMessage(chatId, "⚠️ Kode tidak valid atau sudah kadaluarsa. Buka LMS Terex → Settings → \"Hubungkan Telegram\" lalu coba lagi.");
      }
    } else if (/^\/start\b/.test(text)) {
      sendMessage(chatId, "Halo! Untuk menerima notifikasi LMS Terex, buka aplikasi LMS Terex → Settings → \"Hubungkan Telegram\", lalu ikuti tautannya.");
    } else if (/^\/stop\b/.test(text)) {
      db.prepare("UPDATE users SET telegram_chat_id = NULL WHERE telegram_chat_id = ?").run(String(chatId));
      sendMessage(chatId, "🔕 Notifikasi dihentikan. Hubungkan lagi kapan saja dari Settings di LMS Terex.");
    }
  } catch (err) {
    console.error("[telegram] webhook processing failed:", err.message);
  }
});

module.exports = router;
