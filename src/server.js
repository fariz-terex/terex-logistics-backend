require("dotenv").config();
const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth");
const materialRoutes = require("./routes/materials");
const masterDataRoutes = require("./routes/masterData");
const stockRoutes = require("./routes/stock");
const deliveryRoutes = require("./routes/deliveries");
const returnRoutes = require("./routes/returns");
const reconciliationRoutes = require("./routes/reconciliations");

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" })); // generous limit: base64 photos in the request body

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
  res.status(500).json({ error: "Internal server error", detail: err.message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`TEREX Logistics backend listening on http://localhost:${PORT}`);
});
