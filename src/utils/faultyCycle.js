const db = require("../db");
const { adjustStock } = require("./stock");
const { dailySequenceId, isoDate, nextStockMovementId } = require("./ids");

// Core business logic for the Faulty lifecycle, shared between the normal
// (JWT-authenticated, Logistics/Manager) routes in routes/stock.js and the
// API-key-authenticated automation routes in routes/automation.js. Kept
// here instead of duplicated in both route files, and each function throws
// a plain Error with a user-facing message on failure — callers translate
// that into the right HTTP status for their own auth context.

// Marks a unit Faulty directly — no formal Return Faulty request/approval
// workflow, no photos. Mirrors what returns.js's /complete endpoint does
// to stock (adjustStock 'faulty' +1, a stock_movements row, the SN folded
// into the registry as Faulty whether it was already known or not), just
// reached by a much shorter path. Used by the automation sync AND is
// available for any future "fast mark faulty" affordance in the app itself.
function markFaulty({ sn, material, customer, performedBy, note, sourceRef }) {
  if (!sn || !material || !customer) throw new Error("sn, material, and customer are required");
  const mat = db.prepare("SELECT 1 FROM materials WHERE name = ?").get(material);
  if (!mat) throw new Error(`Unknown material: ${material}`);
  const cust = db.prepare("SELECT 1 FROM customers WHERE name = ?").get(customer);
  if (!cust) throw new Error(`Unknown customer/division: ${customer}`);

  const existing = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(sn);
  if (existing && existing.status === "Faulty") {
    throw new Error(`Serial Number ${sn} sudah berstatus Faulty — tidak diproses ulang`);
  }
  if (existing && !["Installed", "Delivered", "Ready"].includes(existing.status)) {
    throw new Error(`Serial Number ${sn} berstatus "${existing.status}" — tidak wajar langsung ditandai Faulty dari status ini`);
  }
  if (existing && existing.material !== material) {
    throw new Error(`Serial Number ${sn} tercatat sebagai material "${existing.material}", bukan "${material}"`);
  }

  const ref = sourceRef || `AUTO-${Date.now()}`;
  const tx = db.transaction(() => {
    if (existing) {
      db.prepare("UPDATE serial_numbers SET status = 'Faulty', current_ref = ?, customer = ? WHERE sn = ?").run(ref, customer, sn);
    } else {
      db.prepare("INSERT INTO serial_numbers (sn, material, status, current_ref, received_date, received_ref, customer) VALUES (?, ?, 'Faulty', ?, ?, NULL, ?)")
        .run(sn, material, ref, isoDate(), customer);
    }
    adjustStock(material, customer, "faulty", 1);
    const movId = nextStockMovementId(db);
    const stock = db.prepare("SELECT ready FROM materials WHERE name = ?").get(material);
    db.prepare(`INSERT INTO stock_movements (id, date, material, qty, ref, remaining, type, customer) VALUES (?, ?, ?, ?, ?, ?, 'Faulty Return', ?)`)
      .run(movId, isoDate(), material, 1, ref, stock.ready, customer);
  });
  tx();
  return { sn, material, customer, status: "Faulty", ref, note: note || "" };
}

function sendToCustomer({ sn, ref, note, performedBy }) {
  if (!ref || !ref.trim()) throw new Error("Nomor surat/BA wajib diisi");
  const row = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(sn);
  if (!row) throw new Error("Serial Number not found");
  if (row.status !== "Faulty") throw new Error(`Unit ini berstatus "${row.status}", harus Faulty untuk dikirim ke customer`);

  const id = dailySequenceId(db, "faulty_customer_returns", "FCR");
  const date = isoDate();
  const tx = db.transaction(() => {
    db.prepare("UPDATE serial_numbers SET status = 'Sent to Customer' WHERE sn = ?").run(row.sn);
    db.prepare(`
      INSERT INTO faulty_customer_returns (id, sn, material, customer, sent_date, sent_ref, sent_by, sent_note, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Sent')
    `).run(id, row.sn, row.material, row.customer, date, ref.trim(), performedBy, note || "");
  });
  tx();
  return { id, sn: row.sn, customer: row.customer, status: "Sent to Customer" };
}

function receiveFromCustomer({ sn, ref, note, performedBy }) {
  if (!ref || !ref.trim()) throw new Error("Nomor surat/BA wajib diisi");
  const row = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(sn);
  if (!row) throw new Error("Serial Number not found");
  if (row.status !== "Sent to Customer") throw new Error(`Unit ini berstatus "${row.status}", harus "Sent to Customer" untuk diterima kembali`);

  const openCycle = db.prepare("SELECT * FROM faulty_customer_returns WHERE sn = ? AND status = 'Sent' ORDER BY sent_date DESC, id DESC LIMIT 1").get(row.sn);
  if (!openCycle) throw new Error("Tidak ditemukan catatan pengiriman ke customer yang masih terbuka untuk unit ini");
  if (ref.trim() === openCycle.sent_ref) throw new Error("Nomor surat penerimaan harus berbeda dari nomor surat pengiriman sebelumnya");

  const date = isoDate();
  const tx = db.transaction(() => {
    db.prepare("UPDATE serial_numbers SET status = 'Ready' WHERE sn = ?").run(row.sn);
    db.prepare(`
      UPDATE faulty_customer_returns
      SET received_date = ?, received_ref = ?, received_by = ?, received_note = ?, status = 'Received'
      WHERE id = ?
    `).run(date, ref.trim(), performedBy, note || "", openCycle.id);
    adjustStock(row.material, row.customer, "faulty", -1);
    adjustStock(row.material, row.customer, "ready", 1);
  });
  tx();
  return { id: openCycle.id, sn: row.sn, customer: row.customer, status: "Ready" };
}

module.exports = { markFaulty, sendToCustomer, receiveFromCustomer };
