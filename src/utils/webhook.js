const { isoDate } = require("./ids");

// Fire-and-forget notification to an external automation (n8n) whenever a
// qualifying action happens THROUGH THE NORMAL WEB APP — deliberately
// called only from JWT-authenticated routes, never from utils/faultyCycle.js
// itself (which is shared with routes/automation.js). If it were wired in
// there instead, an update that just arrived FROM the Sheet via automation
// would immediately fire a webhook back reporting the same change — a
// pointless round trip. This only reports genuine web-app-originated activity.
//
// Configured via N8N_WEBHOOK_URL (unset = feature is off, nothing is sent).
// Never throws: a failed or slow webhook must never break the user-facing
// request that triggered it, so this always resolves quietly.
async function notifyWebhook(event, data) {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return;

  const payload = { event, ...data, timestamp: isoDate() };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    console.error(`[webhook] failed to notify n8n for event "${event}":`, err.message);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { notifyWebhook };
