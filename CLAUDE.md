# TEREX Logistics Management System

Web app manajemen logistik untuk PT Terex (maintenance & support infrastruktur
telekomunikasi). Mengelola material, delivery, return faulty, rekonsiliasi,
peminjaman alat, dan stok gudang — lintas beberapa divisi customer.

## Arsitektur

- **Backend**: Node.js + Express, database **SQLite** (`better-sqlite3`).
  - Everything lives under **`src/`** (not repo root — this CLAUDE.md used to
    say root, that was stale). Entry: `src/server.js`. DB layer: `src/db.js`.
    Seed: `src/seed.js`. Schema: `src/schema.sql`.
  - Routes di `src/routes/` — di-mount di `src/server.js`. File route
    memakai `require("../db")`, `require("../middleware/auth")`,
    `require("../utils/...")` (naik satu folder dari `routes/` ke `src/`).
    **Jangan pakai `./db` di dalam routes/** — itu bug yang pernah bikin
    server crash (mencari `routes/db.js`).
  - Helpers di `src/utils/`: `ids.js` (generate ID), `stock.js` (scope &
    adjust stok), `faultyCycle.js`, `stockTransfers.js` (Transfer Stock
    lifecycle — create/approve/reject/cancel), `bkbParser.js` (Claude reads
    a BKB document → line items), `materialPhotoDetector.js` (Claude reads
    photo(s) of physical goods → material+qty+SN guesses). Auth:
    `src/middleware/auth.js` (`requireAuth`, `requireRole`).
  - **No `node_modules` in the sandbox this CLAUDE.md is usually read in**
    (`npm install` fails — `better-sqlite3` needs node-gyp/Python, unavailable
    there). Backend tests use Node's built-in `node:sqlite`
    (`DatabaseSync`) + `node:test`, never better-sqlite3-only APIs like
    `db.transaction(fn)` — use a raw `BEGIN`/`COMMIT`/`ROLLBACK` helper
    instead (see `withTransaction` in `utils/stockTransfers.js`) so the same
    code runs against both drivers. Run tests with
    `node --test test/*.test.js` from `terex-backend/`.
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
- Frontend sekarang set `Cache-Control` yang benar lewat
  `terex-frontend/public/serve.json` (di-copy Vite ke `dist/` saat build —
  taruh di root repo TIDAK terbaca oleh `serve`, harus di `public/`):
  `index.html` no-cache, `assets/**` immutable. Reload biasa sudah cukup
  untuk lihat versi terbaru setelah deploy, tidak perlu hard refresh lagi.

## Testing pola frontend (tidak ada login/credentials asli di sandbox ini)

`npx vite build` dulu untuk cek syntax error, lalu manual pass:
`node <scratchpad>/mock-server.js` (Node `http`, in-memory, endpoint-endpoint
yang dipakai layar yang sedang diuji) + `npx vite preview --port 4173`, buka
lewat Claude Browser tools, inject sesi lewat `javascript_exec`:
```js
function b64url(o){return btoa(JSON.stringify(o)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}
const token = `${b64url({alg:"none",typ:"JWT"})}.${b64url({sub:"USR001",exp:Math.floor(Date.now()/1000)+3600*12})}.sig`;
sessionStorage.setItem("terex_session", JSON.stringify({token, user:{id:"USR001",name:"...",role:"...",customers:[]}, apiBase:"http://localhost:8787"}));
```
lalu `navigate` ke URL dengan query-string berbeda (bukan sekadar hash) supaya
benar-benar reload dan pakai sesi baru — perubahan hash saja tidak reload
halaman. Untuk simulasi pilih file foto (tidak ada file dialog asli di
browser otomatis ini): buat `File` dari base64 PNG kecil, `DataTransfer`,
set `input.files`, dispatch `change` event — lihat riwayat commit
`terex-frontend` untuk contoh lengkap.

## Status saat ini

- Data historis **MSG sudah diimport** (418 unit, snapshot + 5 tanggal per
  unit), dan `material_stock` MSG sudah disinkronkan dari `serial_numbers`.
- **Backup lokal `terex.db` sudah ada** dan terverifikasi (~418 unit MSG).
- **Endpoint admin sementara sudah DIHAPUS** (commit `1179b2b`):
  `routes/adminImport.js` + `importMsgCore.js` + baris mount `/api/admin` di
  `server.js`. `/api/admin/*` sekarang balas 404. Salinan arsipnya disimpan
  di luar repo (`Downloads/terex-admin-import-archive/`) kalau perlu import
  lagi. Ketiga tugas di TUGAS_LANJUTAN.md sudah selesai.
- **UI/UX roadmap (8 item) sudah selesai & deploy** (routing, draft form,
  pagination/sort, dashboard per-role, dll) — lihat `[[project_ux_roadmap]]`
  di memory kalau ada, jangan disarankan ulang.
- **Delivery/Return Faulty/Transfer Stock digabung jadi satu menu "Delivery"**
  (`UnifiedRequestList` + `RequestCreate` di `App.jsx`), dengan Alamat/Area
  Pengirim+Tujuan di step pertama yang menentukan jenis request-nya secara
  otomatis (Warehouse→Homebase = Delivery, Homebase→Warehouse = Return,
  Homebase→Homebase = Transfer). Transfer Stock sekarang punya approval gate
  (dulu langsung eksekusi) — lihat `utils/stockTransfers.js` (backend) dan
  `TransferCreate`/`TransferDetail` (frontend). `hasAccess("delivery")` di
  frontend adalah UNION dari 3 role-set lama — jangan dipersempit lagi, itu
  akan mengunci Technician dari satu-satunya jalan mereka ke Return Faulty.
- **Deteksi foto berbasis AI (Claude vision) ditambahkan ke 3 flow**
  (Reconciliation, Transfer Stock, Return Material Faulty):
  - `POST /stock/detect-materials-photo` (`utils/materialPhotoDetector.js`,
    pola yang sama persis dengan `parse-bkb`/`bkbParser.js` yang sudah ada
    duluan — whitelist-only match, tidak pernah percaya nama material yang
    di-"karang" Claude) — terima 1-6 foto FISIK barang (bukan dokumen),
    balas `{material, qty, confidence, serials, note}` per item. `serials`
    itu best-effort (SN yang benar-benar terbaca jelas di foto yang sama,
    boleh kosong) — Claude TIDAK diminta membaca barcode di sini, ini murni
    baca teks tercetak.
  - Reuse `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` yang sudah ada untuk fitur
    BKB — tidak perlu key baru.
  - Frontend: `PhotoMaterialDetect` (komponen dropzone drag-and-drop, dekat
    `BkbReceiptPanel`) dipakai di ketiga flow, tiap flow beda cara
    memakai hasilnya (lihat komentar di `applyDetected`/`applyDetectedItems`/
    `applyDetectedQueue` di `App.jsx`) — jangan disamakan modelnya, coba
    baca dulu bedanya sebelum ubah.
  - **"Foto Keseluruhan Material" (Reconciliation) itu SATU foto untuk
    SELURUH reconciliation** (semua material digabung satu frame, mis. foto
    geotag lokasi) — field mandiri di level form (`reconciliations.photo`,
    kolom baru via ALTER TABLE), BUKAN per-item, dan BUKAN foto yang sama
    dengan "Deteksi dari Foto". Sempat salah paham 2x sebelum benar — kalau
    ada permintaan serupa lagi, baca histori chat lama sebelum menebak.
  - Barcode-dari-foto (beda dari deteksi-material-dari-foto di atas): tombol
    "Upload Foto" per-SN di Return Faulty men-decode barcode dari FOTO ASLI
    (bukan versi terkompresi) pakai `@zxing/browser` yang sama dengan
    `ScanButton` (live camera) — kompresi terbukti bisa merusak keterbacaan
    barcode kalau barcode-nya kecil dalam frame foto (lihat komentar di
    `PhotoUpload`'s `detectBarcode` path). `ScanButton` (live camera) sudah
    dihapus dari Return Faulty & Reconciliation (redundant dengan fitur
    foto di atas) — masih ada di Tool Receipt & Material Swap karena
    keduanya belum punya foto-detect sebagai pengganti.
- **Reconciliation System Qty = stock HOMEBASE nyata** (bukan lagi angka
  ketikan user): serialized = jumlah SN `Delivered` di homebase itu,
  non-serialized = `material_stock_homebase.qty` — definisi yang sama
  dengan Transfer Stock. Logika di `utils/reconciliation.js` (+ test).
  Frontend ambil lewat `GET /reconciliations/system-qty?customer&homebase`
  dan tampilkan read-only; server SELALU hitung ulang saat create/resubmit
  (nilai dari client diabaikan). **Approve sekarang menyesuaikan stock
  homebase, BUKAN warehouse Ready** (dulu `adjustStock(..., "ready")` —
  salah, barang Delivered sudah keluar dari Ready): non-serialized geser
  `material_stock_homebase` sebesar discrepancy (delta, bukan set ke
  actual); serialized tidak mengubah status SN (belum ada status "Hilang")
  tapi SN yang tidak ditemukan / tidak tercatat dicatat di history.
  Keputusan user 2026-09-24.
- **Reconciliation punya SATU "Alasan Discrepancy" untuk seluruh form**
  (`reconciliations.reason`, kolom via ALTER TABLE), bukan per item —
  permintaan user. `reconciliation_items.reason` hanya untuk data lama.
  Form menampilkan daftar "Belum bisa submit — lengkapi dulu" (array
  `missing` di `ReconciliationCreate`) — tambah item ke situ kalau ada
  syarat submit baru, jangan biarkan tombol disabled tanpa penjelasan.
  Foto referensi per baris (`detectionPhotos`) bisa diganti lewat
  `ReplacePhotoButton`, tapi TIDAK dikirim/disimpan ke server.
