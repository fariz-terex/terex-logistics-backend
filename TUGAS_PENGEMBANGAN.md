# Tugas Pengembangan — TEREX Logistics

Daftar pengembangan hasil review kode (backend ~3.900 baris, frontend `App.jsx`
~7.400 baris). Urut prioritas. Kerjakan satu per satu, commit terpisah per tugas,
push ke `main` → Railway auto-deploy. Cek deploy log tiap kali: ada
`TEREX Logistics backend listening`, tidak ada error modul/crash.

Legenda repo: **[BE]** `terex-backend` · **[FE]** `terex-frontend`

---

# P0 — Keandalan & keamanan data

## 1. [BE] Backup otomatis `terex.db` — PRIORITAS UTAMA

**Kenapa**: satu-satunya salinan data ada di Railway volume. Endpoint backup
manual sudah dihapus (commit `1179b2b`). Trial pernah hampir habis dan nyaris
kehilangan akses. Tidak boleh mengandalkan backup manual.

**Yang diminta**:
- Endpoint backup permanen **`GET /api/admin/backup-db`**, TAPI dikunci pakai
  `AUTOMATION_API_KEY` (header `X-Automation-Key`), bukan role Manager — supaya
  aman ditinggal hidup. Pola auth ikut `middleware/automationAuth.js`.
- Implementasi stream: `db.backup(tmpFile)` (better-sqlite3, sudah terbukti di
  commit `8e076c1` yang lama) lalu `res.download`, hapus tmp setelahnya.
- Penjadwal yang menarik file keluar Railway, salah satu:
  - **Railway Cron service** terpisah (service kecil, schedule harian) yang
    `curl` endpoint di atas dan upload hasil ke **Cloudflare R2 / Google Drive
    / S3**. Retensi minimal 7 harian + 4 mingguan.
  - Atau **GitHub Actions** terjadwal (`schedule: cron`) yang melakukan hal sama.
- Simpan kredensial storage sebagai env var di Railway, jangan di repo.

**Alternatif tambahan**: aktifkan **volume snapshot** Railway kalau tersedia di
plan (Settings → Volume). Ini pelengkap, bukan pengganti backup off-site.

**Verifikasi**:
- Jalankan job manual sekali → file `.db` muncul di storage tujuan.
- Download file itu, cek dengan `node verify-backup.js <file>` (skrip sudah ada
  di `Downloads/`) → tabel `serial_numbers` berisi ~418 unit MSG + tabel lain
  berisi data.
- Endpoint tanpa header → 401; dengan header salah → 401; benar → file terunduh.

---

## 2. [BE] Pin versi Node

**Kenapa**: `package.json` tidak punya `engines`, tidak ada `.nvmrc`. Build
native `better-sqlite3` sensitif ke versi Node — kalau Railway menaikkan versi
default, build backend bisa mendadak gagal saat deploy berikutnya.

**Yang diminta**:
- Tambah ke `package.json`:
  ```json
  "engines": { "node": ">=22 <25" }
  ```
  (sesuaikan dengan versi yang sekarang jalan di Railway — cek deploy log
  baris `node -v`, atau `railway run node -v`).
- Tambah `.nvmrc` berisi versi mayor yang sama, untuk dev lokal.
- Opsional: tambahkan file `nixpacks.toml` yang mengunci `NIXPACKS_NODE_VERSION`.

**Verifikasi**: deploy ulang, deploy log menunjukkan versi Node yang diharapkan,
`better-sqlite3` ter-build tanpa error, backend listening.

---

## 3. [BE+FE] Recompute stok yang aman + cek konsistensi terjadwal

**Kenapa**: `material_stock` (agregat yang dibaca Warehouse Stock) bisa melenceng
dari `serial_numbers` kalau data masuk lewat jalur non-normal. CLAUDE.md sendiri
menandai ini. Endpoint `sync-stock` yang lama sudah dihapus dan memang tidak aman
(bisa menimpa massal tanpa jejak).

**Yang diminta**:
- **[BE]** Endpoint `POST /api/stock/recompute` (role Manager) — hitung ulang
  `material_stock` satu divisi dari `serial_numbers`, dengan:
  - mode `dry-run` default (kembalikan preview selisih, tidak menulis),
  - `commit=true` untuk menerapkan,
  - tulis 1 baris `stock_movements` / audit per material yang berubah (jangan
    silent overwrite),
  - transaksi tunggal.
- **[FE]** Tombol di halaman Warehouse Stock / Master Data: "Periksa & hitung
  ulang stok" → tampilkan preview selisih → konfirmasi → commit.
- **[BE]** Job terjadwal (Railway Cron / n8n) yang menjalankan dry-run semua
  divisi tiap hari; kalau ada selisih, kirim notifikasi (Telegram/n8n webhook
  yang sudah ada di `utils/webhook.js`).

**Verifikasi**: buat 1 unit `serial_numbers` manual lewat SQL di staging →
dry-run mendeteksi selisih → commit → `material_stock` cocok → ada baris audit.

---

## 4. [BE] Test untuk jalur transaksi kritis

**Kenapa**: 0 test untuk ~11.000 baris kode. Setiap perubahan `db.js` / route
stok berisiko regresi diam-diam (sudah kejadian: bug FK 2×, crash `./db`).

**Yang diminta**:
- Setup test runner ringan: `node --test` (bawaan) + `better-sqlite3`
  in-memory (`new Database(":memory:")`), muat `schema.sql`.
- Test minimum:
  1. `POST /api/auth/login` — 4 role, JWT valid, akun non-aktif ditolak.
  2. Delivery: SPV create → SPV approve ditolak 403 → Logistics approve →
     `ready`/`reserved` berubah benar di DB.
  3. Return Faulty: create dengan SN → SN sama dipakai lagi → 409 →
     lifecycle `approve→ship→receive→qc→complete` → `materials.faulty` naik 1,
     `stock_movements.remaining` benar.
  4. Reconciliation approve: discrepancy → `materials.ready` menyesuaikan +
     `stock_movements` tertulis, dalam 1 transaksi.
  5. `utils/ids.js` — MAX+1 tetap benar setelah baris dihapus.
- Tambah `"test": "node --test"` di `package.json`, jalankan di CI (GitHub
  Actions) tiap push.

**Verifikasi**: `npm test` hijau lokal & di CI; sengaja rusak satu invariant →
test merah.

---

# P1 — Hardening keamanan

## 5. [BE] `JWT_SECRET` wajib di production

**Kenapa**: `middleware/auth.js` fallback diam-diam ke `"dev-secret-change-me"`
kalau env kosong — token bisa dipalsukan siapa saja.

**Yang diminta**: saat boot, kalau `NODE_ENV === "production"` (atau selalu) dan
`JWT_SECRET` tidak di-set / masih nilai placeholder → `console.error` + `process.exit(1)`.
Lakukan di `server.js` sebelum `app.listen`.

**Verifikasi**: hapus `JWT_SECRET` di staging → backend menolak start dengan
pesan jelas. Set kembali → normal.

---

## 6. [BE] Rate limit login

**Kenapa**: `/api/auth/login` tanpa pembatasan → brute-force password.

**Yang diminta**: `express-rate-limit` pada `/api/auth/login` (mis. 10 percobaan
/ 15 menit / IP) dan limiter global longgar untuk seluruh `/api`. Balas 429 +
pesan Bahasa Indonesia.

**Verifikasi**: 11 login gagal beruntun → percobaan ke-11 dapat 429.

---

## 7. [BE] Security headers

**Kenapa**: tidak ada `helmet` — header keamanan dasar (CSP, HSTS, nosniff, dll)
tidak ada.

**Yang diminta**: pasang `helmet()` di `server.js`. Cek CORS & embedding masih
jalan untuk frontend Railway; sesuaikan `crossOriginResourcePolicy` kalau perlu
(foto base64 di-render dari API).

**Verifikasi**: response `/api/health` memuat header `x-content-type-options`,
`strict-transport-security`; frontend tetap berfungsi penuh.

---

## 8. [BE+FE] Pindahkan foto dari base64-di-SQLite ke object storage

**Kenapa**: foto (resi, packing, timbangan, SN, BAST) disimpan sebagai teks
base64 di kolom SQLite. Akibat: DB & file backup membengkak (backup sudah
beberapa MB), query lambat, limit body request 30 MB rawan kena. README
menandai ini sebagai known gap.

**Yang diminta**:
- Bucket **Cloudflare R2 / S3**. Backend terima upload (multipart atau presigned
  URL), simpan **URL** di kolom yang sekarang, bukan data base64.
- Endpoint upload: `POST /api/uploads` → kembalikan `{ url }`. Validasi tipe &
  ukuran. Kompresi klien tetap dipertahankan (`compressImage` di `App.jsx`).
- **Migrasi data lama**: skrip sekali-jalan yang baca kolom base64 lama, upload
  ke bucket, ganti isinya jadi URL. Backup dulu sebelum jalan.
- **[FE]** `PhotoUpload` / `PhotoThumb` kirim ke endpoint upload, render dari URL.

**Verifikasi**: upload foto baru → DB menyimpan URL pendek, gambar tampil dari
bucket. Ukuran file backup turun drastis. Foto lama tetap tampil setelah migrasi.

---

## 9. [BE] Non-aktifkan user berlaku langsung

**Kenapa**: `requireAuth` hanya verifikasi JWT; user yang di-nonaktifkan tetap
bisa dipakai tokennya sampai 12 jam.

**Yang diminta**: di `requireAuth`, setelah verifikasi JWT, cek
`SELECT status FROM users WHERE id = ?` → kalau bukan `Active`, balas 401.
(Tambah cache kecil in-memory kalau khawatir query per request.)

**Verifikasi**: login → nonaktifkan user via Master Data → request berikutnya
dengan token lama → 401.

---

## 10. [BE] Perbandingan `AUTOMATION_API_KEY` timing-safe

**Kenapa**: `automationAuth.js` pakai `!==` biasa (timing attack, minor).

**Yang diminta**: `crypto.timingSafeEqual` dengan panjang yang disamakan.

**Verifikasi**: automation n8n tetap jalan; key salah tetap 401.

---

# P1–P2 — Kualitas kode & skema

## 11. [BE] Sistem migrasi berversi

**Kenapa**: `db.js` ~550 baris migrasi ad-hoc, termasuk pola rebuild tabel
(rename→create→drop) yang **sudah 2× menyebabkan bug FK** (dicatat di CLAUDE.md).
Makin banyak fitur, makin rapuh.

**Yang diminta**:
- Folder `src/migrations/NNNN_nama.sql` (atau `.js`) + tabel `schema_migrations`
  (versi yang sudah dijalankan) + runner kecil di `db.js` yang menjalankan
  migrasi yang belum, berurutan, idempoten.
- Pindahkan blok migrasi yang ada sekarang jadi berkas-berkas bernomor.
- Aturan tetap berlaku: `ALTER TABLE ADD COLUMN` polos, JANGAN rebuild tabel.

**Verifikasi**: DB fresh → semua migrasi jalan berurutan, skema akhir sama
dengan sekarang. Deploy ulang pada DB existing → hanya migrasi baru yang jalan,
data utuh.

---

## 12. [FE] Pecah `App.jsx` (7.400 baris, 61 komponen)

**Kenapa**: satu file raksasa → review sulit, merge rawan konflik, onboarding
lambat, bundle susah di-split.

**Yang diminta** (bertahap, jangan sekaligus):
- Ekstrak per domain ke `src/features/`: `deliveries/`, `returns/`,
  `reconciliations/`, `stock/`, `masterData/`, `tools/`, `automation/`.
- Komponen UI generik (`Card`, `SectionTitle`, `StatusBadge`, `PhotoUpload`,
  dialog, dll) ke `src/components/`.
- `createApiClient` + konstanta ke `src/api/` dan `src/constants.js`.
- Pertahankan aturan: `React.useEffect` qualified, import hanya `useState,
  useMemo` di file yang lama (atau rapikan sekalian per file baru).

**Verifikasi**: `vite build` sukses, semua halaman jalan sama seperti sebelum
refactor. Lakukan per-PR kecil, bukan satu PR besar.

---

## 13. [FE] Code-split bundle

**Kenapa**: JS produksi 1,16 MB (330 KB gzip) dalam satu chunk — load awal berat,
apalagi untuk teknisi lapangan di sinyal lemah.

**Yang diminta**: `React.lazy` + `Suspense` per halaman/route utama.
`recharts` dan `xlsx` (besar) di-lazy-load hanya saat halaman yang butuh dibuka.
Pertimbangkan `build.rollupOptions.output.manualChunks` untuk vendor.

**Verifikasi**: `vite build` — chunk utama < 500 KB, chunk halaman terpisah.
Aplikasi berfungsi normal.

---

## 14. [BE+FE] Rapikan repo

**Kenapa**: ~40 file `*.patch` ter-commit di root kedua repo — cruft historis
yang membingungkan.

**Yang diminta**: pindahkan semua `*.patch` ke folder di luar repo (arsip), atau
ke `docs/history/` yang di-`.gitignore`. Lengkapi `.env.example` **[BE]** dengan
semua env var yang dipakai: `PORT`, `JWT_SECRET`, `DB_FILE`, `ALLOWED_ORIGINS`,
`AUTOMATION_API_KEY`, + kredensial storage backup (tugas #1) & object storage
(tugas #8). Isi dengan placeholder + komentar singkat.

**Verifikasi**: `git ls-files` bersih dari `.patch`; `.env.example` mencakup
semua yang dibaca `process.env` di kode.

---

# P2 — Gap fitur produk

## 15. [BE+FE] Putuskan aturan `Shipped → Delivered` untuk `in_transit`

**Kenapa**: saat ini `Shipped → Delivered` tidak mengurangi `in_transit`
(simplifikasi warisan prototype, dicatat di README). Stok transit menumpuk
terus secara angka.

**Yang diminta**: tentukan aturan bisnis (apakah `in_transit` di-nol-kan / kurang
saat penerimaan dikonfirmasi?), lalu implementasikan di transaksi konfirmasi
Delivered + tulis `stock_movements`. Backfill data historis kalau perlu.

**Verifikasi**: delivery lifecycle penuh → `in_transit` kembali 0 untuk item itu
setelah Delivered; `stock_movements` konsisten.

---

## 16. [BE+FE] Audit log menyeluruh

**Kenapa**: hanya `stock_movements` & `automation_log` yang tercatat. Perubahan
master data, user, dan perpindahan status delivery/return tidak ada jejaknya —
menyulitkan saat ada sengketa inventory.

**Yang diminta**:
- Tabel `audit_log` (siapa, kapan, entitas, aksi, nilai sebelum/sesudah).
- Helper `writeAudit(req, { entity, entityId, action, before, after })`
  dipanggil di semua route mutasi.
- **[FE]** Halaman "Riwayat Aktivitas" (Manager) dengan filter entitas/user/tanggal.

**Verifikasi**: ubah 1 field master data → 1 baris audit dengan diff benar.

---

## 17. [BE+FE] Laporan & export

**Kenapa**: belum ada cara menarik data untuk pelaporan ke customer/manajemen.

**Yang diminta**: export **Excel/CSV** untuk: stok gudang per divisi, daftar
unit + 5 tanggal histori, lead time faulty cycle (terima→install→replacement→
return), rekap delivery/return per periode. Backend generate, frontend tombol
"Export".

**Verifikasi**: file Excel terbuka benar, angka cocok dengan tampilan UI.

---

## 18. [FE] Resiliensi sinyal lemah untuk teknisi lapangan

**Kenapa**: Return Faulty & Reconciliation dibuat di lokasi yang sering tanpa
sinyal; kegagalan submit = kehilangan input + foto.

**Yang diminta**: simpan draft form (termasuk foto terkompresi) di IndexedDB;
banner "tersimpan lokal, belum terkirim" + retry manual saat online. (Catatan:
CLAUDE.md melarang localStorage di artifact — di repo asli IndexedDB boleh.)

**Verifikasi**: matikan network di DevTools → isi & "submit" → reload → draft
masih ada → online → kirim ulang sukses.

---

## 19. [BE+FE] Reset password & manajemen akun

**Kenapa**: tidak ada alur reset password; semua bergantung Manager set manual.

**Yang diminta**: Manager bisa trigger reset (generate password sementara /
link). Idealnya user bisa ganti password sendiri setelah login. Tidak perlu
email flow kalau belum ada SMTP — cukup "Manager set password baru".

**Verifikasi**: Manager reset → user login dengan password baru → user ganti
password → password lama tidak berlaku.

---

## Catatan umum

- Commit terpisah & deskriptif per tugas. Push ke `main` → Railway auto-deploy.
- **[BE]** cek deploy log: `TEREX Logistics backend listening`, tidak ada error
  modul. Path `require` di dalam `routes/` harus `../` (bukan `./`).
- **[FE]** hard refresh (Ctrl+Shift+R) setelah deploy.
- Untuk tugas yang menyentuh data (`#3`, `#8`, `#15`): **backup dulu** (tugas #1)
  sebelum commit yang mengubah data.
- Jangan hapus: 3 kolom tanggal di `db.js`, fix `utils/ids.js` (MAX+1), fitur
  cluster, perubahan dashboard.
