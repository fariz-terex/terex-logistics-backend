// Makes a retried write safe. The browser sends the same `Idempotency-Key`
// header when it repeats a request whose answer it never received (flaky
// connection: the server may well have processed it). The first successful
// answer is stored; any repeat with the same key gets that stored answer
// back instead of running the route again — so "Failed to fetch" followed by
// more clicks can no longer create 15 identical Delivery Requests.
//
// Keys are scoped to the caller (Authorization header) + method + URL, kept
// 24 hours. db is injected (node:sqlite in tests). Table: idempotency_keys.
const crypto = require("node:crypto");

const MAX_BODY_CHARS = 512 * 1024; // bigger answers aren't stored (no replay protection for those)
const KEEP_MS = 24 * 60 * 60 * 1000;
const SKIP = /^\/api\/auth(\/|$)/; // never store a login answer (it carries a token)

function scopedKey(req, key) {
  return crypto.createHash("sha256")
    .update(`${req.headers.authorization || ""}\n${req.method}\n${req.originalUrl}\n${key}`)
    .digest("hex");
}

function idempotency(db, { now = () => Date.now() } = {}) {
  const inFlight = new Map(); // scoped key -> promise settled when that request has answered

  return function handle(req, res, next) {
    const raw = req.headers["idempotency-key"];
    if (req.method === "GET" || req.method === "OPTIONS" || req.method === "HEAD") return next();
    if (typeof raw !== "string" || !/^[\w-]{8,100}$/.test(raw) || SKIP.test(req.originalUrl || "")) return next();
    const key = scopedKey(req, raw);

    const stored = db.prepare("SELECT status, body FROM idempotency_keys WHERE key = ?").get(key);
    if (stored) {
      res.set("Idempotent-Replay", "true");
      return res.status(stored.status).json(JSON.parse(stored.body));
    }
    // Same key still being processed (double click on a slow upload): wait
    // for it, then answer from what it stored — or run, if it failed.
    const pending = inFlight.get(key);
    if (pending) return pending.then(() => handle(req, res, next));

    let settle;
    const mine = new Promise((resolve) => { settle = resolve; });
    inFlight.set(key, mine);
    const finish = () => { if (inFlight.get(key) === mine) inFlight.delete(key); settle(); };
    res.on("finish", finish);
    res.on("close", finish);

    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          const text = JSON.stringify(body === undefined ? null : body);
          if (text.length <= MAX_BODY_CHARS) {
            const at = now();
            db.prepare("DELETE FROM idempotency_keys WHERE created_at < ?").run(at - KEEP_MS);
            db.prepare("INSERT OR IGNORE INTO idempotency_keys (key, status, body, created_at) VALUES (?, ?, ?, ?)")
              .run(key, res.statusCode, text, at);
          }
        } catch (err) {
          console.error(`[idempotency] could not store answer: ${err.message}`);
        }
      }
      return json(body);
    };
    next();
  };
}

module.exports = { idempotency, scopedKey };
