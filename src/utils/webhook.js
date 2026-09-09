const { isoDate } = require("./ids");

// Fire-and-forget notification to an external automation (n8n). Deliberately
// called only from JWT-authenticated routes, never from utils/faultyCycle.js
// itself (which is shared with routes/automation.js) — an update that just
// arrived FROM the Sheet via automation shouldn't fire a webhook back
// reporting the same change.
//
// Target URL: opts.url if given, else N8N_WEBHOOK_URL. Unset = feature off,
// nothing is sent. Never throws: a failed or slow webhook must never break
// the user-facing request that triggered it.
async function notifyWebhook(event, data, opts = {}) {
  const url = opts.url || process.env.N8N_WEBHOOK_URL;
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
    console.error(`[webhook] failed to notify for event "${event}":`, err.message);
  } finally {
    clearTimeout(timeout);
  }
}

// Dedicated channel for delivery status changes — its own n8n workflow, so
// its own URL (N8N_DELIVERY_WEBHOOK_URL). Does NOT fall back to
// N8N_WEBHOOK_URL: that one belongs to the Sheet-sync workflows.
function notifyDeliveryWebhook(data) {
  return notifyWebhook("delivery.status_changed", data, { url: process.env.N8N_DELIVERY_WEBHOOK_URL });
}

module.exports = { notifyWebhook, notifyDeliveryWebhook };
