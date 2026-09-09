# Sync TEREX → Google Sheet (STATUS PERANGKAT)

Ketika sebuah unit berubah status di TEREX, tulis otomatis ke kolom
**STATUS PERANGKAT** di file bulanan Google Sheet divisi (MSG & RGR),
dicocokkan lewat kolom **NO SN**.

```
TEREX (backend)  ──POST──▶  n8n Webhook  ──▶  cari file bulan ini di Drive
                                          ──▶  cari baris NO SN di tab Keluar / Masuk
                                          ──▶  update STATUS PERANGKAT
                                          └──▶  kalau gagal: alert Telegram
```

## Event & nilai yang ditulis

| Event TEREX | Kapan | STATUS PERANGKAT |
|---|---|---|
| `faulty_confirmed` | unit dikonfirmasi Faulty (lewat Return Faulty → Complete) | `Faulty` |
| `sent_to_customer` | unit Faulty dikirim ke customer | `Return` |
| `received_from_customer` | unit diterima kembali dari customer | `Ready` |

Divisi selain **MSG / RGR** dan event lain (mis. `stock-drift`) diabaikan.

## Yang backend kirim

`POST` JSON ke `N8N_WEBHOOK_URL`:
```json
{ "event": "faulty_confirmed", "sn": "34604PB3D4", "material": "Modem HT3300",
  "division": "MSG", "performedBy": "Rina", "timestamp": "2026-09-09" }
```
(`ref` ikut untuk event sent/received.)

---

## Setup

### 0. Prasyarat
- n8n aktif, punya **Credential Google** (Drive + Sheets, akun yang punya akses
  ke folder Drive MSG & RGR) dan **Credential Telegram** (bot untuk alert).
- Chat ID grup Telegram Logistik (untuk alert kalau sync gagal).

### 1. Import workflow
n8n → **Workflows** → **Import from File** →
[`docs/n8n-terex-to-sheet.json`](n8n-terex-to-sheet.json).
Workflow masuk dalam keadaan **non-aktif** dan penuh placeholder.

### 2. Node **Setup** — isi 2 folder ID
Buka node `Setup`, di bagian atas kode ganti:
```js
const FOLDER_ID = {
  MSG: "GANTI_FOLDER_ID_DRIVE_MSG",   // ← ID folder Drive tempat file bulanan MSG
  RGR: "GANTI_FOLDER_ID_DRIVE_RGR",
};
```
ID folder = bagian akhir URL folder Drive:
`drive.google.com/drive/folders/`**`1AbC...xyz`** ← itu ID-nya.

Kalau nilai `STATUS PERANGKAT` per event mau beda, edit `STATUS_BY_EVENT` di
kode yang sama.

### 3. Node **Cari File Bulan Ini** (Google Drive)
- Pilih **Credential** Google Drive.
- Query sudah otomatis: cari spreadsheet yang **namanya mengandung nama bulan
  sekarang** (mis. `Juni`) di folder divisi. Ini sengaja pakai "contains" biar
  tahan ke pola `Update Material 2026 Week 2 Juni` (MSG) **dan**
  `Update Material 2026 Juni RGR` (RGR).
- Kalau di folder ada >1 file dengan nama bulan sama, rapikan Drive (arsipkan
  yang lama) — node ini ambil 1 hasil saja.

### 4. Node Google Sheets (4 buah: Cek/Update × Keluar/Masuk)
Untuk **tiap** node Sheets:
- Pilih **Credential** Google Sheets.
- **Document**: biarkan — sudah `={{ $('Cari File Bulan Ini').item.json.id }}`.
- **Sheet / Tab**: pilih dari dropdown. Patokan sudah diisi:
  `03. Data Barang Keluar` dan `02.Data Barang Masuk`. Kalau nama tab beda,
  pilih yang benar.
- **Header Row**: **6** (baris judul kolom NO SN, STATUS PERANGKAT, dst).
  Di Options → "Data Location on Sheet" → Header Row. Sesuaikan kalau tab
  Masuk & Keluar beda barisnya.
- **Kolom pencocokan**: `NO SN`. **Kolom yang ditulis**: `STATUS PERANGKAT`.
  Kalau nama kolom di sheet Anda beda persis, betulkan di node Cek (lookupColumn)
  dan Update (matching + value).

### 5. Node Telegram (2 buah: "file tidak ada" & "SN tidak ketemu")
- Pilih **Credential** Telegram.
- **Chat ID**: ganti `GANTI_CHAT_ID_GRUP_LOGISTIK` dengan Chat ID grup Logistik.

### 6. Aktifkan & ambil URL webhook
- **Save** → **Activate** (toggle kanan atas).
- Klik node **Webhook (dari TEREX)** → salin **Production URL**, contoh:
  `https://n8n-anda.domain/webhook/terex-push-update`

### 7. Set env var di Railway
Backend service → **Variables**:
```
N8N_WEBHOOK_URL = https://n8n-anda.domain/webhook/terex-push-update
```
> `N8N_WEBHOOK_URL` juga dipakai event `stock-drift` — tidak masalah, workflow
> ini mengabaikannya. Jangan campur dengan `N8N_DELIVERY_WEBHOOK_URL`
> (notifikasi delivery) — itu URL & workflow berbeda.

`AUTOMATION_API_KEY` **tidak** dipakai di sini (itu untuk arah sebaliknya,
Sheet → TEREX).

### 8. Tes
1. Di TEREX, ambil 1 unit MSG yang **NO SN-nya benar-benar ada** sebagai baris
   di file bulan ini (tab Keluar), status masih Ready/Delivered.
2. Buat Return Faulty untuk unit itu → proses sampai **Complete**.
3. Dalam beberapa detik: kolom STATUS PERANGKAT baris SN itu jadi `Faulty`.
4. n8n → **Executions** kalau tidak jalan (lihat node mana yang merah).
5. Tes jalur gagal: pakai SN yang tidak ada di sheet → harus muncul alert
   Telegram "SN tidak ditemukan", bukan diam-diam gagal.

---

## Batasan & catatan

- **Baris SN harus sudah ada di sheet.** Workflow ini meng-*update*, tidak
  menambah baris. Kalau unit belum pernah tercatat di file bulan berjalan
  (mis. dikirim bulan lalu, Faulty bulan ini), SN tidak ketemu → alert
  Telegram → update manual. Ini sesuai keputusan Anda.
- **Nama file MSG pakai "Week N"** (`... Week 2 Juni`). Selama nama bulannya
  benar, workflow tetap ketemu (search by "contains Juni"). Tapi kalau MSG
  bikin file baru tiap minggu, unit dari minggu lalu tidak akan ada di file
  minggu ini — sama seperti poin di atas, jatuh ke alert manual. Pertimbangkan
  standarkan MSG jadi 1 file per bulan.
- **Fire-and-forget di sisi TEREX**: kalau n8n down / lambat, aksi user di
  TEREX tetap jalan normal (timeout 5 detik, kegagalan cuma masuk log backend
  `[webhook] failed`).
- **Tidak ada retry.** Sekali gagal (mis. n8n error), tidak diulang. Jejak
  event tetap ada di TEREX (`GET /api/automation/log` untuk yang lewat
  automation; untuk yang lewat web app, ada di stock_movements / history).
- **Update 2 tab**: cek tab Keluar dulu; kalau tidak ada, cek tab Masuk;
  kalau dua-duanya tidak ada → alert. Tidak menulis ke dua tab sekaligus.

## Troubleshooting

| Gejala | Kemungkinan |
|---|---|
| Tidak ada eksekusi di n8n sama sekali | `N8N_WEBHOOK_URL` belum di-set / salah, atau workflow belum di-Activate |
| Eksekusi jalan tapi berhenti di "Divisi & event didukung?" (FALSE) | Divisi bukan MSG/RGR, atau folder ID di node Setup masih placeholder |
| Node "Cari File Bulan Ini" hasil kosong → alert "file tidak ada" | Nama file di Drive tidak mengandung nama bulan Indonesia, atau folder ID salah, atau credential Google tidak punya akses folder |
| Node Sheets error "column not found" | Nama kolom (`NO SN` / `STATUS PERANGKAT`) atau Header Row (6) tidak cocok |
| Selalu jatuh ke "SN tidak ketemu" padahal SN ada | Header Row salah → n8n baca header dari baris yang salah; atau ada spasi/format beda di NO SN |
| Alert Telegram tidak terkirim | Credential/Chat ID Telegram salah; cek node Telegram di Executions |
