-- TEREX Logistics — relational schema (SQLite dialect).
-- Mirrors the data model used by the front-end prototype, now as real tables
-- with foreign keys instead of in-memory React state.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('Admin / Manager Logistics','Logistics Staff','SPV','Technician','Manager Divisi')),
  assignment    TEXT DEFAULT '',
  customer      TEXT,   -- LEGACY single-division field, no longer read by the app — see user_divisions for the current (multi-division) source of truth. Left in place rather than dropped since SQLite column drops require a table rebuild.
  status        TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive'))
);

-- A user (typically Logistics Staff, but any non-Manager role) can be
-- assigned to more than one division (Customer) — e.g. a staff member who
-- covers two customers at once. Manager has no rows here and is always
-- unscoped (sees every division regardless).
CREATE TABLE IF NOT EXISTS user_divisions (
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  customer TEXT NOT NULL,
  PRIMARY KEY (user_id, customer)
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
  ready      INTEGER NOT NULL DEFAULT 0,   -- GLOBAL AGGREGATE across all divisions — see material_stock for the per-division breakdown
  faulty     INTEGER NOT NULL DEFAULT 0,
  reserved   INTEGER NOT NULL DEFAULT 0,
  in_transit INTEGER NOT NULL DEFAULT 0
);

-- Per-division stock breakdown. "Division" == Customer here — each customer
-- has its own separate pool of ready/faulty/reserved/in-transit stock per
-- material. Every write here is mirrored into materials' aggregate columns
-- above in the same transaction, so global (Manager) views stay accurate
-- without needing a JOIN, while division-scoped views read this table.
CREATE TABLE IF NOT EXISTS material_stock (
  material   TEXT NOT NULL REFERENCES materials(name),
  customer   TEXT NOT NULL,
  ready      INTEGER NOT NULL DEFAULT 0,
  faulty     INTEGER NOT NULL DEFAULT 0,
  reserved   INTEGER NOT NULL DEFAULT 0,
  in_transit INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (material, customer)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id        TEXT PRIMARY KEY,
  date      TEXT NOT NULL,
  material  TEXT NOT NULL REFERENCES materials(name),
  qty       INTEGER NOT NULL,              -- signed: negative = stock leaving ready
  ref       TEXT,
  remaining INTEGER NOT NULL,
  type      TEXT NOT NULL,                 -- Delivery | Receipt | Faulty Return | Reconciliation Adjustment
  customer  TEXT                           -- division this movement belongs to
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
  resi_number       TEXT,   -- shipping receipt number — optional, often added after shipping
  resi_photo        TEXT,   -- photo of the shipping receipt — also optional, added the same way
  delivered_photo   TEXT,   -- proof-of-receipt photo, required before Shipped -> Delivered
  received_by       TEXT,   -- name of whoever accepted the goods in the field — optional
  bast_document      TEXT,  -- Berita Acara Serah Terima file (PDF or scanned image) — optional, added any time after shipping
  bast_filename      TEXT,  -- original filename, for display purposes
  customer           TEXT,  -- division this request belongs to (the requesting SPV's division)
  bkb_link           TEXT,  -- URL to the BKB / Surat Jalan document kept in a separate external system — optional, no API integration exists so this is just a reference link
  rejection_reason   TEXT   -- why the Manager rejected this request — shown to the requester so they know what to fix/reconsider
);

CREATE TABLE IF NOT EXISTS delivery_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  material    TEXT NOT NULL,
  qty         INTEGER NOT NULL,
  item_type   TEXT NOT NULL DEFAULT 'material'   -- 'material' (one-way, division-scoped) | 'tool' (checked out, shared pool, must be returned)
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
  resi_photo     TEXT,   -- photo of the shipping receipt — optional, added the same way as resi_number
  revision_note  TEXT,
  doc_before     TEXT,   -- photo (base64) or NULL — see README on object storage
  doc_after      TEXT,
  doc_weighing   TEXT,
  customer       TEXT    -- division this return belongs to (the reporting technician's division)
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
  revision_note TEXT,
  customer      TEXT   -- division this reconciliation belongs to (the reporting technician's division)
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
  status         TEXT NOT NULL DEFAULT 'Ready' CHECK (status IN ('Ready','Reserved','In Transit','Delivered','Installed','Faulty','Sent to Customer')),
  current_ref    TEXT,     -- id of the delivery/return currently holding this unit (nullable when sitting in Ready stock)
  received_date  TEXT,
  received_ref   TEXT,     -- Goods Receipt id this unit arrived on (nullable for units first seen via a Return Faulty)
  customer       TEXT,     -- division this unit belongs to
  installed_date TEXT,     -- when it was confirmed installed at site (Installed status only)
  installed_by   TEXT,     -- who confirmed it (Logistics Staff, based on field report)
  install_photo  TEXT,     -- proof-of-installation photo — required to reach Installed
  install_site   TEXT,     -- site it was installed at (falls back to the owning delivery's site if not given explicitly)
  homebase       TEXT      -- current physical homebase location, set once status reaches Delivered (via the owning delivery's homebase) and updated by Transfer Stock from then on. NULL before Delivered — not yet at a specific homebase.
);
CREATE INDEX IF NOT EXISTS idx_serials_material_status ON serial_numbers(material, status);
-- idx_serials_homebase is NOT created here — on an existing database the
-- `homebase` column doesn't exist yet at this point (schema.sql's CREATE
-- TABLE IF NOT EXISTS is a no-op for a table that already exists), so this
-- index is instead created in db.js's migration, right after the ALTER
-- TABLE that actually adds the column.

-- Per-homebase quantity ledger for NON-serialized materials only (serialized
-- materials use serial_numbers.homebase directly instead — no duplicate
-- bookkeeping needed there). Populated when a Delivery Request reaches
-- Delivered, and adjusted by Transfer Stock afterward. This is layered on
-- top of material_stock (division-level totals) rather than replacing it —
-- material_stock keeps meaning "division has this many Ready", while this
-- table answers the finer-grained "specifically at Homebase X" question
-- that Delivery Request assignment, Warehouse Stock, and every other
-- existing flow never needed before Transfer Stock existed.
CREATE TABLE IF NOT EXISTS material_stock_homebase (
  material TEXT NOT NULL REFERENCES materials(name),
  customer TEXT NOT NULL,
  homebase TEXT NOT NULL,
  qty      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (material, customer, homebase)
);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id            TEXT PRIMARY KEY,
  material      TEXT NOT NULL,
  customer      TEXT NOT NULL,
  homebase_from TEXT NOT NULL,
  homebase_to   TEXT NOT NULL,
  qty           INTEGER NOT NULL,
  performed_by  TEXT NOT NULL,
  date          TEXT NOT NULL,
  note          TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS stock_transfer_serials (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id TEXT NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  sn          TEXT NOT NULL
);

-- One row per "sent to the customer's own facility for them to repair"
-- cycle for a Faulty unit — a unit can go through this more than once over
-- its lifetime, so this is a proper history table rather than a couple of
-- single-value columns on serial_numbers that would just get overwritten
-- on a second cycle. `sn` is intentionally NOT a foreign key to
-- serial_numbers: that table's CHECK constraint has already needed a
-- rebuild (rename/create/drop) twice, and tying another table to it via FK
-- risks the exact "stale reference to a dropped table" bug hit before —
-- safer to keep this a plain lookup column.
CREATE TABLE IF NOT EXISTS faulty_customer_returns (
  id            TEXT PRIMARY KEY,
  sn            TEXT NOT NULL,
  material      TEXT NOT NULL,
  customer      TEXT NOT NULL,
  sent_date     TEXT NOT NULL,
  sent_ref      TEXT NOT NULL,   -- surat/BA number for sending it out to the customer
  sent_by       TEXT NOT NULL,
  sent_note     TEXT DEFAULT '',
  received_date TEXT,            -- filled in once it comes back repaired
  received_ref  TEXT,            -- a NEW surat number for the return trip — never reuses sent_ref
  received_by   TEXT,
  received_note TEXT DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'Sent' CHECK (status IN ('Sent','Received'))
);
CREATE INDEX IF NOT EXISTS idx_faulty_customer_returns_sn ON faulty_customer_returns(sn);

-- ===================== CONSUMABLE MATERIALS =====================
-- A third item category alongside Material and Alat (Tools), for one-time-
-- use items (connectors, isolasi, rubber, etc.) needed for field
-- maintenance. Never serialized, never Faulty, never borrowed/returned —
-- once a Delivery Request carrying one reaches Delivered, it's considered
-- consumed and tracking simply stops there (no per-unit history like
-- Materials, no Reconciliation, no Return workflow).
CREATE TABLE IF NOT EXISTS consumables (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  category   TEXT NOT NULL,
  unit       TEXT NOT NULL,
  min_stock  INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
  ready      INTEGER NOT NULL DEFAULT 0,
  reserved   INTEGER NOT NULL DEFAULT 0,
  in_transit INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS consumable_stock (
  consumable TEXT NOT NULL REFERENCES consumables(name),
  customer   TEXT NOT NULL,
  ready      INTEGER NOT NULL DEFAULT 0,
  reserved   INTEGER NOT NULL DEFAULT 0,
  in_transit INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (consumable, customer)
);

CREATE TABLE IF NOT EXISTS consumable_receipts (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  consumable TEXT NOT NULL,
  qty        INTEGER NOT NULL,
  note       TEXT DEFAULT '',
  created_by TEXT NOT NULL,
  customer   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  material   TEXT NOT NULL,
  qty        INTEGER NOT NULL,
  note       TEXT DEFAULT '',
  created_by TEXT,
  customer   TEXT   -- division this receipt's stock was credited to
);

-- Penggantian Material: swapping a faulty Installed unit at a site for a
-- new one. Records the history (old unit vs new unit, per site) and is the
-- trigger point that feeds the old unit into the existing Return Material
-- Faulty flow — this table doesn't replace that flow, it just links into it.
CREATE TABLE IF NOT EXISTS material_swaps (
  id           TEXT PRIMARY KEY,
  site         TEXT NOT NULL,
  homebase     TEXT,
  old_sn       TEXT,   -- optional — the removed/faulty unit may not be tracked in the system at all
  old_material TEXT,   -- required only when old_sn is given (picked from Master Material, since there's no record to look it up from)
  old_photo    TEXT,   -- proof-of-removal photo for the faulty unit — required only when old_sn is given
  new_sn       TEXT NOT NULL,
  new_material TEXT NOT NULL,
  performed_by TEXT NOT NULL,
  date         TEXT NOT NULL,
  photo        TEXT,   -- proof-of-installation photo for the new unit
  note         TEXT,
  return_id    TEXT   -- filled in once the old unit's Return Material Faulty is created, for traceability
);

-- ===================== TOOLS / PERALATAN (Peminjaman Alat) =====================
-- A completely separate pool from materials/deliveries: tools are borrowed
-- and returned (round-trip), not delivered and consumed (one-way) — and
-- unlike materials, they're a shared company asset with no division
-- (Customer) split; anyone can borrow from the same pool.

CREATE TABLE IF NOT EXISTS tools (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE,
  category     TEXT DEFAULT '',
  unit         TEXT DEFAULT 'Unit',
  serialized   INTEGER NOT NULL DEFAULT 1,
  min_stock    INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'Active',
  available    INTEGER NOT NULL DEFAULT 0,
  checked_out  INTEGER NOT NULL DEFAULT 0,
  under_repair INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tool_serials (
  sn            TEXT PRIMARY KEY,
  tool          TEXT NOT NULL REFERENCES tools(name),
  status        TEXT NOT NULL DEFAULT 'Available' CHECK (status IN ('Available','Checked Out','Under Repair')),
  current_ref   TEXT,     -- id of the tool_checkout currently holding this unit (nullable when Available)
  received_date TEXT,
  received_ref  TEXT      -- Terima Alat (tool_receipts) id this unit arrived on
);
CREATE INDEX IF NOT EXISTS idx_tool_serials_tool_status ON tool_serials(tool, status);

CREATE TABLE IF NOT EXISTS tool_receipts (
  id         TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  tool       TEXT NOT NULL,
  qty        INTEGER NOT NULL,
  note       TEXT DEFAULT '',
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS tool_checkouts (
  id               TEXT PRIMARY KEY,
  requester        TEXT NOT NULL,
  homebase         TEXT NOT NULL,
  purpose          TEXT NOT NULL,
  note             TEXT DEFAULT '',
  status           TEXT NOT NULL DEFAULT 'Waiting Approval',  -- Waiting Approval | Checked Out | Returned | Rejected
  date             TEXT NOT NULL,
  expected_return  TEXT,
  handover_photo   TEXT,
  return_photo     TEXT,
  return_condition TEXT,   -- 'Baik' | 'Rusak' — overall condition noted at return
  return_note      TEXT,
  returned_date    TEXT
);

CREATE TABLE IF NOT EXISTS tool_checkout_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  checkout_id TEXT NOT NULL REFERENCES tool_checkouts(id) ON DELETE CASCADE,
  tool        TEXT NOT NULL,
  qty         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_checkout_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  checkout_id TEXT NOT NULL REFERENCES tool_checkouts(id) ON DELETE CASCADE,
  time        TEXT NOT NULL,
  text        TEXT NOT NULL
);

