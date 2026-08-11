-- TEREX Logistics — relational schema (SQLite dialect).
-- Mirrors the data model used by the front-end prototype, now as real tables
-- with foreign keys instead of in-memory React state.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('Admin / Manager Logistics','Logistics Staff','SPV','Technician')),
  assignment    TEXT DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive'))
);

CREATE TABLE IF NOT EXISTS areas (
  code   TEXT PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS homebases (
  code    TEXT PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  area    TEXT NOT NULL REFERENCES areas(name),
  address TEXT DEFAULT '',
  pic     TEXT DEFAULT '',
  phone   TEXT DEFAULT '',
  status  TEXT NOT NULL DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS customers (
  id     TEXT PRIMARY KEY,
  name   TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS sites (
  code        TEXT PRIMARY KEY,
  terminal_id TEXT,
  name        TEXT NOT NULL,
  customer    TEXT,
  area        TEXT,
  homebase    TEXT NOT NULL REFERENCES homebases(name),
  status      TEXT NOT NULL DEFAULT 'Active'
);

CREATE TABLE IF NOT EXISTS materials (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  category   TEXT DEFAULT '',
  unit       TEXT DEFAULT 'Unit',
  serialized INTEGER NOT NULL DEFAULT 1,   -- 0/1 boolean
  min_stock  INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'Active',
  ready      INTEGER NOT NULL DEFAULT 0,
  faulty     INTEGER NOT NULL DEFAULT 0,
  reserved   INTEGER NOT NULL DEFAULT 0,
  in_transit INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id        TEXT PRIMARY KEY,
  date      TEXT NOT NULL,
  material  TEXT NOT NULL REFERENCES materials(name),
  qty       INTEGER NOT NULL,              -- signed: negative = stock leaving ready
  ref       TEXT,
  remaining INTEGER NOT NULL,
  type      TEXT NOT NULL                  -- Delivery | Receipt | Faulty Return | Reconciliation Adjustment
);

-- ===================== DELIVERY REQUEST =====================

CREATE TABLE IF NOT EXISTS deliveries (
  id                TEXT PRIMARY KEY,
  requester         TEXT NOT NULL,
  homebase          TEXT NOT NULL,
  site              TEXT DEFAULT '',
  keperluan         TEXT NOT NULL,
  note              TEXT DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'Waiting Logistics Approval',
  date              TEXT NOT NULL,
  doc_overall       TEXT,   -- photo of all materials together, taken before shipping
  doc_after_packing TEXT,   -- photo of the materials once packed
  resi_number       TEXT    -- shipping receipt number — optional, often added after shipping
);

CREATE TABLE IF NOT EXISTS delivery_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  material    TEXT NOT NULL,
  qty         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS delivery_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  time        TEXT NOT NULL,
  text        TEXT NOT NULL
);

-- Shipment documentation captured right before a Delivery Request moves to
-- "Shipped": one photo per Serial Number being sent, plus overall/packing
-- photos. Resi (shipping receipt) is deliberately separate and nullable —
-- it's often issued by the courier after the fact, so it's added later via
-- its own endpoint rather than being required at ship time.
CREATE TABLE IF NOT EXISTS delivery_serial_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  sn          TEXT NOT NULL,
  photo       TEXT NOT NULL
);

-- ===================== RETURN MATERIAL FAULTY =====================

CREATE TABLE IF NOT EXISTS returns (
  id             TEXT PRIMARY KEY,
  technician     TEXT NOT NULL,
  homebase       TEXT NOT NULL,
  site           TEXT DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'Waiting Logistics Review',
  date           TEXT NOT NULL,
  resi_number    TEXT DEFAULT '',
  revision_note  TEXT,
  doc_before     TEXT,   -- photo (base64) or NULL — see README on object storage
  doc_after      TEXT,
  doc_weighing   TEXT
);

CREATE TABLE IF NOT EXISTS return_items (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id TEXT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  material  TEXT NOT NULL,
  qty       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS return_serials (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  return_item_id  INTEGER NOT NULL REFERENCES return_items(id) ON DELETE CASCADE,
  sn              TEXT NOT NULL,
  photo           TEXT   -- base64 or NULL
);

CREATE TABLE IF NOT EXISTS return_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id TEXT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  time      TEXT NOT NULL,
  text      TEXT NOT NULL
);

-- ===================== RECONCILIATION =====================

CREATE TABLE IF NOT EXISTS reconciliations (
  id            TEXT PRIMARY KEY,
  homebase      TEXT NOT NULL,
  period        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Waiting Logistics Review',
  date          TEXT NOT NULL,
  revision_note TEXT
);

CREATE TABLE IF NOT EXISTS reconciliation_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
  material          TEXT NOT NULL,
  serialized        INTEGER NOT NULL DEFAULT 0,
  system_qty        INTEGER NOT NULL,
  actual_qty        INTEGER NOT NULL,
  photo             TEXT,
  reason            TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS reconciliation_serials (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_item_id INTEGER NOT NULL REFERENCES reconciliation_items(id) ON DELETE CASCADE,
  sn                     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reconciliation_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciliation_id TEXT NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
  time              TEXT NOT NULL,
  text              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_return_serials_sn ON return_serials(sn);
CREATE INDEX IF NOT EXISTS idx_recon_serials_sn ON reconciliation_serials(sn);
CREATE INDEX IF NOT EXISTS idx_stock_movements_material ON stock_movements(material);

-- ===================== SERIAL NUMBER REGISTRY =====================
-- Every individual unit of a serialized material that has ever entered the
-- warehouse (via a Goods Receipt) or come back from the field (via a
-- completed Return Faulty) gets a row here. Non-serialized materials never
-- touch this table — they stay purely quantity-based, as before.

CREATE TABLE IF NOT EXISTS serial_numbers (
  sn             TEXT PRIMARY KEY,
  material       TEXT NOT NULL REFERENCES materials(name),
  status         TEXT NOT NULL DEFAULT 'Ready' CHECK (status IN ('Ready','Reserved','In Transit','Delivered','Faulty')),
  current_ref    TEXT,     -- id of the delivery/return currently holding this unit (nullable when sitting in Ready stock)
  received_date  TEXT,
  received_ref   TEXT      -- Goods Receipt id this unit arrived on (nullable for units first seen via a Return Faulty)
);
CREATE INDEX IF NOT EXISTS idx_serials_material_status ON serial_numbers(material, status);

CREATE TABLE IF NOT EXISTS receipts (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  material   TEXT NOT NULL,
  qty        INTEGER NOT NULL,
  note       TEXT DEFAULT '',
  created_by TEXT
);

