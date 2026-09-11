const { notify, activeLogisticsIdsForDivision, userIdsByName } = require("./notify");
const { sendMessage } = require("./telegram");
const { isoDate } = require("./ids");

const APP_URL = "https://terex-logistics.up.railway.app";

const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function daysUntil(dateStr, today) {
  const ms = Date.parse(dateStr) - Date.parse(today);
  return Math.round(ms / 86400000);
}

function buildReminderMessage(delivery, daysLeft) {
  const lines = [
    `⏰ <b>Reminder H-${daysLeft}: cek pergerakan paket</b>`,
    "",
    `Delivery: <b>${esc(delivery.id)}</b>`,
    `Divisi: ${esc(delivery.customer)}`,
    `Tujuan: ${esc(delivery.homebase)}${delivery.site ? ` · ${esc(delivery.site)}` : ""}`,
    `No. Resi: ${esc(delivery.resi_number || "-")}`,
    `Estimasi sampai: <b>${esc(delivery.est_arrival_date)}</b>`,
    "",
    "Tolong cek posisi pengiriman ke kurir/ekspedisi — jangan cuma menunggu sampai sendiri.",
    "",
    APP_URL,
  ];
  return lines.join("\n");
}

// One reminder step: for every Shipped delivery whose est_arrival_date is
// exactly `daysLeft` days away and hasn't had this reminder sent yet,
// notify that division's Logistics Staff (in-app + Telegram DM) and mark
// the reminder sent so a later run of the same day never repeats it.
function sendReminderStep(db, daysLeft, sentColumn) {
  const today = isoDate();
  const candidates = db.prepare(`
    SELECT * FROM deliveries
    WHERE status = 'Shipped' AND est_arrival_date IS NOT NULL AND ${sentColumn} IS NULL
  `).all();

  const due = candidates.filter((d) => daysUntil(d.est_arrival_date, today) === daysLeft);
  const now = new Date().toISOString();
  let sent = 0;

  for (const delivery of due) {
    try {
      const recipientIds = activeLogisticsIdsForDivision(delivery.customer, db);
      if (recipientIds.length > 0) {
        notify(recipientIds, {
          type: "delivery.reminder",
          title: `H-${daysLeft}: cek pergerakan Delivery ${delivery.id}`,
          body: `Estimasi sampai ${delivery.est_arrival_date} · resi ${delivery.resi_number || "-"} · ${delivery.homebase}`,
          refType: "delivery", refId: delivery.id, actor: null,
        }, db);

        const rows = db.prepare(
          `SELECT telegram_chat_id FROM users WHERE telegram_chat_id IS NOT NULL AND id IN (${recipientIds.map(() => "?").join(",")})`
        ).all(...recipientIds);
        if (rows.length) {
          const message = buildReminderMessage(delivery, daysLeft);
          rows.forEach((r) => sendMessage(r.telegram_chat_id, message));
        }
      }
      db.prepare(`UPDATE deliveries SET ${sentColumn} = ? WHERE id = ?`).run(now, delivery.id);
      sent += 1;
    } catch (err) {
      console.error(`[shipmentReminders] H-${daysLeft} failed for ${delivery.id}:`, err.message);
    }
  }

  return { checked: candidates.length, sent };
}

// Entry point for the automation endpoint. Never throws — a failure in one
// step shouldn't block the other, and the caller (external cron) always
// wants a response summarizing what happened.
function sendShipmentReminders(db) {
  const h2 = sendReminderStep(db, 2, "reminder_h2_sent_at");
  const h1 = sendReminderStep(db, 1, "reminder_h1_sent_at");
  return { h2, h1 };
}

module.exports = { sendShipmentReminders };
