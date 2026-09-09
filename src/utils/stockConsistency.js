const { isoDate } = require("./ids");

const FIELDS = ["ready", "faulty", "reserved", "in_transit"];

// Read-only cross-check of the three places stock numbers live:
//   1. serial_numbers  — status per physical unit (serialized materials only)
//   2. material_stock   — per-division aggregate (what Warehouse Stock reads)
//   3. materials        — global aggregate (must equal the sum of #2)
//
// Writes NOTHING. Returns a report of every discrepancy found so a human (or
// a scheduled alert) can decide what to do. The actual "recompute and
// overwrite" action is deliberately not here — see TUGAS_PENGEMBANGAN.md #3.
//
// Note on the serial-vs-material_stock check: the normal app flow treats a
// unit as gone from stock once it is Delivered (`ready` counts status
// 'Ready' only). The MSG historical import instead counted
// `ready = Ready + Delivered` on purpose. So a `ready` gap on an MSG
// material that exactly equals its Delivered-unit count is expected, not
// corruption — those rows are tagged `matchesDeliveredInclusive: true` and
// kept out of the "real mismatch" count.
function computeStockConsistency(db) {
  db = db || require("../db");
  const materials = db.prepare("SELECT name, serialized, ready, faulty, reserved, in_transit FROM materials").all();
  const stockRows = db.prepare("SELECT material, customer, ready, faulty, reserved, in_transit FROM material_stock").all();
  const zero = () => ({ ready: 0, faulty: 0, reserved: 0, in_transit: 0 });

  // ---- Check 1: global aggregate vs sum of per-division rows ----
  const sumByMaterial = new Map();
  for (const r of stockRows) {
    if (!sumByMaterial.has(r.material)) sumByMaterial.set(r.material, zero());
    const s = sumByMaterial.get(r.material);
    for (const f of FIELDS) s[f] += r[f];
  }
  const globalVsDivisionSum = [];
  for (const m of materials) {
    const s = sumByMaterial.get(m.name) || zero();
    for (const f of FIELDS) {
      if (m[f] !== s[f]) {
        globalVsDivisionSum.push({ material: m.name, field: f, global: m[f], divisionSum: s[f], delta: m[f] - s[f] });
      }
    }
  }

  // ---- Check 2: serialized material — serial_numbers recount vs material_stock ----
  const serialCounts = db.prepare(`
    SELECT material, COALESCE(customer, '(none)') AS customer, status, COUNT(*) AS n
    FROM serial_numbers GROUP BY material, customer, status
  `).all();
  const serializedNames = new Set(materials.filter((m) => m.serialized).map((m) => m.name));

  // Nested maps — material & customer names are free text (they contain
  // spaces), so a flat joined string key can't be split back apart safely.
  const bySerial = new Map(); // material -> (customer -> { status: count })
  for (const r of serialCounts) {
    if (!bySerial.has(r.material)) bySerial.set(r.material, new Map());
    const cm = bySerial.get(r.material);
    if (!cm.has(r.customer)) cm.set(r.customer, {});
    cm.get(r.customer)[r.status] = r.n;
  }
  const byStock = new Map(); // material -> (customer -> stock row)
  for (const r of stockRows) {
    if (!byStock.has(r.material)) byStock.set(r.material, new Map());
    byStock.get(r.material).set(r.customer, r);
  }

  const serialVsMaterialStock = [];
  for (const material of new Set([...bySerial.keys(), ...byStock.keys()])) {
    if (!serializedNames.has(material)) continue; // only serialized materials have serial rows
    const serialCust = bySerial.get(material) || new Map();
    const stockCust = byStock.get(material) || new Map();
    for (const customer of new Set([...serialCust.keys(), ...stockCust.keys()])) {
      const counts = serialCust.get(customer) || {};

      if (customer === "(none)") {
        const total = Object.values(counts).reduce((a, b) => a + b, 0);
        if (total) serialVsMaterialStock.push({ material, customer: null, issue: "serial tanpa divisi (customer NULL)", count: total, byStatus: counts });
        continue;
      }
      // 'Unassigned' is a migration artifact (see below) — its material_stock
      // was copied from the old aggregate, not driven by serial statuses, so a
      // gap here is expected. Reported under `unassignedStock` instead.
      if (customer === "Unassigned") continue;

      const stored = stockCust.get(customer) || zero();
      const fromSerials = {
        ready: counts["Ready"] || 0,
        reserved: counts["Reserved"] || 0,
        in_transit: counts["In Transit"] || 0,
        faulty: counts["Faulty"] || 0,
      };
      const readyInclDelivered = fromSerials.ready + (counts["Delivered"] || 0);
      for (const f of FIELDS) {
        if (fromSerials[f] !== stored[f]) {
          const row = { material, customer, field: f, fromSerials: fromSerials[f], stored: stored[f], delta: stored[f] - fromSerials[f] };
          if (f === "ready" && stored.ready === readyInclDelivered) row.matchesDeliveredInclusive = true;
          serialVsMaterialStock.push(row);
        }
      }
    }
  }

  // ---- Check 3: negative values (the MAX(0,...) guards should prevent these) ----
  const negatives = [];
  for (const r of stockRows) {
    for (const f of FIELDS) if (r[f] < 0) negatives.push({ scope: "division", material: r.material, customer: r.customer, field: f, value: r[f] });
  }
  for (const m of materials) {
    for (const f of FIELDS) if (m[f] < 0) negatives.push({ scope: "global", material: m.name, field: f, value: m[f] });
  }

  // ---- Check 4: material_stock rows pointing at an unknown material/customer ----
  // "Unassigned" is a real synthetic division created by the division-scoping
  // migration (db.js) for stock that predates that feature — it is expected,
  // not corruption, so it is reported in its own bucket rather than flagged.
  const UNASSIGNED = "Unassigned";
  const materialNames = new Set(materials.map((m) => m.name));
  const customerNames = new Set(db.prepare("SELECT name FROM customers").all().map((r) => r.name));
  customerNames.add(UNASSIGNED);
  const orphans = [];
  const unassignedStock = [];
  for (const r of stockRows) {
    if (!materialNames.has(r.material)) orphans.push({ type: "material tidak dikenal", material: r.material, customer: r.customer });
    else if (r.customer === UNASSIGNED) {
      if (r.ready || r.faulty || r.reserved || r.in_transit) {
        unassignedStock.push({ material: r.material, ready: r.ready, faulty: r.faulty, reserved: r.reserved, in_transit: r.in_transit });
      }
    } else if (!customerNames.has(r.customer)) {
      orphans.push({ type: "divisi tidak dikenal", material: r.material, customer: r.customer });
    }
  }

  const realSerialMismatches = serialVsMaterialStock.filter((r) => !r.matchesDeliveredInclusive);
  const clean =
    globalVsDivisionSum.length === 0 &&
    realSerialMismatches.length === 0 &&
    negatives.length === 0 &&
    orphans.length === 0;

  return {
    checkedAt: isoDate(),
    summary: {
      clean,
      globalVsDivisionSum: globalVsDivisionSum.length,
      serialVsMaterialStock: realSerialMismatches.length,
      serialVsMaterialStockExpectedMsg: serialVsMaterialStock.length - realSerialMismatches.length,
      negatives: negatives.length,
      orphans: orphans.length,
      unassignedStock: unassignedStock.length,
    },
    globalVsDivisionSum,
    serialVsMaterialStock,
    negatives,
    orphans,
    unassignedStock,
  };
}

// Plan (read-only) for rebuilding the materials.* global aggregate columns
// from material_stock — their definition is "the sum across every division",
// so this is a cache refresh, not a business decision. Returns the list of
// field-level changes plus `desired`: the full target row for each material
// that needs updating. The caller applies `desired` inside a transaction.
function planGlobalAggregateRebuild(db) {
  db = db || require("../db");
  const materials = db.prepare("SELECT name, ready, faulty, reserved, in_transit FROM materials").all();
  const sums = db.prepare(`
    SELECT material,
      SUM(ready) AS ready, SUM(faulty) AS faulty,
      SUM(reserved) AS reserved, SUM(in_transit) AS in_transit
    FROM material_stock GROUP BY material
  `).all();
  const sumByName = new Map(sums.map((s) => [s.material, s]));

  const changes = [];
  const desired = {};
  for (const m of materials) {
    const s = sumByName.get(m.name) || { ready: 0, faulty: 0, reserved: 0, in_transit: 0 };
    let differs = false;
    for (const f of FIELDS) {
      const to = s[f] || 0;
      if (m[f] !== to) {
        changes.push({ material: m.name, field: f, from: m[f], to, delta: to - m[f] });
        differs = true;
      }
    }
    if (differs) desired[m.name] = { ready: s.ready || 0, faulty: s.faulty || 0, reserved: s.reserved || 0, in_transit: s.in_transit || 0 };
  }
  return { changes, desired };
}

// Plan (read-only) for recomputing material_stock.{reserved, in_transit,
// faulty} from serial_numbers status counts, for serialized materials in a
// real division (not 'Unassigned'). `ready` is deliberately NOT included —
// it's the one field with a disputed definition (MSG counts Delivered units
// as ready, the rest of the app doesn't). Returns field-level changes plus
// `desired`: the full {reserved,in_transit,faulty} target for each
// (material, customer) that needs it. Caller applies inside a transaction.
const SERIAL_BUCKETS = { reserved: "Reserved", in_transit: "In Transit", faulty: "Faulty" };

function planSerialBucketRebuild(db) {
  db = db || require("../db");
  const serialized = new Set(db.prepare("SELECT name FROM materials WHERE serialized = 1").all().map((r) => r.name));
  const counts = db.prepare(`
    SELECT material, customer, status, COUNT(*) AS n FROM serial_numbers
    WHERE customer IS NOT NULL AND customer != 'Unassigned'
    GROUP BY material, customer, status
  `).all();
  const stockRows = db.prepare(
    "SELECT material, customer, reserved, in_transit, faulty FROM material_stock WHERE customer != 'Unassigned'"
  ).all();

  const serialBy = new Map(); // material -> customer -> { status: n }
  for (const r of counts) {
    if (!serialized.has(r.material)) continue;
    if (!serialBy.has(r.material)) serialBy.set(r.material, new Map());
    const cm = serialBy.get(r.material);
    if (!cm.has(r.customer)) cm.set(r.customer, {});
    cm.get(r.customer)[r.status] = r.n;
  }
  const stockBy = new Map(); // material -> customer -> row
  for (const r of stockRows) {
    if (!serialized.has(r.material)) continue;
    if (!stockBy.has(r.material)) stockBy.set(r.material, new Map());
    stockBy.get(r.material).set(r.customer, r);
  }

  const changes = [];
  const desired = []; // [{ material, customer, reserved, in_transit, faulty }]
  for (const material of new Set([...serialBy.keys(), ...stockBy.keys()])) {
    const sc = serialBy.get(material) || new Map();
    const kc = stockBy.get(material) || new Map();
    for (const customer of new Set([...sc.keys(), ...kc.keys()])) {
      const counts = sc.get(customer) || {};
      const stored = kc.get(customer) || { reserved: 0, in_transit: 0, faulty: 0 };
      const target = {};
      let differs = false;
      for (const [field, status] of Object.entries(SERIAL_BUCKETS)) {
        target[field] = counts[status] || 0;
        if ((stored[field] || 0) !== target[field]) {
          changes.push({ material, customer, field, from: stored[field] || 0, to: target[field], delta: target[field] - (stored[field] || 0) });
          differs = true;
        }
      }
      if (differs) desired.push({ material, customer, ...target });
    }
  }
  return { changes, desired };
}

module.exports = { computeStockConsistency, planGlobalAggregateRebuild, planSerialBucketRebuild };
