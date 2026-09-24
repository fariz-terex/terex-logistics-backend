// No network: the SigV4 signer is checked against AWS's published presigned
// URL example, and photos.js against an in-memory fake store.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createObjectStore } = require("../src/utils/objectStore");
const { storePhoto, storePhotos, photoUrl, discardPhotos } = require("../src/utils/photos");

test("presignGet reproduces AWS's documented SigV4 presigned URL example", () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  const store = createObjectStore({
    bucket: "examplebucket", endpoint: "https://s3.amazonaws.com", region: "us-east-1",
    keyId: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  });
  const url = store.presignGet("test.txt", 86400, new Date("2013-05-24T00:00:00Z"));
  assert.ok(url.startsWith("https://examplebucket.s3.amazonaws.com/test.txt?"));
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
  assert.equal(store.keyFromUrl(url), "test.txt");
  assert.equal(store.keyFromUrl("https://evil.example.com/test.txt"), null);
});

test("putObject sends a signed PUT to the virtual-hosted URL", async () => {
  const calls = [];
  const store = createObjectStore({
    bucket: "b-123", endpoint: "https://t3.storageapi.dev", region: "auto", keyId: "KID", secret: "SECRET",
    fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, text: async () => "" }; },
  });
  await store.putObject("receipts/2026/09/a b.jpg", Buffer.from("x"), "image/jpeg");
  assert.equal(calls[0].url, "https://b-123.t3.storageapi.dev/receipts/2026/09/a%20b.jpg");
  assert.equal(calls[0].init.method, "PUT");
  assert.match(calls[0].init.headers.authorization, /^AWS4-HMAC-SHA256 Credential=KID\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
});

function fakeStore() {
  const objects = new Map();
  return {
    objects,
    putObject: async (key, body) => { objects.set(key, body); },
    deleteObject: async (key) => { objects.delete(key); },
    presignGet: (key) => `https://fake.bucket/${key}?sig=1`,
    keyFromUrl: (url) => (url.startsWith("https://fake.bucket/") ? url.slice("https://fake.bucket/".length).split("?")[0] : null),
  };
}
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("storePhoto uploads a data URL and returns an obj: ref; photoUrl presigns it", async () => {
  const store = fakeStore();
  const ref = await storePhoto(PNG, "receipts", store);
  assert.match(ref, /^obj:receipts\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
  assert.equal(store.objects.size, 1);
  assert.equal(photoUrl(ref, store), `https://fake.bucket/${ref.slice(4)}?sig=1`);
});

test("storePhoto maps an echoed presigned URL back to its ref without re-uploading", async () => {
  const store = fakeStore();
  assert.equal(await storePhoto("https://fake.bucket/receipts/x.png?sig=1", "receipts", store), "obj:receipts/x.png");
  assert.equal(store.objects.size, 0);
  await assert.rejects(() => storePhoto("https://elsewhere.com/x.png", "receipts", store), /tidak dikenali/);
});

test("storePhoto rejects non-images; legacy data URLs pass through photoUrl untouched", async () => {
  await assert.rejects(() => storePhoto("data:application/pdf;base64,AAAA", "receipts", fakeStore()), /harus berupa foto/);
  assert.equal(photoUrl(PNG, fakeStore()), PNG);
  assert.equal(photoUrl(null, fakeStore()), null);
});

test("storePhoto without a bucket keeps the data URL (local dev / tests)", async () => {
  assert.equal(await storePhoto(PNG, "receipts", null), PNG);
});

test("storePhotos keeps order; discardPhotos removes uploaded objects", async () => {
  const store = fakeStore();
  const refs = await storePhotos([PNG, PNG, PNG], "receipts", store, 2);
  assert.equal(refs.length, 3);
  assert.equal(new Set(refs).size, 3);
  await discardPhotos(refs, store);
  assert.equal(store.objects.size, 0);
});
