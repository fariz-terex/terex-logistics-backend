# Tugas Lanjutan — kerjakan di Claude Code

Tiga tugas tertunda, urut prioritas. Kerjakan satu per satu, commit tiap tugas
terpisah. Backup dulu (Tugas 1) sebelum yang lain.

---

## TUGAS 1 — Backup `terex.db` ke komputer lokal (PRIORITAS)

**Kenapa**: belum pernah ada salinan database di luar Railway. Trial sempat
habis dan hampir kehilangan akses. Wajib punya backup lokal.

**Cara paling andal — Railway CLI** (tidak perlu ubah kode):

1. Install Railway CLI kalau belum: `npm i -g @railway/cli` lalu `railway login`.
2. Link ke project: `railway link` (pilih `terex-logistics-backend`).
3. Jalankan shell di service backend dan salin file keluar. Salah satu cara:
   - `railway ssh` ke service backend, lalu di dalamnya cek file ada:
     `ls -la /data/terex.db`
   - Untuk menariknya ke lokal, jalankan lewat `railway run` sebuah perintah
     yang men-stream file, atau gunakan `railway ssh` + `cat`/`sftp` sesuai
     versi CLI. (Claude Code: cek versi CLI yang terpasang dan pakai subперintah
     yang tersedia — `railway volume`, `railway ssh`, atau `railway run`.)

**Alternatif — endpoint download sekali pakai** (kalau CLI ribet):
Tambah endpoint Manager-only sementara di `routes/adminImport.js`:

```js
const fs = require("fs");
const path = require("path");
router.get("/backup-db", requireAuth, requireRole(MANAGER), (req, res) => {
  const dbPath = process.env.DB_FILE || path.resolve(__dirname, "..", "terex.db");
  const abs = path.isAbsolute(dbPath) ? dbPath : path.resolve(__dirname, "..", dbPath);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: "DB file tidak ditemukan: " + abs });
  res.download(abs, `terex-backup-${new Date().toISOString().slice(0,10)}.db`);
});
```

Lalu download lewat browser console (login Manager dulu untuk dapat token):

```js
// setelah login & punya token di window.__t:
fetch("https://backend-production-5543.up.railway.app/api/admin/backup-db", {
  headers: { Authorization: "Bearer " + window.__t }
}).then(r => r.blob()).then(b => {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b);
  a.download = "terex-backup.db";
  a.click();
});
```

**PENTING**: endpoint backup ini juga SEMENTARA — hapus bersama endpoint admin
lain di Tugas 3. Simpan file `.db` hasil download di tempat aman (dan idealnya
jadwalkan backup rutin ke depannya).

**Verifikasi**: buka file `.db` hasil backup dengan DB browser (mis. "DB Browser
for SQLite") dan pastikan tabel `serial_numbers` berisi ~418 unit MSG + data
lain. Kalau bisa dibuka dan datanya ada, backup sukses.

---

## TUGAS 2 — Tampilkan 5 tanggal di halaman Detail Serial Number

**Konteks**: kolom sudah ada di DB dan `GET /api/stock/serials` sudah
`SELECT *` (jadi tanggal sudah ikut terkirim ke frontend — TIDAK perlu ubah
backend). Tinggal tampilkan di UI.

**Lokasi**: `App.jsx`, komponen `MaterialSerialDetail` (~baris 2374). Tabelnya
sekarang punya kolom: SN, Status, Referensi, (Aksi untuk Manager/Logistics).
Tiap baris `s` adalah satu unit dengan field:
`s.received_date`, `s.installed_date`, `s.install_site`, `s.replacement_date`,
`s.shipped_to_warehouse_date`, `s.returned_to_customer_date`.

**Yang diminta**: tampilkan kelima tanggal (+ install_site) per unit. Dua opsi
desain — pilih yang paling rapi:

- **Opsi A (disarankan): baris expandable.** Klik baris SN → muncul panel
  detail berisi timeline tanggal: Diterima → Install (di site X) →
  Replacement → Dikirim ke Warehouse → Return ke Customer. Tanggal yang
  kosong tampil "—". Ini menjaga tabel tetap ringkas.
- **Opsi B: kolom tambahan.** Tambah kolom "Tanggal" yang menampilkan
  ringkasan (mis. tanggal terima) dengan tooltip berisi selengkapnya. Lebih
  sempit tapi kurang lengkap.

**Aturan tampilan**:
- Format tanggal `YYYY-MM-DD` (apa adanya dari DB) atau format lokal Indonesia
  bila mudah — konsisten dengan bagian lain `App.jsx`.
- Tanggal null → tampil "—", jangan "null" atau kosong membingungkan.
- Beri label jelas dalam Bahasa Indonesia: "Tanggal Terima", "Tanggal Install",
  "Lokasi Install", "Tanggal Replacement", "Dikirim ke Warehouse Terex",
  "Return ke Customer".
- Ikuti pola styling komponen sekitarnya (Tailwind, warna emerald/gray yang
  sudah dipakai). Gunakan `React.useEffect` bila perlu (bukan bare useEffect).

**Verifikasi**: buka Warehouse Stock → material MSG yang punya unit Faulty
(mis. Adaptor Modem Hughes HT3300) → Lihat SN → buka detail unit → kelima
tanggal tampil, yang kosong jadi "—".

---

## TUGAS 3 — Hapus endpoint admin sementara (PENUTUP, setelah 1 & 2 selesai)

**Kenapa**: endpoint `/api/admin/*` (import, sync-stock, dan backup-db kalau
dibuat) hanya untuk sekali pakai. Membiarkannya hidup = risiko keamanan
(siapa pun dengan akun Manager bisa menimpa/menghapus data massal).

**Yang dihapus**:
1. File `routes/adminImport.js` — hapus seluruh file (atau kosongkan router-nya).
2. `server.js` — hapus baris mount:
   `app.use("/api/admin", require("./routes/adminImport"));`
3. File helper `importMsgCore.js` (root) — boleh dihapus juga (hanya dipakai
   oleh adminImport). Simpan salinannya di luar repo kalau mungkin perlu
   import lagi nanti.

**JANGAN hapus**: 3 kolom tanggal di `db.js`, perbaikan `utils/ids.js`
(MAX+1), fitur cluster, dan perubahan dashboard — semua itu permanen.

**Verifikasi**: setelah deploy, `POST /api/admin/import-msg` harus mengembalikan
404 (route sudah tidak ada), dan backend tetap listening normal (tidak crash).

---

## Catatan deploy untuk semua tugas

- Commit terpisah per tugas, pesan jelas.
- Push ke `main` → Railway auto-deploy. Cek deploy log: ada
  `TEREX Logistics backend listening`, tidak ada error modul.
- Frontend (Tugas 2): hard refresh Ctrl+Shift+R setelah deploy.
- Kalau backend crash setelah deploy, cek dulu path `require` di route baru
  (harus `../` dari dalam `routes/`).
