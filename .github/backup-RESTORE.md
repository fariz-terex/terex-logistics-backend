# Backup database TEREX Logistics

Repo ini diisi otomatis oleh GitHub Actions `Backup terex.db` di repo
`terex-logistics-backend`, sekali sehari (~02:17 WIB).

- **`terex-latest.db.gz`** — snapshot terbaru (gzip dari file SQLite `terex.db`).
- Setiap backup harian = **satu commit**. Riwayat git menyimpan SEMUA versi,
  jadi retensi praktis tak terbatas. Pesan commit memuat tanggal, ukuran, dan
  sha256.

## Mengambil backup TERBARU

```bash
git clone https://github.com/<owner>/<repo-ini>.git
cd <repo-ini>
gunzip -k terex-latest.db.gz          # menghasilkan terex-latest.db
```

## Mengambil backup dari TANGGAL tertentu

```bash
# lihat semua commit backup
git log --format='%h  %ci  %s' -- terex-latest.db.gz

# ambil versi per tanggal (mis. sampai 15 Agustus 2026)
SHA=$(git log --until=2026-08-16 -1 --format=%H -- terex-latest.db.gz)
git show "$SHA:terex-latest.db.gz" > terex-2026-08-15.db.gz
gunzip terex-2026-08-15.db.gz
```

## Verifikasi isi backup (butuh Node 22+)

```bash
node verify-backup.js terex-latest.db
```

(skrip `verify-backup.js` ada di `scripts/` repo backend, atau di komputer
Fariz — cek header SQLite + jumlah unit MSG ~418 + tabel lain berisi data.)

## Restore ke produksi (Railway)

1. Verifikasi file `.db` dulu (langkah di atas).
2. Stop service backend di Railway (biar tidak ada tulisan masuk).
3. Ganti `/data/terex.db` di volume dengan file hasil restore (via `railway ssh`
   / `railway run`, atau endpoint upload sementara — hati-hati, ini menimpa data).
4. Hapus `/data/terex.db-wal` dan `/data/terex.db-shm` kalau ada.
5. Start service, cek `GET /api/health` dan data tampil benar.

> Restore = menimpa data produksi. Ambil backup baru dulu sebelum restore,
> supaya kondisi "sebelum restore" tetap tersimpan.
