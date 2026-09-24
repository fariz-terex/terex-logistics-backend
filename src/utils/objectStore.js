// Minimal S3 client for the Railway Storage Bucket (S3-compatible, private):
// PUT / DELETE an object and build presigned GET URLs so the browser can
// show a photo without the bucket being public. Hand-rolled AWS Signature
// V4 (node:crypto + fetch) instead of @aws-sdk — three operations don't
// justify a large dependency tree, and the signer is checked against AWS's
// published presigned-URL example in test/objectStore.test.js.
//
// Config comes from env vars wired to the bucket via Railway variable
// references: PHOTO_BUCKET, PHOTO_BUCKET_ENDPOINT, PHOTO_BUCKET_REGION,
// PHOTO_BUCKET_KEY_ID, PHOTO_BUCKET_SECRET.
const crypto = require("node:crypto");

const sha256Hex = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

// RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone).
function uriEncode(str, keepSlash) {
  const encoded = encodeURIComponent(str).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return keepSlash ? encoded.replace(/%2F/g, "/") : encoded;
}

function amzDates(now) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // 20130524T000000Z
  return { amzDate: iso, dateStamp: iso.slice(0, 8) };
}

function createObjectStore({ bucket, endpoint, region, keyId, secret, fetchImpl = globalThis.fetch }) {
  const endpointUrl = new URL(endpoint);
  // Virtual-hosted style (bucket as subdomain), per Railway's docs.
  const host = `${bucket}.${endpointUrl.host}`;
  const origin = `${endpointUrl.protocol}//${host}`;

  function signingKey(dateStamp) {
    return hmac(hmac(hmac(hmac("AWS4" + secret, dateStamp), region), "s3"), "aws4_request");
  }

  function sign({ method, path, query, headers, payloadHash, amzDate, dateStamp }) {
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
    const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
    const signedHeaders = names.join(";");
    const canonicalQuery = Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`).join("&");
    const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signature = crypto.createHmac("sha256", signingKey(dateStamp)).update(stringToSign).digest("hex");
    return { scope, signedHeaders, signature, canonicalQuery };
  }

  const objectPath = (key) => "/" + uriEncode(key, true);

  async function putObject(key, body, contentType) {
    const { amzDate, dateStamp } = amzDates(new Date());
    const payloadHash = sha256Hex(body);
    const path = objectPath(key);
    const headers = { host, "content-type": contentType, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    const { scope, signedHeaders, signature } = sign({ method: "PUT", path, query: {}, headers, payloadHash, amzDate, dateStamp });
    const res = await fetchImpl(origin + path, {
      method: "PUT",
      headers: {
        "content-type": contentType,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body,
    });
    if (!res.ok) throw new Error(`Upload foto ke bucket gagal (${res.status}): ${(await res.text().catch(() => "")).slice(0, 200)}`);
  }

  async function deleteObject(key) {
    const { amzDate, dateStamp } = amzDates(new Date());
    const payloadHash = sha256Hex("");
    const path = objectPath(key);
    const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
    const { scope, signedHeaders, signature } = sign({ method: "DELETE", path, query: {}, headers, payloadHash, amzDate, dateStamp });
    const res = await fetchImpl(origin + path, {
      method: "DELETE",
      headers: { "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
    });
    if (!res.ok && res.status !== 404) throw new Error(`Hapus foto di bucket gagal (${res.status})`);
  }

  // `now` is injectable only so the AWS test vector can be reproduced.
  function presignGet(key, expiresSeconds = 3600, now = new Date()) {
    const { amzDate, dateStamp } = amzDates(now);
    const path = objectPath(key);
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const query = {
      "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
      "X-Amz-Credential": `${keyId}/${scope}`,
      "X-Amz-Date": amzDate,
      "X-Amz-Expires": String(expiresSeconds),
      "X-Amz-SignedHeaders": "host",
    };
    const { signature, canonicalQuery } = sign({ method: "GET", path, query, headers: { host }, payloadHash: "UNSIGNED-PAYLOAD", amzDate, dateStamp });
    return `${origin}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  // Maps a presigned URL we issued back to its object key (or null if it
  // isn't one of this bucket's URLs) — lets a form echo back a photo it was
  // shown (e.g. a resubmit) without re-uploading it.
  function keyFromUrl(url) {
    try {
      const u = new URL(url);
      if (u.host !== host) return null;
      return decodeURIComponent(u.pathname.slice(1)) || null;
    } catch {
      return null;
    }
  }

  return { putObject, deleteObject, presignGet, keyFromUrl, host };
}

let defaultStore;
function getObjectStore() {
  if (defaultStore !== undefined) return defaultStore;
  const { PHOTO_BUCKET, PHOTO_BUCKET_ENDPOINT, PHOTO_BUCKET_REGION, PHOTO_BUCKET_KEY_ID, PHOTO_BUCKET_SECRET } = process.env;
  defaultStore = PHOTO_BUCKET && PHOTO_BUCKET_ENDPOINT && PHOTO_BUCKET_KEY_ID && PHOTO_BUCKET_SECRET
    ? createObjectStore({ bucket: PHOTO_BUCKET, endpoint: PHOTO_BUCKET_ENDPOINT, region: PHOTO_BUCKET_REGION || "auto", keyId: PHOTO_BUCKET_KEY_ID, secret: PHOTO_BUCKET_SECRET })
    : null;
  return defaultStore;
}

module.exports = { createObjectStore, getObjectStore };
