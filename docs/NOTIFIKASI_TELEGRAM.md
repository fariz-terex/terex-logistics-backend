# Notifikasi Status Delivery ke Telegram (Lapis 2)

Backend mengirim event **setiap perubahan status Delivery Request** ke satu
webhook n8n. n8n memformat pesan dan mengirim ke grup Telegram. Lapis 1
(notifikasi in-app) tetap jalan independen — ini pelengkap untuk push.

## Alur

```
Backend TEREX ──POST──▶ n8n Webhook ──▶ Code (susun pesan) ──▶ Telegram (kirim ke grup)
```

Event yang dikirim (7): Menunggu Approval · Disetujui · Sedang Disiapkan ·
Dalam Pengiriman · Sampai (Delivered) · Ditolak · Dibatalkan.

## Payload yang dikirim backend

`POST` JSON ke `N8N_DELIVERY_WEBHOOK_URL`:

```json
{
  "event": "delivery.status_changed",
  "deliveryId": "DR-260909-001",
  "status": "Dalam Pengiriman",
  "customer": "MSG",
  "homebase": "Merauke",
  "site": "SDN 1 Merauke",
  "keperluan": "Instalasi",
  "itemCount": 3,
  "requester": "Rina",
  "actor": "Sari",
  "note": null,
  "timestamp": "2026-09-09"
}
```

`note` berisi alasan saat status **Ditolak / Dibatalkan**, atau nama penerima
saat **Delivered**.

## Setup (satu kali)

### 1. Bot & grup Telegram
Kalau belum ada, ikuti `Blueprint_Otomasi_n8n_Claude_TEREX.md` Bagian 1:
buat bot via `@BotFather`, buat grup, undang bot, ambil **Chat ID** grup
(angka negatif) dari `https://api.telegram.org/bot<TOKEN>/getUpdates`.

### 2. Import workflow ke n8n
1. n8n → **Workflows** → **Import from File** → pilih
   [`docs/n8n-delivery-telegram.json`](n8n-delivery-telegram.json).
2. Node **Kirim Telegram**:
   - **Credential**: buat/pilih *Telegram API* dengan Bot Token.
   - **Chat ID**: ganti `GANTI_DENGAN_CHAT_ID` dengan Chat ID grup.
3. **Save**, lalu **Activate** (toggle kanan atas).
4. Klik node **Webhook** → salin **Production URL** (mis.
   `https://n8n-anda.domain/webhook/terex-delivery-status`).

> Kalau import bermasalah karena versi n8n, buat manual — cuma 3 node:
> **Webhook** (POST, path `terex-delivery-status`) → **Code** (tempel isi
> `jsCode` dari file JSON) → **Telegram** (`sendMessage`, Chat ID grup,
> Text = `{{ $json.message }}`, parse_mode `HTML`).

### 3. Set env var di Railway
Backend service → **Variables** → tambah:

```
N8N_DELIVERY_WEBHOOK_URL = https://n8n-anda.domain/webhook/terex-delivery-status
```

Railway auto-redeploy. **Kalau var ini tidak di-set, fitur mati total** —
tidak ada yang dikirim, tidak ada error. (Sengaja terpisah dari
`N8N_WEBHOOK_URL` yang dipakai workflow sinkronisasi Google Sheet.)

### 4. Tes
1. Buat Delivery Request baru di TEREX → dalam beberapa detik pesan
   "⏳ Delivery DR-xxx — Menunggu Approval" masuk ke grup Telegram.
2. Approve / ship / dst → tiap langkah kirim pesan.
3. Cek n8n → **Executions** kalau pesan tidak muncul (lihat error node mana).

## Catatan

- Fire-and-forget dengan timeout 5 detik: webhook lambat/gagal **tidak**
  memperlambat atau menggagalkan aksi user di TEREX. Kegagalan hanya
  tercatat di log backend (`[webhook] failed ...`).
- Mau DM per-user (bukan grup)? Perlu kolom `telegram_chat_id` di tabel
  users + tiap user `/start` ke bot sekali. Belum dibuat — grup dulu.
- Mau pisah per divisi? Duplikat workflow, tambah **IF** `{{ $json.body.customer }}`
  di depan node Telegram, arahkan ke Chat ID grup masing-masing. Atau satu
  grup dengan Topics.
