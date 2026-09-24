// Reads one or more photos of PHYSICAL MATERIALS/GOODS sitting at a
// homebase or warehouse (not a document/paper form — see bkbParser.js for
// that) via the Claude API and guesses which material(s) from this system's
// own catalog are visible, plus an estimated qty of each and — best-effort,
// never required — any Serial Number/barcode that's actually legible in
// the same photos, so a close-up shot of the units can skip retyping the SN
// too, not just the material picker. Same shape and same defenses as
// bkbParser.js (whitelist-only material matching, never trust an invented
// name; SNs are never invented either — an unreadable/missing label just
// means an empty serials array), reused across Reconciliation / Transfer
// Stock / Return Material Faulty's "Deteksi dari Foto" panels. Never
// touches the DB or any stock; the caller always shows the result to a
// human to review/complete before it goes through that flow's own normal
// submit endpoint.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const isConfigured = () => !!process.env.ANTHROPIC_API_KEY;

function parseDataUrl(dataUrl) {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl || "");
  if (!m) { const err = new Error("Format foto tidak valid"); err.status = 400; throw err; }
  return { mimeType: m[1], base64: m[2] };
}

function buildPrompt(materialNames) {
  const materialList = materialNames.map((n) => `- ${n}`).join("\n");
  return `Anda membantu mengidentifikasi material logistik dari FOTO BARANG FISIK (bukan dokumen/surat jalan) — foto material yang sedang berada di homebase atau gudang, untuk mempercepat pengisian form (Reconciliation, Transfer Stock, atau Return Material Faulty).

DAFTAR MASTER MATERIAL YANG VALID DI SISTEM:
${materialList}

Tugas Anda, dari SEMUA foto yang dilampirkan (anggap sebagai satu kumpulan, bisa saja beberapa foto adalah sudut berbeda dari barang yang sama):
1. Kenali jenis material apa saja yang terlihat di foto-foto ini, HANYA dari DAFTAR MASTER MATERIAL di atas — cocokkan berdasarkan kemiripan visual (bentuk, label, warna, ukuran), bukan membaca teks pada dokumen.
2. Untuk SETIAP jenis material yang teridentifikasi, perkirakan berapa jumlah unit yang terlihat.
3. Kalau ada label/stiker Serial Number atau barcode pada unit-unit tersebut yang BENAR-BENAR TERBACA JELAS di foto (bukan menebak), catat nomornya. Ini best-effort saja, bukan tugas utama — kalau tidak ada foto close-up label SN, atau tulisannya kabur/kekecilan/miring/silau, JANGAN dipaksakan dan JANGAN MENGARANG nomor — cukup biarkan kosong untuk material itu, user akan mengisi manual.

Untuk setiap material, hasilkan:
- "material": nama yang paling cocok dari DAFTAR MASTER MATERIAL — HARUS disalin PERSIS karakter demi karakter dari daftar itu. Kalau tidak yakin sama sekali material apa ini, JANGAN dimasukkan ke hasil (jangan mengarang nama yang tidak ada di daftar).
- "qty": perkiraan jumlah unit yang terlihat (angka bulat)
- "confidence": "tinggi" kalau yakin jenis materialnya, "rendah" kalau hanya perkiraan (termasuk kalau jumlahnya sulit dipastikan karena menumpuk/kecil-kecil)
- "serials": array Serial Number/barcode yang benar-benar terbaca jelas untuk unit-unit material ini (boleh kosong — JANGAN mengarang isinya, dan boleh kurang dari qty kalau hanya sebagian yang terbaca)
- "note": catatan singkat jika ada hal yang perlu diperhatikan user (mis. "jumlah sulit dipastikan, unit menumpuk", atau "SN tidak terbaca jelas, isi manual") — string kosong jika tidak ada

Balas HANYA dengan JSON valid, tanpa penjelasan atau teks lain, persis format ini:
{"items": [{"material": "...", "qty": 0, "confidence": "...", "serials": [], "note": "..."}]}

Jika tidak ada material yang bisa dikenali sama sekali dari daftar, balas: {"items": []}`;
}

async function callClaude(photos, prompt) {
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
            ...photos.map(({ mimeType, base64 }) => ({ type: "image", source: { type: "base64", media_type: mimeType, data: base64 } })),
            { type: "text", text: prompt },
          ],
        }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    const wrapped = new Error(err.name === "AbortError" ? "Timeout mendeteksi material dari foto — coba lagi" : `Gagal menghubungi Claude API: ${err.message}`);
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
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const err = new Error("Gagal membaca hasil deteksi — format dari Claude tidak sesuai");
    err.status = 502;
    throw err;
  }
  if (!parsed || !Array.isArray(parsed.items)) {
    const err = new Error("Hasil deteksi tidak sesuai format yang diharapkan");
    err.status = 502;
    throw err;
  }
  return {
    items: parsed.items
      .map((it) => ({
        material: it.material == null ? null : String(it.material).trim(),
        qty: Math.max(0, Math.round(Number(it.qty) || 0)),
        confidence: ["tinggi", "rendah", "tidak_ada"].includes(it.confidence) ? it.confidence : "tidak_ada",
        serials: Array.isArray(it.serials) ? it.serials.map((s) => String(s).trim()).filter(Boolean) : [],
        note: String(it.note || "").trim(),
      }))
      .filter((it) => it.material),
  };
}

// materialNames: the actual Active material names in this system, given to
// Claude as the only valid targets it may match against.
async function detectMaterialsFromPhotos(dataUrls, { materialNames }) {
  if (!isConfigured()) {
    const err = new Error("Fitur deteksi material dari foto belum dikonfigurasi di server (ANTHROPIC_API_KEY belum di-set)");
    err.status = 503;
    throw err;
  }
  if (!Array.isArray(dataUrls) || dataUrls.length === 0) {
    const err = new Error("Minimal satu foto diperlukan");
    err.status = 400;
    throw err;
  }
  if (dataUrls.length > 6) {
    const err = new Error("Maksimal 6 foto per deteksi");
    err.status = 400;
    throw err;
  }
  const photos = dataUrls.map((url) => {
    const { mimeType, base64 } = parseDataUrl(url);
    if (!/^image\//.test(mimeType)) {
      const err = new Error("Setiap file harus berupa foto (JPG/PNG)");
      err.status = 400;
      throw err;
    }
    return { mimeType, base64 };
  });

  const text = await callClaude(photos, buildPrompt(materialNames));
  const result = parseResponse(text);

  // Defense against hallucination: only trust a `material` that's an EXACT
  // match to a name we actually gave Claude — anything else (a name it
  // invented or slightly altered) is dropped rather than silently trusted.
  const materialSet = new Set(materialNames);
  return {
    items: result.items
      .filter((it) => materialSet.has(it.material))
      .map((it) => ({ ...it })),
  };
}

module.exports = { detectMaterialsFromPhotos, isConfigured };
