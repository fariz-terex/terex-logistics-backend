require("dotenv").config();
const express = require("express");
const cors = require("cors");
const db = require("./db");
const { seedDatabase } = require("./seed");

const authRoutes = require("./routes/auth");
const materialRoutes = require("./routes/materials");
const masterDataRoutes = require("./routes/masterData");
const stockRoutes = require("./routes/stock");
const deliveryRoutes = require("./routes/deliveries");
const returnRoutes = require("./routes/returns");
const reconciliationRoutes = require("./routes/reconciliations");

// First boot on a fresh volume: schema.sql already ran (via db.js) but every
// table is empty. Seed once, automatically — this never runs again once
// users exist, so it's safe to leave in place permanently (unlike a
// preDeployCommand, which would need to be manually added/removed).
const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
if (userCount === 0) {
  console.log("No users found — database looks empty, running initial seed...");
  seedDatabase();
}

const app = express();

// CORS: allow the deployed front-end plus local dev servers. Falls back to
// allow-all only if ALLOWED_ORIGINS isn't set, so this stays permissive
// during local development but locks down once deployed.
const defaultOrigins = [
  "https://frontend-production-4cc8.up.railway.app",
  "http://localhost:5173",
  "http://localhost:4173",
];
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",").map((o) => o.trim())
  : defaultOrigins;
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
}));
app.use(express.json({ limit: "30mb" })); // generous limit: base64 photos in the request body — frontend now also compresses images before upload

app.get("/api/health", (req, res) => res.json({ ok: true, service: "terex-logistics-backend" }));

app.use("/api/auth", authRoutes);
app.use("/api/materials", materialRoutes);
app.use("/api", masterDataRoutes); // /api/areas, /api/homebases, /api/customers, /api/sites, /api/users
app.use("/api/stock", stockRoutes);
app.use("/api/deliveries", deliveryRoutes);
app.use("/api/returns", returnRoutes);
app.use("/api/reconciliations", reconciliationRoutes);

// Centralized error handler: anything thrown synchronously inside a route
// (e.g. a SQLite constraint failure) lands here instead of crashing the process.
app.use((err, req, res, next) => {
  console.error(err);
  if (err.type === "entity.too.large" || err.status === 413) {
    return res.status(413).json({ error: "Ukuran data terlalu besar (kemungkinan foto belum terkompresi). Coba lagi dengan foto yang lebih kecil." });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: "Data yang dikirim tidak valid" });
  }
  res.status(err.status || err.statusCode || 500).json({ error: err.status ? err.message : "Internal server error", detail: err.message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`TEREX Logistics backend listening on http://localhost:${PORT}`);
});
