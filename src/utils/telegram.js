const crypto = require("crypto");

const botToken = () => process.env.TELEGRAM_BOT_TOKEN;
const botUsername = () => process.env.TELEGRAM_BOT_USERNAME;
const isConfigured = () => !!(botToken() && botUsername());

// --- account-link codes (in-memory, short-lived) ----------------------
// A user requests a code in the app, then opens t.me/<bot>?start=<code>.
// Telegram sends "/start <code>" to our webhook, which resolves the code
// back to the user id and stores their chat id. Codes are one-shot and
// expire in 15 min; a server restart just means the user clicks again.
const LINK_TTL_MS = 15 * 60 * 1000;
const linkCodes = new Map(); // code -> { userId, expires }

function newLinkCode(userId) {
  for (const [c, v] of linkCodes) if (v.userId === userId) linkCodes.delete(c);
  const code = crypto.randomBytes(9).toString("base64url"); // 12 url-safe chars, well under Telegram's 64
  linkCodes.set(code, { userId, expires: Date.now() + LINK_TTL_MS });
  return code;
}

function consumeLinkCode(code) {
  const v = linkCodes.get(code);
  if (!v) return null;
  linkCodes.delete(code);
  return v.expires < Date.now() ? null : v.userId;
}

setInterval(() => {
  const now = Date.now();
  for (const [c, v] of linkCodes) if (v.expires < now) linkCodes.delete(c);
}, 5 * 60 * 1000).unref();

// --- sending ---------------------------------------------------------
// Fire-and-forget HTML message to one chat. No-op without a bot token.
// Never throws.
async function sendMessage(chatId, text) {
  const token = botToken();
  if (!token || !chatId || !text) return;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[telegram] sendMessage ${res.status} for chat ${chatId}: ${detail.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`[telegram] sendMessage failed for chat ${chatId}:`, err.message);
  } finally {
    clearTimeout(t);
  }
}

module.exports = { isConfigured, botUsername, newLinkCode, consumeLinkCode, sendMessage };
