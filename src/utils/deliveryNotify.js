const { notify, activeManagerIds, activeLogisticsIdsForDivision, userIdsByName } = require("./notify");
const { notifyDeliveryWebhook } = require("./webhook");
const { sendMessage } = require("./telegram");

const APP_URL = "https://terex-logistics.up.railway.app";

// One config per delivery lifecycle event. `status` is the short label used
// in the Telegram / n8n message; `emoji` prefixes it. `requester` and
// `extras` describe the in-app notifications (extras also receive the
// Telegram DM). Functions get (delivery, { note }).
const EVENTS = {
  created: {
    status: "Menunggu Approval", emoji: "⏳",
    requester: null, // the requester is the actor here
    extras: [{
      resolve: (d, db) => activeManagerIds(db),
      title: (d) => `Delivery Request ${d.id} menunggu approval`,
      body: (d) => `${d.homebase}${d.site ? ` · ${d.site}` : ""} · ${d.itemCount ?? "?"} item · divisi ${d.customer}`,
    }],
  },
  approved: {
    status: "Disetujui", emoji: "✅",
    requester: { title: (d) => `Delivery Request ${d.id} disetujui`, body: () => "Menunggu penugasan stock oleh Logistics Staff." },
    extras: [{
      resolve: (d, db) => activeLogisticsIdsForDivision(d.customer, db),
      title: (d) => `Delivery Request ${d.id} perlu penugasan stock`,
      body: (d) => `${d.homebase} · ${d.requester}`,
    }],
  },
  preparing: {
    status: "Sedang Disiapkan", emoji: "📦",
    requester: { title: (d) => `Delivery Request ${d.id} sedang disiapkan`, body: () => "Stock sudah direservasi, menunggu dokumentasi & pengiriman." },
  },
  shipped: {
    status: "Dalam Pengiriman", emoji: "🚚",
    requester: { title: (d) => `Delivery Request ${d.id} dalam pengiriman`, body: (d) => `Tujuan: ${d.homebase}${d.site ? ` · ${d.site}` : ""}` },
  },
  delivered: {
    status: "Sampai (Delivered)", emoji: "🎉",
    requester: { title: (d) => `Delivery Request ${d.id} sudah sampai (Delivered)`, body: (d, { note }) => `${d.homebase}${note ? ` · ${note}` : ""}` },
  },
  rejected: {
    status: "Ditolak", emoji: "❌",
    requester: { title: (d) => `Delivery Request ${d.id} ditolak`, body: (d, { note }) => note || "" },
  },
  cancelled: {
    status: "Dibatalkan", emoji: "⛔",
    requester: { title: (d) => `Delivery Request ${d.id} dibatalkan`, body: (d, { note }) => note || "" },
    extras: [{
      when: (d, { releasedStock }) => releasedStock,
      resolve: (d, db) => activeLogisticsIdsForDivision(d.customer, db),
      title: (d) => `Delivery Request ${d.id} dibatalkan`,
      body: (d, { note }) => `Stock yang direservasi sudah dikembalikan.${note ? ` Alasan: ${note}` : ""}`,
    }],
  },
};

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function buildMessage(delivery, cfg, { actor, note }) {
  const lines = [
    `${cfg.emoji} <b>Delivery ${esc(delivery.id)}</b> — ${esc(cfg.status)}`,
    "",
    `Divisi: <b>${esc(delivery.customer)}</b>`,
    `Tujuan: ${esc(delivery.homebase)}${delivery.site ? ` · ${esc(delivery.site)}` : ""}`,
  ];
  if (delivery.keperluan) lines.push(`Keperluan: ${esc(delivery.keperluan)}`);
  if (delivery.itemCount) lines.push(`Item: ${esc(delivery.itemCount)}`);
  lines.push(`Diminta oleh: ${esc(delivery.requester)}`);
  if (actor && actor !== delivery.requester) lines.push(`Diproses oleh: ${esc(actor)}`);
  if (note) lines.push(`Catatan: ${esc(note)}`);
  lines.push("", APP_URL);
  return lines.join("\n");
}

// Single entry point for every delivery status change. Sends:
//   1. in-app notifications (requester + role-based extras)
//   2. Telegram DM to each of those recipients who has linked their account
//   3. one structured event to the n8n delivery webhook (if configured)
// Never throws — a notification failure must not break the request.
function announceDelivery(delivery, { event, actor = null, note = null, releasedStock = false } = {}, db) {
  const cfg = EVENTS[event];
  if (!cfg) { console.error(`[deliveryNotify] unknown event "${event}"`); return; }
  db = db || require("../db");

  const d = {
    id: delivery.id,
    customer: delivery.customer,
    homebase: delivery.homebase,
    site: delivery.site || null,
    keperluan: delivery.keperluan || null,
    requester: delivery.requester,
    itemCount: delivery.itemCount ?? (Array.isArray(delivery.items) ? delivery.items.length : null),
  };
  const ctx = { note, releasedStock };
  const recipientIds = new Set();

  try {
    if (cfg.requester) {
      const ids = userIdsByName(d.requester, db);
      ids.forEach((id) => recipientIds.add(id));
      notify(ids, { type: "delivery.status", title: cfg.requester.title(d, ctx), body: cfg.requester.body(d, ctx), refType: "delivery", refId: d.id, actor }, db);
    }
    for (const extra of cfg.extras || []) {
      if (extra.when && !extra.when(d, ctx)) continue;
      const ids = extra.resolve(d, db);
      ids.forEach((id) => recipientIds.add(id));
      notify(ids, { type: "delivery.status", title: extra.title(d, ctx), body: extra.body(d, ctx), refType: "delivery", refId: d.id, actor }, db);
    }
  } catch (err) {
    console.error(`[deliveryNotify] in-app failed for "${event}":`, err.message);
  }

  // Telegram DM — same broadcast message to every recipient with a linked
  // chat id, minus the actor.
  try {
    const actorIds = new Set(actor ? userIdsByName(actor, db) : []);
    const ids = [...recipientIds].filter((id) => !actorIds.has(id));
    if (ids.length) {
      const rows = db.prepare(
        `SELECT telegram_chat_id FROM users WHERE telegram_chat_id IS NOT NULL AND id IN (${ids.map(() => "?").join(",")})`
      ).all(...ids);
      if (rows.length) {
        const message = buildMessage(d, cfg, { actor, note });
        rows.forEach((r) => sendMessage(r.telegram_chat_id, message));
      }
    }
  } catch (err) {
    console.error(`[deliveryNotify] telegram failed for "${event}":`, err.message);
  }

  // n8n webhook (optional group feed)
  notifyDeliveryWebhook({
    deliveryId: d.id, status: cfg.status, customer: d.customer, homebase: d.homebase,
    site: d.site, keperluan: d.keperluan, itemCount: d.itemCount, requester: d.requester, actor, note,
  });
}

module.exports = { announceDelivery, buildMessage, EVENTS };
