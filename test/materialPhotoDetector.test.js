// No network calls here — `global.fetch` is stubbed with a canned Claude
// response so these exercise the hallucination-defense whitelist (the part
// that actually matters to get right) without hitting the real API, same
// spirit as this repo's other pure-logic tests.
const test = require("node:test");
const assert = require("node:assert/strict");

const ONE_PX_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function withStubbedFetch(claudeResponseText, fn) {
  const originalFetch = global.fetch;
  const originalKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  global.fetch = async () => ({
    ok: true,
    json: async () => ({ content: [{ text: claudeResponseText }] }),
  });
  return Promise.resolve(fn()).finally(() => {
    global.fetch = originalFetch;
    process.env.ANTHROPIC_API_KEY = originalKey;
    delete require.cache[require.resolve("../src/utils/materialPhotoDetector")];
  });
}

test("detectMaterialsFromPhotos keeps only materials in the given whitelist", async () => {
  const { detectMaterialsFromPhotos } = require("../src/utils/materialPhotoDetector");
  await withStubbedFetch(
    JSON.stringify({
      items: [
        { material: "Antenna Sector", qty: 3, confidence: "tinggi", note: "" },
        { material: "Barang Yang Tidak Ada Di Katalog", qty: 5, confidence: "tinggi", note: "" }, // hallucinated — not in whitelist
      ],
    }),
    async () => {
      const result = await detectMaterialsFromPhotos([ONE_PX_PNG], { materialNames: ["Antenna Sector", "Kabel Feeder"] });
      assert.deepEqual(result.items, [{ material: "Antenna Sector", qty: 3, confidence: "tinggi", note: "" }]);
    }
  );
});

test("detectMaterialsFromPhotos drops items with no material match", async () => {
  const { detectMaterialsFromPhotos } = require("../src/utils/materialPhotoDetector");
  await withStubbedFetch(
    JSON.stringify({ items: [{ material: null, qty: 2, confidence: "tidak_ada", note: "tidak jelas" }] }),
    async () => {
      const result = await detectMaterialsFromPhotos([ONE_PX_PNG], { materialNames: ["Antenna Sector"] });
      assert.deepEqual(result.items, []);
    }
  );
});

test("detectMaterialsFromPhotos rounds/clamps qty and normalizes confidence", async () => {
  const { detectMaterialsFromPhotos } = require("../src/utils/materialPhotoDetector");
  await withStubbedFetch(
    JSON.stringify({ items: [{ material: "Antenna Sector", qty: -3.7, confidence: "bogus", note: 123 }] }),
    async () => {
      const result = await detectMaterialsFromPhotos([ONE_PX_PNG], { materialNames: ["Antenna Sector"] });
      assert.deepEqual(result.items, [{ material: "Antenna Sector", qty: 0, confidence: "tidak_ada", note: "123" }]);
    }
  );
});

test("detectMaterialsFromPhotos rejects when ANTHROPIC_API_KEY is not set", async () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete require.cache[require.resolve("../src/utils/materialPhotoDetector")];
  const { detectMaterialsFromPhotos } = require("../src/utils/materialPhotoDetector");
  await assert.rejects(
    () => detectMaterialsFromPhotos([ONE_PX_PNG], { materialNames: ["Antenna Sector"] }),
    /belum dikonfigurasi/
  );
  process.env.ANTHROPIC_API_KEY = originalKey;
  delete require.cache[require.resolve("../src/utils/materialPhotoDetector")];
});

test("detectMaterialsFromPhotos rejects with no photos or too many photos", async () => {
  await withStubbedFetch(JSON.stringify({ items: [] }), async () => {
    const { detectMaterialsFromPhotos } = require("../src/utils/materialPhotoDetector");
    await assert.rejects(() => detectMaterialsFromPhotos([], { materialNames: ["Antenna Sector"] }), /Minimal satu foto/);
    await assert.rejects(
      () => detectMaterialsFromPhotos(new Array(7).fill(ONE_PX_PNG), { materialNames: ["Antenna Sector"] }),
      /Maksimal 6 foto/
    );
  });
});
