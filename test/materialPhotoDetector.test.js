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
        { material: "Antenna Sector", qty: 3, confidence: "tinggi", serials: ["SN-001"], note: "" },
        { material: "Barang Yang Tidak Ada Di Katalog", qty: 5, confidence: "tinggi", serials: [], note: "" }, // hallucinated — not in whitelist
      ],
    }),
    async () => {
      const result = await detectMaterialsFromPhotos([ONE_PX_PNG], { materialNames: ["Antenna Sector", "Kabel Feeder"] });
      assert.deepEqual(result.items, [{ material: "Antenna Sector", qty: 3, confidence: "tinggi", serials: ["SN-001"], serialPhotoIndexes: [null], photoIndexes: [], note: "" }]);
    }
  );
});

test("detectMaterialsFromPhotos drops items with no material match", async () => {
  const { detectMaterialsFromPhotos } = require("../src/utils/materialPhotoDetector");
  await withStubbedFetch(
    JSON.stringify({ items: [{ material: null, qty: 2, confidence: "tidak_ada", serials: [], note: "tidak jelas" }] }),
    async () => {
      const result = await detectMaterialsFromPhotos([ONE_PX_PNG], { materialNames: ["Antenna Sector"] });
      assert.deepEqual(result.items, []);
    }
  );
});

test("detectMaterialsFromPhotos rounds/clamps qty, normalizes confidence, and sanitizes serials", async () => {
  const { detectMaterialsFromPhotos } = require("../src/utils/materialPhotoDetector");
  await withStubbedFetch(
    JSON.stringify({ items: [{ material: "Antenna Sector", qty: -3.7, confidence: "bogus", serials: ["  SN-1  ", "", 42], note: 123 }] }),
    async () => {
      const result = await detectMaterialsFromPhotos([ONE_PX_PNG], { materialNames: ["Antenna Sector"] });
      assert.deepEqual(result.items, [{ material: "Antenna Sector", qty: 0, confidence: "tidak_ada", serials: ["SN-1", "42"], serialPhotoIndexes: [null, null], photoIndexes: [], note: "123" }]);
    }
  );
});

test("detectMaterialsFromPhotos defaults serials to an empty array when omitted or not an array", async () => {
  const { detectMaterialsFromPhotos } = require("../src/utils/materialPhotoDetector");
  await withStubbedFetch(
    JSON.stringify({ items: [{ material: "Antenna Sector", qty: 1, confidence: "tinggi", serials: "not-an-array", note: "" }] }),
    async () => {
      const result = await detectMaterialsFromPhotos([ONE_PX_PNG], { materialNames: ["Antenna Sector"] });
      assert.deepEqual(result.items, [{ material: "Antenna Sector", qty: 1, confidence: "tinggi", serials: [], serialPhotoIndexes: [], photoIndexes: [], note: "" }]);
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

test("detectMaterialsFromPhotos maps each material/SN to the photo it came from (1-based -> 0-based, out of range dropped)", async () => {
  const { detectMaterialsFromPhotos } = require("../src/utils/materialPhotoDetector");
  await withStubbedFetch(
    JSON.stringify({ items: [
      { material: "Antenna Sector", qty: 2, confidence: "tinggi", photos: [2], serials: [{ sn: "SN-A", photo: 2 }, { sn: "SN-B", photo: 3 }], note: "" },
      { material: "Kabel Feeder", qty: 1, confidence: "tinggi", photos: [1, 9], serials: [{ sn: "SN-C", photo: 7 }], note: "" },
    ] }),
    async () => {
      const result = await detectMaterialsFromPhotos([ONE_PX_PNG, ONE_PX_PNG, ONE_PX_PNG], { materialNames: ["Antenna Sector", "Kabel Feeder"] });
      assert.deepEqual(result.items[0].serialPhotoIndexes, [1, 2]);
      assert.deepEqual(result.items[0].photoIndexes, [1, 2]);
      assert.deepEqual(result.items[1].serials, ["SN-C"]);
      assert.deepEqual(result.items[1].serialPhotoIndexes, [null]);
      assert.deepEqual(result.items[1].photoIndexes, [0]);
    }
  );
});

test("readSerialsFromPhoto returns trimmed, de-duplicated serials and tolerates a code fence", async () => {
  const { readSerialsFromPhoto } = require("../src/utils/materialPhotoDetector");
  await withStubbedFetch("```json\n" + JSON.stringify({ serials: [" 34605JAE49 ", "34605JAE49", "", 7] }) + "\n```", async () => {
    assert.deepEqual(await readSerialsFromPhoto(ONE_PX_PNG), { serials: ["34605JAE49", "7"] });
  });
});

test("readSerialsFromPhoto returns an empty list when nothing is legible", async () => {
  const { readSerialsFromPhoto } = require("../src/utils/materialPhotoDetector");
  await withStubbedFetch(JSON.stringify({ serials: [] }), async () => {
    assert.deepEqual(await readSerialsFromPhoto(ONE_PX_PNG), { serials: [] });
  });
});
