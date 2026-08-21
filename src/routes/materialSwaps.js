const express = require("express");
const db = require("../db");
const { requireAuth, requireRole } = require("../middleware/auth");
const { dailySequenceId, isoDate } = require("../utils/ids");
const { scopeOf, scopeAllows } = require("../utils/stock");

const router = express.Router();
const MANAGER = "Admin / Manager Logistics";
const LOGISTICS = "Logistics Staff";
const SPV = "SPV";
const TECH = "Technician";

router.get("/", requireAuth, (req, res) => {
  const scope = scopeOf(req.user);
  let rows;
  if (!scope) {
    rows = db.prepare("SELECT * FROM material_swaps ORDER BY id DESC").all();
  } else if (scope.length === 0) {
    rows = [];
  } else {
    // Scope via the NEW unit's division — that's always a real, tracked
    // serial_numbers row. The old/faulty unit may not be tracked at all,
    // so it can't reliably be used to scope visibility.
    rows = db.prepare(`
      SELECT ms.* FROM material_swaps ms
      JOIN serial_numbers sn ON sn.sn = ms.new_sn
      WHERE sn.customer IN (${scope.map(() => "?").join(",")})
      ORDER BY ms.id DESC
    `).all(...scope);
  }
  res.json(rows.map((r) => ({
    id: r.id, site: r.site, homebase: r.homebase, oldSn: r.old_sn, oldMaterial: r.old_material,
    newSn: r.new_sn, newMaterial: r.new_material, performedBy: r.performed_by, date: r.date,
    photo: r.photo, note: r.note, returnId: r.return_id,
  })));
});

// Confirms a Delivered unit as Installed at a site — this is now the ONLY
// place that happens (it used to also live inside Delivery Request, but
// that page is meant to track shipping status only, not what happens to
// the material afterward at the site).
//
// The unit being removed (if any) is deliberately NOT looked up or
// validated against the system: a technician pulling a faulty unit out of
// a site has no guarantee it was ever tracked here in the first place
// (could predate this system, or never have gone through a proper Delivery
// Request). It's recorded as plain text/material choice, and — if it DOES
// happen to match a known Serial Number — that unit is also flipped to
// Faulty as a bonus, but its absence from the system is never an error.
router.post("/", requireAuth, requireRole(TECH, LOGISTICS, MANAGER), (req, res) => {
  const { newSn, site, homebase, oldSn, oldMaterial, photo, note } = req.body || {};
  if (!newSn?.trim()) return res.status(400).json({ error: "Pilih unit yang akan dipasang" });
  if (!site?.trim()) return res.status(400).json({ error: "Site wajib diisi" });
  if (!photo) return res.status(400).json({ error: "Foto bukti pemasangan wajib diisi" });
  if (oldSn?.trim() && !oldMaterial?.trim()) return res.status(400).json({ error: "Pilih jenis material untuk unit lama yang dicabut" });

  const newRow = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(newSn.trim());
  if (!newRow) return res.status(404).json({ error: `Serial Number ${newSn} tidak ditemukan` });
  if (newRow.status !== "Delivered") return res.status(409).json({ error: `Unit ${newSn} harus berstatus Delivered (status saat ini: ${newRow.status})` });
  if (!scopeAllows(scopeOf(req.user), newRow.customer)) return res.status(403).json({ error: "Unit ini bukan milik divisi Anda" });

  const trimmedOldSn = oldSn?.trim() || null;
  const trimmedOldMaterial = trimmedOldSn ? oldMaterial.trim() : null;
  const id = dailySequenceId(db, "material_swaps", "SW");

  const tx = db.transaction(() => {
    db.prepare("UPDATE serial_numbers SET status = 'Installed', installed_date = ?, installed_by = ?, install_photo = ?, install_site = ? WHERE sn = ?")
      .run(isoDate(), req.user.name, photo, site.trim(), newRow.sn);

    if (trimmedOldSn) {
      // If this SN happens to already be tracked, close its loop properly.
      // If not, that's fine — it's still recorded on the swap itself.
      const existingOld = db.prepare("SELECT 1 FROM serial_numbers WHERE sn = ?").get(trimmedOldSn);
      if (existingOld) {
        db.prepare("UPDATE serial_numbers SET status = 'Faulty', current_ref = ?, material = ? WHERE sn = ?").run(id, trimmedOldMaterial, trimmedOldSn);
      }
    }

    db.prepare(`INSERT INTO material_swaps (id, site, homebase, old_sn, old_material, new_sn, new_material, performed_by, date, photo, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, site.trim(), homebase?.trim() || "", trimmedOldSn, trimmedOldMaterial, newRow.sn, newRow.material, req.user.name, isoDate(), photo, note || "");
  });
  tx();

  res.status(201).json({
    id, site: site.trim(), homebase: homebase?.trim() || "",
    oldSn: trimmedOldSn, oldMaterial: trimmedOldMaterial, newSn: newRow.sn, newMaterial: newRow.material,
    performedBy: req.user.name, date: isoDate(), photo, note: note || "",
  });
});

module.exports = router;
