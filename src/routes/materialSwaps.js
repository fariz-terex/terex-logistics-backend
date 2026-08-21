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
    // A swap has no division of its own — scope it via the old unit's
    // division at the time of the swap, same as everything else SN-based.
    rows = db.prepare(`
      SELECT ms.* FROM material_swaps ms
      JOIN serial_numbers sn ON sn.sn = ms.old_sn
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

// The core action: swap a faulty Installed unit at a site for a new one.
// Old unit -> Faulty (ready to be picked up in a Return Material Faulty
// submission — this endpoint doesn't do that shipping/paperwork itself,
// it just flips the status and records the swap for traceability).
// New unit -> Installed at the same site, same as a normal install
// confirmation would do.
router.post("/", requireAuth, requireRole(TECH, LOGISTICS, MANAGER), (req, res) => {
  const { oldSn, newSn, site, homebase, photo, note } = req.body || {};
  if (!oldSn?.trim() || !newSn?.trim()) return res.status(400).json({ error: "Pilih unit lama dan unit pengganti" });
  if (!photo) return res.status(400).json({ error: "Foto bukti penggantian wajib diisi" });

  const oldRow = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(oldSn.trim());
  if (!oldRow) return res.status(404).json({ error: `Serial Number ${oldSn} tidak ditemukan` });
  if (oldRow.status !== "Installed") return res.status(409).json({ error: `Unit ${oldSn} tidak sedang berstatus Installed (status saat ini: ${oldRow.status})` });

  const newRow = db.prepare("SELECT * FROM serial_numbers WHERE sn = ?").get(newSn.trim());
  if (!newRow) return res.status(404).json({ error: `Serial Number ${newSn} tidak ditemukan` });
  if (newRow.status !== "Delivered") return res.status(409).json({ error: `Unit pengganti ${newSn} harus berstatus Delivered (status saat ini: ${newRow.status})` });

  if (!scopeAllows(scopeOf(req.user), oldRow.customer)) return res.status(403).json({ error: "Unit ini bukan milik divisi Anda" });

  const resolvedSite = site?.trim() || oldRow.install_site || "";
  const id = dailySequenceId(db, "material_swaps", "SW");

  const tx = db.transaction(() => {
    db.prepare("UPDATE serial_numbers SET status = 'Installed', installed_date = ?, installed_by = ?, install_photo = ?, install_site = ? WHERE sn = ?")
      .run(isoDate(), req.user.name, photo, resolvedSite, newRow.sn);
    db.prepare("UPDATE serial_numbers SET status = 'Faulty', current_ref = ? WHERE sn = ?")
      .run(id, oldRow.sn);
    db.prepare(`INSERT INTO material_swaps (id, site, homebase, old_sn, old_material, new_sn, new_material, performed_by, date, photo, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, resolvedSite, homebase?.trim() || "", oldRow.sn, oldRow.material, newRow.sn, newRow.material, req.user.name, isoDate(), photo, note || "");
  });
  tx();

  res.status(201).json({
    id, site: resolvedSite, homebase: homebase?.trim() || "",
    oldSn: oldRow.sn, oldMaterial: oldRow.material, newSn: newRow.sn, newMaterial: newRow.material,
    performedBy: req.user.name, date: isoDate(), photo, note: note || "",
  });
});

module.exports = router;
