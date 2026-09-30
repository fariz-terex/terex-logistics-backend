// Official Terex warehouse documents, generated automatically from the flows
// that move goods — nobody fills them in by hand:
//
//   BMB  Bukti Masuk Barang   customer_receipt  Goods Receipt (refs the customer's BKB)
//                             faulty_return     Return Faulty received by the warehouse
//   BKB  Bukti Keluar Barang  delivery          Delivery Request shipped to a technician
//                             return_to_customer Faulty units sent back to the customer
//   SJ   Surat Jalan          (same two kinds as BKB — travels with the goods, paired with its BKB)
//
// A document is a SNAPSHOT (items, serials, parties) taken when the goods
// actually moved, so it keeps saying what was handed over even if the source
// record changes later. Numbering is per division per month, MAX+1 (rule 2
// in CLAUDE.md): TRX/BMB/MSG/2026/09/0001.
//
// These functions never open a transaction themselves — callers run them
// inside the transaction that moves the stock, so a document exists exactly
// when the movement does. `db` is injected (node:sqlite in tests).
const { isoDate } = require("./ids");

const TYPES = ["BMB", "BKB", "SJ"];
const KINDS = {
  BMB: ["customer_receipt", "faulty_return"],
  BKB: ["delivery", "return_to_customer"],
  SJ: ["delivery", "return_to_customer"],
};
const KIND_LABELS = {
  customer_receipt: "Penerimaan dari Customer",
  faulty_return: "Pengembalian Faulty dari Lapangan",
  delivery: "Pengiriman ke Teknisi",
  return_to_customer: "Pengembalian ke Customer",
};
const WAREHOUSE = "Warehouse Terex";

// "Teleglobal" -> "TELEGLOBAL"; anything non-alphanumeric dropped so the
// number stays one clean path segment.
const divisionCode = (customer) => String(customer || "UNASSIGNED").toUpperCase().replace(/[^A-Z0-9]/g, "") || "UNASSIGNED";

function nextDocNumber(db, type, customer, date = isoDate()) {
  const [y, m] = date.split("-");
  const prefix = `TRX/${type}/${divisionCode(customer)}/${y}/${m}/`;
  const rows = db.prepare("SELECT number FROM documents WHERE number LIKE ?").all(prefix + "%");
  let max = 0;
  for (const r of rows) {
    const n = parseInt(r.number.slice(prefix.length), 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(4, "0");
}

// Unit of measure for the printed item table — whichever catalog the item
// lives in (materials / tools / consumables); blank if none says.
function unitOf(db, name, itemType) {
  const table = itemType === "tool" ? "tools" : itemType === "consumable" ? "consumables" : "materials";
  try {
    const row = db.prepare(`SELECT unit FROM ${table} WHERE name = ?`).get(name);
    return (row && row.unit) || "";
  } catch {
    return "";
  }
}

function createDocument(db, doc) {
  const { type, kind, customer, items } = doc;
  if (!TYPES.includes(type)) throw new Error(`Jenis dokumen tidak dikenal: ${type}`);
  if (!KINDS[type].includes(kind)) throw new Error(`Jenis ${type} tidak dikenal: ${kind}`);
  if (!customer) throw new Error("Divisi dokumen wajib ada");
  if (!Array.isArray(items) || items.length === 0) throw new Error("Dokumen harus berisi minimal satu barang");
  const date = doc.date || isoDate();
  const number = nextDocNumber(db, type, customer, date);
  const id = db.prepare(`
    INSERT INTO documents (number, type, kind, customer, date, source_type, source_ref, party_from, party_to,
      external_ref, external_file, shipping_ref, related_id, note, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(number, type, kind, customer, date, doc.sourceType, doc.sourceRef || null, doc.partyFrom || "", doc.partyTo || "",
    doc.externalRef || null, doc.externalFile || null, doc.shippingRef || null, doc.relatedId || null, doc.note || "",
    doc.createdBy || null, new Date().toISOString()).lastInsertRowid;
  addItems(db, Number(id), items);
  return { id: Number(id), number };
}

function addItems(db, documentId, items) {
  const insert = db.prepare("INSERT INTO document_items (document_id, material, item_type, qty, unit, serials) VALUES (?, ?, ?, ?, ?, ?)");
  for (const it of items) {
    const serials = (it.serials || []).filter(Boolean);
    const qty = Number(it.qty) || serials.length;
    if (!it.material || qty <= 0) continue;
    const itemType = it.itemType || "material";
    insert.run(documentId, it.material, itemType, qty, it.unit ?? unitOf(db, it.material, itemType), JSON.stringify(serials));
  }
}

// BKB + its Surat Jalan in one go (they always travel together), linked
// both ways through related_id.
function createShipmentDocuments(db, doc) {
  const bkb = createDocument(db, { ...doc, type: "BKB" });
  const sj = createDocument(db, { ...doc, type: "SJ", relatedId: bkb.id });
  db.prepare("UPDATE documents SET related_id = ? WHERE id = ?").run(sj.id, bkb.id);
  return { bkb, sj };
}

// Groups SN rows ({sn, material}) into document items: one line per
// material, qty = number of units.
function itemsFromSerials(rows) {
  const byMaterial = new Map();
  for (const r of rows) {
    if (!byMaterial.has(r.material)) byMaterial.set(r.material, []);
    byMaterial.get(r.material).push(r.sn);
  }
  return [...byMaterial.entries()].map(([material, serials]) => ({ material, qty: serials.length, serials }));
}

function loadDocument(db, id) {
  const d = db.prepare("SELECT * FROM documents WHERE id = ?").get(id);
  if (!d) return null;
  const items = db.prepare("SELECT material, item_type, qty, unit, serials FROM document_items WHERE document_id = ? ORDER BY id").all(id)
    .map((it) => ({ material: it.material, itemType: it.item_type, qty: it.qty, unit: it.unit, serials: JSON.parse(it.serials || "[]") }));
  const related = d.related_id ? db.prepare("SELECT id, number, type FROM documents WHERE id = ?").get(d.related_id) : null;
  return { ...d, kindLabel: KIND_LABELS[d.kind] || d.kind, items, related: related || null };
}

module.exports = {
  TYPES, KINDS, KIND_LABELS, WAREHOUSE,
  divisionCode, nextDocNumber, createDocument, addItems, createShipmentDocuments, itemsFromSerials, loadDocument,
};
