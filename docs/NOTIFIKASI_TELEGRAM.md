# Notifikasi Telegram (Lapis 2)

Setiap perubahan status Delivery Request dikirim sebagai **pesan pribadi (DM)**
dari bot Telegram langsung ke user yang relevan (requester + role terkait).
Backend memanggil Telegram API sendiri — **tidak perlu n8n** untuk ini.

Lapis 1 (notifikasi in-app di lonceng) tetap jalan independen.

## Siapa dapat notifikasi apa

| Event | Penerima |
|---|---|
| Request dibuat | semua Manager |
| Disetujui | requester + Logistics Staff divisi itu |
| Sedang disiapkan / dikirim / sampai | requester |
| Ditolak / dibatalkan | requester (+ Logistics kalau cancel melepas stok) |

Pelaku aksi tidak dapat notifikasi untuk aksinya sendiri.

## Setup server (satu kali)

### 1. Buat bot
`@BotFather` → `/newbot` → catat **token** dan **username bot** (mis. `terex_logistics_bot`).

### 2. Set env var di Railway (backend service → Variables)

```
TELEGRAM_BOT_TOKEN      = 123456789:ABCdef...
TELEGRAM_BOT_USERNAME   = terex_logistics_bot        (tanpa @)
TELEGRAM_WEBHOOK_SECRET = <string acak panjang, mis. dari `openssl rand -hex 24`>
```

Railway auto-redeploy. Tanpa `TELEGRAM_BOT_TOKEN` + `TELEGRAM_BOT_USERNAME`,
fitur mati (tombol "Hubungkan Telegram" di app menampilkan "belum diaktifkan").

### 3. Daftarkan webhook bot ke backend (satu kali)

Ganti `<TOKEN>` dan `<SECRET>` lalu buka URL ini di browser (atau `curl`):

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://backend-production-5543.up.railway.app/api/telegram/webhook/<SECRET>&secret_token=<SECRET>
```

Balasan `{"ok":true,"result":true,...}` = berhasil. Cek dengan:
```
https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```

> Catatan: satu bot hanya boleh punya **satu** webhook. Kalau bot ini juga
> dipakai n8n **Telegram Trigger**, jangan pakai `setWebhook` di sini — pakai
> bot terpisah, atau gunakan opsi grup n8n di bawah. (Workflow n8n yang cuma
> *mengirim* pesan / sendMessage tidak masalah, tidak merebut webhook.)

## Cara user menghubungkan (mandiri)

1. TEREX → **Settings** → kartu **Notifikasi Telegram** → **Hubungkan Telegram**.
2. Tab Telegram terbuka ke chat bot → klik **Start**.
3. Bot balas "✅ Terhubung". Kembali ke app → **Saya sudah klik Start**.
4. Selesai. Untuk berhenti: **Putuskan** di app, atau kirim `/stop` ke bot.

Kode tautan berlaku 15 menit dan sekali pakai.

## Tes

1. Hubungkan 2 akun (mis. SPV & Manager) ke Telegram masing-masing.
2. SPV buat Delivery Request → Manager terima DM "⏳ Delivery DR-xxx — Menunggu Approval".
3. Manager approve → SPV & Logistics divisi terima DM.
4. Cek log backend kalau tidak masuk: `[telegram] sendMessage ...`.

## Opsi tambahan: feed grup lewat n8n

Kalau juga mau satu grup Telegram yang menerima **semua** event (bukan DM),
set `N8N_DELIVERY_WEBHOOK_URL` di Railway dan import
[`n8n-delivery-telegram.json`](n8n-delivery-telegram.json) (Webhook → Code →
Telegram sendMessage ke chat grup). Backend mengirim payload terstruktur:

```json
{ "event": "delivery.status_changed", "deliveryId": "...", "status": "Disetujui",
  "customer": "MSG", "homebase": "...", "site": "...", "keperluan": "...",
  "itemCount": 3, "requester": "...", "actor": "...", "note": null, "timestamp": "..." }
```

DM dan grup bisa jalan bersamaan.

## Catatan teknis

- Semua pengiriman fire-and-forget, timeout 5 detik — Telegram lambat/error
  tidak memperlambat atau menggagalkan aksi user. Kegagalan hanya tercatat di
  log backend.
- Chat id disimpan di `users.telegram_chat_id`. User non-aktif tetap punya
  baris tapi tidak akan di-notify kalau resolver role tidak memilihnya.
- DM per divisi vs semua: sudah otomatis per-role/requester, tidak perlu
  konfigurasi.
