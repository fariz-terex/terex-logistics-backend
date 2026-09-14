// Reads an uploaded BKB (Bukti/Berita Kirim Barang) — a photo or PDF of a
// goods-receipt shipping document — via the Claude API and extracts the
// line items on it (material name as written, qty, serial numbers if
// listed, any note). Never touches stock itself; the caller always shows
// the result to a human for review before anything gets submitted through
// the normal POST /receipts endpoint.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const isConfigured = () => !!process.env.ANTHROPIC_API_KEY;

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  if (!m) { const err = new Error("Format dokumen tidak valid"); err.status = 400; throw err; }
  return { mimeType: m[1], base64: m[2] };
}

const PROMPT = `Anda membantu membaca dokumen BKB (Bukti/Berita Kirim Barang) atau surat jalan penerimaan barang gudang logistik. Baca dokumen terlampir dan ekstrak SETIAP baris barang yang tercantum di dalamnya.

Untuk setiap barang, catat:
- "material": nama barang persis seperti tertulis di dokumen (jangan diterjemahkan/disingkat)
- "qty": jumlah unit yang diterima (angka)
- "serials": array nomor seri/SN jika tercantum untuk barang ini di dokumen (array kosong jika tidak ada atau tidak berlaku untuk barang ini)
- "note": catatan tambahan pada baris itu jika ada (kondisi, nomor PO/BKB, dll) — string kosong jika tidak ada

Balas HANYA dengan JSON valid, tanpa penjelasan atau teks lain, persis format ini:
{"items": [{"material": "...", "qty": 0, "serials": [], "note": "..."}]}

Jika dokumen tidak terbaca sama sekali atau tidak berisi daftar barang, balas: {"items": []}`;

async function callClaude(mimeType, base64) {
  const contentBlockType = mimeType === "application/pdf" ? "document" : "image";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        messages: [{
          role: "user",
          content: [
            { type: contentBlockType, source: { type: "base64", media_type: mimeType, data: base64 } },
            { type: "text", text: PROMPT },
          ],
        }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const wrapped = new Error(err.name === "AbortError" ? "Timeout membaca dokumen BKB — coba lagi" : `Gagal menghubungi Claude API: ${err.message}`);
    wrapped.status = 502;
    throw wrapped;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Claude API error ${res.status}: ${detail.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }
  const data = await res.json();
  return (data.content || []).map((b) => b.text || "").join("");
}

function extractItems(text) {
  // The prompt asks for raw JSON, but strip markdown fences in case Claude
  // wraps it in one anyway.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const err = new Error("Gagal membaca hasil ekstraksi — format dari Claude tidak sesuai");
    err.status = 502;
    throw err;
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    const err = new Error("Hasil ekstraksi tidak sesuai format yang diharapkan");
    err.status = 502;
    throw err;
  }
  return parsed.items
    .map((it) => ({
      material: String(it.material || "").trim(),
      qty: Number(it.qty) || 0,
      serials: Array.isArray(it.serials) ? it.serials.map((s) => String(s).trim()).filter(Boolean) : [],
      note: String(it.note || "").trim(),
    }))
    .filter((it) => it.material);
}

async function parseBkbDocument(dataUrl) {
  if (!isConfigured()) {
    const err = new Error("Fitur deteksi BKB belum dikonfigurasi di server (ANTHROPIC_API_KEY belum di-set)");
    err.status = 503;
    throw err;
  }
  const { mimeType, base64 } = parseDataUrl(dataUrl);
  if (!/^image\//.test(mimeType) && mimeType !== "application/pdf") {
    const err = new Error("Format file harus foto (JPG/PNG) atau PDF");
    err.status = 400;
    throw err;
  }
  const text = await callClaude(mimeType, base64);
  return extractItems(text);
}

// Best-effort match of a raw, AI-read material name against the master
// list — same normalize-then-compare approach as the manual Sheet/TEREX
// name-mapping done earlier this project, just automated: exact match on
// a normalized (lowercased, punctuation-stripped) name first, then a loose
// substring match either direction. Returns null (no confident guess) if
// neither hits — the caller always lets a human pick from the dropdown.
function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function matchMaterial(rawName, materials) {
  const target = normalizeName(rawName);
  if (!target) return null;
  const exact = materials.find((m) => normalizeName(m.name) === target);
  if (exact) return { ...exact, confidence: "exact" };
  const fuzzy = materials.find((m) => {
    const n = normalizeName(m.name);
    return n.length > 3 && target.length > 3 && (n.includes(target) || target.includes(n));
  });
  if (fuzzy) return { ...fuzzy, confidence: "fuzzy" };
  return null;
}

module.exports = { parseBkbDocument, matchMaterial, isConfigured };
