// Reads an uploaded BKB (Bukti/Berita Kirim Barang) — a photo or PDF of a
// goods-receipt shipping document — via the Claude API and extracts the
// line items on it (material name as written, qty, serial numbers if
// listed, any note), plus a best-effort guess at the destination division.
// Claude is given the actual Master Material and division names that exist
// in this system and asked to match against THOSE (handles reordered
// words, abbreviations, different punctuation — the exact kind of drift a
// plain string-similarity check misses), never asked to invent one.
// Never touches stock itself; the caller always shows the result to a
// human for review before anything gets submitted through the normal
// POST /receipts endpoint.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const isConfigured = () => !!process.env.ANTHROPIC_API_KEY;

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  if (!m) { const err = new Error("Format dokumen tidak valid"); err.status = 400; throw err; }
  return { mimeType: m[1], base64: m[2] };
}

function buildPrompt(materialNames, divisionNames) {
  const materialList = materialNames.map((n) => `- ${n}`).join("\n");
  const divisionList = divisionNames.map((n) => `- ${n}`).join("\n");
  return `Anda membantu membaca dokumen BKB (Bukti/Berita Kirim Barang) atau surat jalan penerimaan barang gudang logistik. Baca dokumen terlampir.

DAFTAR MASTER MATERIAL YANG VALID DI SISTEM (nama di dokumen bisa berbeda urutan kata/singkatan/tanda baca dari daftar ini — cocokkan berdasarkan makna, bukan kecocokan huruf persis):
${materialList}

DAFTAR DIVISI YANG VALID DI SISTEM:
${divisionList}

Tugas Anda:
1. Tentukan divisi tujuan penerimaan barang ini berdasarkan isi dokumen (kop surat, nama pengirim/penerima, referensi site/project, catatan, dll). Jawab HANYA salah satu nama persis dari DAFTAR DIVISI di atas, atau null jika sama sekali tidak yakin.
2. Untuk SETIAP baris barang di dokumen, ekstrak:
   - "rawMaterial": nama barang PERSIS seperti tertulis di dokumen (jangan diterjemahkan/disingkat)
   - "matchedMaterial": nama yang paling cocok dari DAFTAR MASTER MATERIAL di atas — HARUS disalin PERSIS karakter demi karakter dari daftar itu (bukan dari dokumen). Kalau benar-benar tidak ada yang cocok maknanya, isi null. JANGAN mengarang nama yang tidak ada di daftar.
   - "confidence": "tinggi" kalau yakin cocok, "rendah" kalau hanya perkiraan, "tidak_ada" kalau matchedMaterial null
   - "qty": jumlah unit yang diterima (angka)
   - "serials": array nomor seri/SN jika tercantum untuk barang ini (array kosong jika tidak ada/tidak berlaku)
   - "note": catatan tambahan pada baris itu jika ada (kondisi, nomor PO/BKB, dll) — string kosong jika tidak ada

Balas HANYA dengan JSON valid, tanpa penjelasan atau teks lain, persis format ini:
{"division": "...", "items": [{"rawMaterial": "...", "matchedMaterial": "...", "confidence": "...", "qty": 0, "serials": [], "note": "..."}]}

Jika dokumen tidak terbaca sama sekali atau tidak berisi daftar barang, balas: {"division": null, "items": []}`;
}

async function callClaude(mimeType, base64, prompt) {
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
            { type: "text", text: prompt },
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

function parseResponse(text) {
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
  return {
    division: parsed.division == null ? null : String(parsed.division).trim(),
    items: parsed.items
      .map((it) => ({
        rawMaterial: String(it.rawMaterial || "").trim(),
        matchedMaterial: it.matchedMaterial == null ? null : String(it.matchedMaterial).trim(),
        confidence: ["tinggi", "rendah", "tidak_ada"].includes(it.confidence) ? it.confidence : "tidak_ada",
        qty: Number(it.qty) || 0,
        serials: Array.isArray(it.serials) ? it.serials.map((s) => String(s).trim()).filter(Boolean) : [],
        note: String(it.note || "").trim(),
      }))
      .filter((it) => it.rawMaterial),
  };
}

// materials/divisions: the actual Active names in this system, given to
// Claude as the only valid targets it may match against.
async function parseBkbDocument(dataUrl, { materialNames, divisionNames }) {
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
  const text = await callClaude(mimeType, base64, buildPrompt(materialNames, divisionNames));
  const result = parseResponse(text);

  // Defense against hallucination: only trust a matchedMaterial/division
  // that's an EXACT match to a name we actually gave Claude — anything
  // else (a name it invented or slightly altered) is treated the same as
  // "no match", never silently trusted.
  const materialSet = new Set(materialNames);
  const divisionSet = new Set(divisionNames);
  return {
    division: result.division && divisionSet.has(result.division) ? result.division : null,
    items: result.items.map((it) => ({
      ...it,
      matchedMaterial: it.matchedMaterial && materialSet.has(it.matchedMaterial) ? it.matchedMaterial : null,
      confidence: it.matchedMaterial && materialSet.has(it.matchedMaterial) ? it.confidence : "tidak_ada",
    })),
  };
}

module.exports = { parseBkbDocument, isConfigured };
