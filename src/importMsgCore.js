// Shared core for the one-off MSG historical import. Pure logic: given the two
// CSV texts, it parses, maps, and returns the fully-resolved unit list plus a
// summary. No DB access here — the caller (admin route or CLI) decides whether
// to write. Keeps the importer testable and lets the route stay thin.

function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { /* skip */ }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toISO(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

const MATERIAL_MAP = {
  "[MODEM][HT3300][HUGHES]": "Modem Hughes HT3300",
  "[MODEM][WE3100][HUGHES]": "Modem Hughes WE3100",
  "[MODEM][HT2010][HUGHES]": "Modem Hughes HT2010",
  "[TRANSCEIVER][HT3210][HUGHES]": "Transceiver Hughes HT3210",
  "[TRANSCEIVER][HB220-L][HUGHES]": "Transceiver Hughes HB220-L",
  "[TRANSCEIVER][RGTR-A203][REVGO]": "Transceiver Revgo RGTR-A203",
  "[ACCESS POINT][GWN7630LR][GRANDSTREAM]": "Access Point Grandstream GWN7630LR",
  "[ROUTER][GWN7003][GRANDSTREAM]": "Router Grandstream GWN7003",
  "ADAPTOR MODEM HUGHES HT3300": "Adaptor Modem Hughes HT3300",
  "ADAPTOR MODEM HUGHES WE3100": "Adaptor Modem Hughes WE3100",
  "ADAPTOR MODEM HUGHES HT2010": "Adaptor Modem Hughes HT2010",
  "DISH": "Dish",
  "BOOM ARM": "Boom Arm",
  "FEED SUPPORT": "Feed Support",
  "CANISTER": "Canister",
  "POE": "PoE",
  "RACK WALLMOUNT 6U": "Rack Wallmount 6U",
  "STABILIZER SMT-1500VA": "Stabilizer Samoto 1500VA",
  "GROUNDING TESTER": null,
};

function baseMaterial(csvName) {
  let u = (csvName || "").toUpperCase();
  u = u.replace(/\(BATCH[^)]*\)/g, "").replace(/\(INSTALASI[^)]*\)/g, "").replace(/\[FAILURE\]/g, "");
  return u.replace(/\s+/g, " ").trim();
}

const NOSN_PREFIX = { "Dish": "DISH", "Boom Arm": "BOOMARM", "Feed Support": "FEEDSUPPORT", "Canister": "CANISTER", "PoE": "POE" };

const HB_REGION_MAP = [
  [/KALTIM|KALIMANTAN TIMUR/i, "Samarinda"],
  [/KALBAR|KALIMANTAN BARAT/i, "Serawai"],
  [/KALTENG|KALIMANTAN TENGAH/i, "Buntok"],
  [/BENGKULU/i, "Bengkulu"],
  [/KEP\.?\s*RIAU|KEPULAUAN RIAU/i, "Ranai"],
  [/SULAWESI TENGGARA|SULTRA/i, "Kendari"],
  [/SUMATRA UTARA|SUMATERA UTARA|SUMUT/i, "Tebing Tinggi"],
];
function mapHomebase(ket) {
  if (!ket) return { homebase: null };
  if (/warehouse terex/i.test(ket)) return { homebase: null };
  const hbMatch = ket.match(/di\s+(HB|Homebase)\s+(.+)/i) || ket.match(/di\s+(Kaltim|Kalbar|Kalteng)/i);
  if (hbMatch) {
    for (const [re, city] of HB_REGION_MAP) if (re.test(ket)) return { homebase: city };
    return { homebase: null, unmappedHB: ket };
  }
  return { homebase: null };
}

// Returns { units: [...], summary: {...} }
function buildUnits(masukText, keluarText) {
  const TODAY = new Date().toISOString().slice(0, 10);
  const DIVISION = "MSG";
  const masuk = parseCSV(masukText);
  const keluar = parseCSV(keluarText);

  const units = new Map();
  const normSN = (s) => (s || "").trim().toUpperCase();
  const summary = {
    masukRows: 0, keluarRows: 0, total: 0, generatedSN: 0, dupInMasuk: 0,
    orphanFromKeluar: 0, skippedGrounding: 0, skippedNoMaterial: 0,
    statusCount: {}, homebaseAssigned: 0, corrected: [], leftAsIs: [],
    materialMissing: [], unmappedHB: [],
  };
  const noSnCounters = {};
  const materialMissing = new Set(), unmappedHB = new Set();

  function genSN(masterName) {
    const prefix = NOSN_PREFIX[masterName] || masterName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    noSnCounters[prefix] = (noSnCounters[prefix] || 0) + 1;
    summary.generatedSN++;
    return `${prefix}${String(noSnCounters[prefix]).padStart(3, "0")}`;
  }
  function resolveMaterial(csvName) {
    const base = baseMaterial(csvName);
    if (!(base in MATERIAL_MAP)) { materialMissing.add(base); return undefined; }
    return MATERIAL_MAP[base];
  }

  // pass 1: masuk
  for (let i = 6; i < masuk.length; i++) {
    const r = masuk[i];
    if (!r || r.length < 14) continue;
    const [tglPickup, , namaBarang, , , noSnRaw, , , , tglInstall, , site, statusPerangkat, ket] = r;
    if (!namaBarang || !namaBarang.trim()) continue;
    summary.masukRows++;
    const master = resolveMaterial(namaBarang);
    if (master === undefined) { summary.skippedNoMaterial++; continue; }
    if (master === null) { summary.skippedGrounding++; continue; }

    let sn = (noSnRaw || "").trim();
    if (!sn || sn.toUpperCase() === "NO SN") sn = genSN(master);
    const key = normSN(sn);
    if (units.has(key)) { summary.dupInMasuk++; continue; }

    const status = (statusPerangkat || "").trim();
    let sysStatus, homebase = null, installSite = null;
    if (/install/i.test(status)) {
      sysStatus = "Delivered";
      installSite = (site || "").trim() || null;
    } else {
      sysStatus = "Ready";
      const hb = mapHomebase(ket);
      homebase = hb.homebase;
      if (homebase) summary.homebaseAssigned++;
      if (hb.unmappedHB) unmappedHB.add(hb.unmappedHB);
    }

    const recvISO = toISO(tglPickup);
    let instISO = toISO(tglInstall);
    if (recvISO && instISO && instISO < recvISO) {
      const p = instISO.split("-");
      const bumped = `${parseInt(p[0], 10) + 1}-${p[1]}-${p[2]}`;
      if (bumped >= recvISO && bumped <= TODAY) { summary.corrected.push(`${sn}: ${instISO}->${bumped}`); instISO = bumped; }
      else summary.leftAsIs.push(`${sn}: install ${instISO}, terima ${recvISO}`);
    }

    units.set(key, {
      sn, material: master, status: sysStatus, customer: DIVISION,
      received_date: recvISO, installed_date: instISO, install_site: installSite, homebase,
      replacement_date: null, shipped_to_warehouse_date: null, returned_to_customer_date: null,
    });
  }

  // pass 2: keluar
  for (let i = 6; i < keluar.length; i++) {
    const r = keluar[i];
    if (!r || r.length < 13) continue;
    const [tglReplace, , namaBarang, , , noSnRaw, , , , , tglFaulty, tglKirim, tglReturn] = r;
    if (!namaBarang || !namaBarang.trim()) continue;
    summary.keluarRows++;
    const master = resolveMaterial(namaBarang);
    if (master === undefined) { summary.skippedNoMaterial++; continue; }
    if (master === null) { summary.skippedGrounding++; continue; }

    let sn = (noSnRaw || "").trim();
    const isNoSn = !sn || sn.toUpperCase() === "NO SN";
    if (isNoSn) sn = genSN(master);
    const key = normSN(sn);
    const existing = units.get(key);
    const faultyFields = {
      status: "Faulty",
      replacement_date: toISO(tglReplace),
      shipped_to_warehouse_date: toISO(tglKirim),
      returned_to_customer_date: toISO(tglReturn),
      homebase: null,
    };
    if (existing && !isNoSn) {
      Object.assign(existing, faultyFields);
    } else {
      if (!existing) summary.orphanFromKeluar++;
      units.set(key, {
        sn, material: master, status: "Faulty", customer: DIVISION,
        received_date: null, installed_date: null, install_site: null, ...faultyFields,
      });
    }
  }

  const list = [...units.values()];
  list.forEach((u) => { summary.statusCount[u.status] = (summary.statusCount[u.status] || 0) + 1; });
  summary.total = list.length;
  summary.materialMissing = [...materialMissing];
  summary.unmappedHB = [...unmappedHB];
  return { units: list, summary };
}

module.exports = { buildUnits, parseCSV, toISO };
