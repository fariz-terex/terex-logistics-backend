# TEREX Logistics Management System

Web app manajemen logistik untuk PT Terex (maintenance & support infrastruktur
telekomunikasi). Mengelola material, delivery, return faulty, rekonsiliasi,
peminjaman alat, dan stok gudang — lintas beberapa divisi customer.

## Arsitektur

- **Backend**: Node.js + Express, database **SQLite** (`better-sqlite3`).
  - Entry: `server.js` (root). DB layer: `db.js` (root). Seed: `seed.js` (root).
  - Routes di `routes/` — di-mount di `server.js`. File route memakai
    `require("../db")`, `require("../middleware/auth")`, `require("../utils/...")`
    (naik satu folder dari `routes/` ke root). **Jangan pakai `./db` di dalam
    routes/** — itu bug yang pernah bikin server crash (mencari `routes/db.js`).
  - Helpers: `utils/ids.js` (generate ID), `utils/stock.js` (scope & adjust
    stok), `utils/faultyCycle.js`. Auth: `middleware/auth.js`
    (`requireAuth`, `requireRole`).
- **Frontend**: React satu file besar **`App.jsx`** (~7000+ baris) di repo
  frontend terpisah. Styling Tailwind. Semua komponen, `createApiClient`, dan
  routing halaman ada di file ini.
- **Deploy**: Railway, auto-deploy dari GitHub `main`. Backend & frontend
  adalah dua service terpisah. Backend URL:
  `https://backend-production-5543.up.railway.app/api`.
- **Database file**: `terex.db` di **Railway volume**, mount path `/data`
  (env var `DB_FILE`, mengarah ke `/data/terex.db`). Volume persisten —
  data selamat meski container restart.

## Data & konsep penting

- **Divisi (customer)**: PIM, MSG, RGR, Teleglobal. Data di-scope otomatis
  per divisi lewat `scopeOf(req.user)` / `scopeClause` di `utils/stock.js`.
  Manager (`Admin / Manager Logistics`) unscoped (lihat semua); role lain
  di-scope ke divisi yang di-assign.
- **PIM pakai CLUSTER, divisi lain pakai HOMEBASE.** PIM punya 6 cluster
  (ACEH-1/2/3, BANTEN-1, JABAR-1B, KALTENG-1) di tabel `clusters`. Unit
  serialized PIM wajib punya cluster saat Goods Receipt. Transfer antar
  cluster butuh approval SPV pemilik (`cluster_transfers`).
- **Roles** (string persis): `Admin / Manager Logistics` (Manager),
  `Logistics Staff`, `SPV`, `Technician`, `Manager Divisi` (DIVISION_MANAGER).
- **serial_numbers**: satu baris per unit fisik. Kolom termasuk `sn`,
  `material`, `status`, `customer`, `cluster`, `homebase`, `received_date`,
  `installed_date`, `install_site`, dan tiga kolom histori import:
  `replacement_date`, `shipped_to_warehouse_date`, `returned_to_customer_date`.
  Status: Ready, Reserved, In Transit, Delivered, Installed, Faulty,
  Sent to Customer.
- **material_stock**: agregat per (material, customer) — `ready`, `faulty`,
  `reserved`, `in_transit`. Warehouse Stock membaca dari sini. CATATAN: ini
  sumber terpisah dari `serial_numbers`; keduanya bisa tidak sinkron kalau
  data dimasukkan lewat jalur non-normal (mis. import).

## Aturan wajib (hasil pelajaran pahit — jangan diulang)

1. **Tambah kolom ke `serial_numbers` HANYA dengan `ALTER TABLE ADD COLUMN`
   polos (tanpa CHECK), pola `homebase`/`cluster` di `db.js`.** JANGAN rebuild
   tabel (rename/create/drop) — itu pernah menyebabkan bug FK ke tabel yang
   sudah di-drop, dua kali. Validasi nilai di layer aplikasi, bukan CHECK.
2. **Generate ID pakai pola MAX+1, bukan COUNT+1** (`utils/ids.js`
   `paddedSequenceId`). COUNT+1 bikin ID bentrok kalau ada baris terhapus.
   Pass `idColumn` yang benar: tabel `tools`/`customers`/`users` pakai kolom
   `id`, sedangkan `areas`/`homebases`/`clusters` pakai `code`.
3. **Migrasi harus idempoten** — cek kolom/tabel ada dulu sebelum menambah.
4. **Frontend pakai `React.useEffect` (qualified)**, bukan bare `useEffect` —
   import di `App.jsx` hanya `useState, useMemo`.
5. **Jangan pakai localStorage/sessionStorage di artifact** (tidak relevan di
   repo asli, tapi hindari asumsi env browser).

## Alur kerja deploy

- Repo lokal di `Downloads\Proyek - Terex Web App\` (backend & frontend
  masing-masing subfolder). Deploy: commit + push ke `main` → Railway
  auto-deploy. (`deploy_terex.bat` yang lama menyalin dari folder Downloads;
  lebih andal pakai `git add/commit/push` langsung dari repo.)
- Setelah deploy backend, cek Railway deploy log ada
  `TEREX Logistics backend listening` dan tidak ada error modul/crash.
- Frontend butuh hard refresh (Ctrl+Shift+R) setelah deploy karena cache.

## Status saat ini

- Data historis **MSG sudah diimport** (418 unit, snapshot + 5 tanggal per
  unit), dan `material_stock` MSG sudah disinkronkan dari `serial_numbers`.
- **Backup lokal `terex.db` sudah ada** dan terverifikasi (~418 unit MSG).
- **Endpoint admin sementara sudah DIHAPUS** (commit `1179b2b`):
  `routes/adminImport.js` + `importMsgCore.js` + baris mount `/api/admin` di
  `server.js`. `/api/admin/*` sekarang balas 404. Salinan arsipnya disimpan
  di luar repo (`Downloads/terex-admin-import-archive/`) kalau perlu import
  lagi. Ketiga tugas di TUGAS_LANJUTAN.md sudah selesai.
