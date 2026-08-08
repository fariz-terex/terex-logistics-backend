# TEREX Logistics — Backend API

A real backend for the TEREX Logistics prototype: Express + SQLite
(`better-sqlite3`), JWT auth, and the same business rules the front-end
mock state used to fake — stock reservation, SN duplicate checks, and
discrepancy-triggered stock adjustments — now enforced server-side with
actual DB transactions.

## Why SQLite and not Postgres/Prisma?

Prisma's engine binaries and most managed Postgres providers need outbound
network access this sandbox doesn't have, so this backend uses
`better-sqlite3` — a real embedded SQL database, not a JSON mock — so
everything here actually runs and was tested end-to-end (see "What's been
tested" below). The code is written so swapping to Postgres later is a
day of work, not a rewrite:

- All SQL lives in `src/schema.sql` and inside route files as plain
  `db.prepare(...)` calls — no ORM-specific syntax to migrate away from.
- Swap `better-sqlite3` for `pg` (or re-introduce Prisma once you have
  network access to its engine CDN), rewrite `src/db.js` to open a Postgres
  pool instead, and convert `schema.sql`'s SQLite types
  (`INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY`, etc.) to
  Postgres equivalents. The route logic and transaction boundaries don't
  need to change.

## Setup

```bash
npm install
cp .env.example .env      # adjust JWT_SECRET before any real deployment
npm run seed               # creates terex.db and fills it with sample data
npm start                  # listens on http://localhost:4000
```

Demo accounts (all use password `password123`):

| Username | Role                        |
|----------|------------------------------|
| fariz    | Admin / Manager Logistics   |
| sari     | Logistics Staff              |
| andi     | SPV                           |
| yohanes  | Technician                    |

## Auth

`POST /api/auth/login` with `{ username, password }` returns a JWT. Send it
back as `Authorization: Bearer <token>` on every other request. Each route
is guarded server-side by role — the front-end's role switcher was a demo
convenience; here, permissions are enforced no matter what the client sends.

## Endpoints

| Method | Path | Role | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | — | |
| GET | `/api/materials` | any | |
| POST | `/api/materials` | Manager | |
| PATCH | `/api/materials/:id/toggle-status` | Manager | |
| GET | `/api/areas` `/api/homebases` `/api/customers` `/api/sites` | any | |
| POST | same, + `/api/sites/import` | Manager | import mirrors the CSV preview/validate flow from the UI |
| GET/POST | `/api/users` | Manager | |
| GET | `/api/stock` | any | live `materials` table (ready/faulty/reserved/in_transit) |
| GET | `/api/stock/movements?material=` | any | |
| GET/POST | `/api/deliveries` | SPV creates, any authed reads | server re-validates stock, doesn't trust the client |
| POST | `/api/deliveries/:id/approve` | Logistics | reserves stock (`ready → reserved`) in one transaction |
| POST | `/api/deliveries/:id/reject` | Logistics | |
| POST | `/api/deliveries/:id/advance` | Logistics | `Preparing→Shipped` moves `reserved → in_transit` + writes a stock movement |
| GET/POST | `/api/returns` | Technician creates | full SN + docs validation, and cross-transaction SN conflict check, server-side |
| POST | `/api/returns/:id/approve` `/revise` `/resubmit` `/ship` `/resi` `/receive` `/qc` | see route file | mirrors the exact status machine from the UI |
| POST | `/api/returns/:id/complete` | Logistics | `Completed` is the only step that touches `materials.faulty` |
| GET/POST | `/api/reconciliations` | Technician creates | |
| POST | `/api/reconciliations/:id/revise` `/resubmit` | | |
| POST | `/api/reconciliations/:id/approve` | Logistics | per-item discrepancy → `materials.ready` adjustment + stock movement, inside one transaction |

## What's been tested (in this sandbox, not just written)

- Login for all 4 roles, JWT round-trip.
- Delivery: SPV create → 403 when SPV tries to approve → Logistics approve
  → `ready`/`reserved` actually change in the DB.
- Return Faulty: create with a Serial Number → **reusing that SN in a new
  return is rejected with 409**, exactly like the front-end's warning →
  full lifecycle `approve → ship → receive → qc → complete` → `materials.faulty`
  increments and a `stock_movements` row is written with the correct
  `remaining` value.

Reconciliation's discrepancy-adjustment path uses the identical transaction
pattern as the tested Return Faulty completion, but wasn't separately
re-run in this session — worth a quick manual check before you rely on it.

## Wiring the front-end to this API

The front-end artifact currently keeps everything in React state
(`useState`) seeded from constants at the top of `App.jsx`. To connect it
for real:

1. Add a small `api.js` client, e.g.:
   ```js
   const API_BASE = "http://localhost:4000/api";
   let token = null;
   async function api(path, options = {}) {
     const res = await fetch(`${API_BASE}${path}`, {
       ...options,
       headers: {
         "Content-Type": "application/json",
         ...(token ? { Authorization: `Bearer ${token}` } : {}),
         ...options.headers,
       },
     });
     if (!res.ok) throw new Error((await res.json()).error || res.statusText);
     return res.json();
   }
   ```
2. Replace the `useState(initialDeliveries)` / `useState(MATERIALS)` etc.
   with `useState([])` + a `useEffect` that calls `api('/deliveries')` (and
   similarly for materials, returns, reconciliations, sites, homebases,
   areas, customers, users) on mount.
3. Replace the handler functions that currently mutate state directly
   (`approveDelivery`, `completeReturn`, `approveRecon`, etc.) with calls to
   the matching endpoint, then either refetch or apply the JSON response
   the endpoint already returns (every mutating endpoint here returns the
   updated record, so `setDeliveries(prev => prev.map(d => d.id === updated.id ? updated : d))`
   works without a second round-trip).
4. Note: **the artifact sandbox in Claude.ai cannot reach `localhost`** —
   this API needs to be deployed somewhere with a public URL (Render,
   Railway, Fly.io, your own VPS, etc.) before the hosted front-end artifact
   can call it. For local development, run both the backend (`npm start`
   here) and the front-end (e.g. `npm run dev` in a Vite/CRA project you
   export the component into) on your own machine.

## Known gaps for production

- Photos are stored as base64 text directly in SQLite columns. Fine for a
  prototype; swap for S3/GCS + storing just the URL before real usage —
  base64-in-DB doesn't scale.
- No rate limiting, no refresh tokens, no password reset flow.
- `Shipped → Delivered` doesn't currently reduce `in_transit` — same
  simplification the front-end prototype had; decide the real rule
  (does transit stock get zeroed on delivery confirmation?) before
  shipping this to production.
