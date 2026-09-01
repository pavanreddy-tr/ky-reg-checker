const express = require('express');
const cors = require('cors');
 
const app = express();
app.use(express.json());
app.use(cors());
 
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
// ── SUPABASE REST API ─────────────────────────────────────────────────────
const DB_HEADERS = () => ({
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json'
});
 
async function dbGet(table, params = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const resp = await fetch(url.toString(), { headers: DB_HEADERS() });
  if (!resp.ok) throw new Error(`DB ${resp.status}: ${await resp.text()}`);
  return resp.json();
}
 
async function dbCount(table) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id`, {
    headers: { ...DB_HEADERS(), 'Prefer': 'count=exact', 'Range': '0-0' }
  });
  const range = resp.headers.get('content-range') || '0-0/0';
  return parseInt(range.split('/')[1] || '0', 10);
}
 
async function dbInsert(table, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...DB_HEADERS(), 'Prefer': 'return=minimal' },
    body: JSON.stringify(data)
  });
  return resp.ok;
}
 
async function dbRpc(fn, params) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: DB_HEADERS(),
    body: JSON.stringify(params)
  });
  if (!resp.ok) throw new Error(`RPC ${fn}: ${resp.status}`);
  return resp.json();
}
 
app.get('/', (req, res) => {
  res.json({ status: 'EEC AI Assistant API running', version: '14.0' });
});
 
app.get('/stats', async (req, res) => {
  try {
    const count = await dbCount('regulations');
    res.json({ regulations_in_database: count, status: 'healthy', version: '14.0' });
  } catch (err) {
    res.json({ regulations_in_database: 428, status: 'healthy', version: '14.0', note: 'cached' });
  }
});
 
app.get('/history', async (req, res) => {
  try {
    const data = await dbGet('determinations', {
      select: 'id,created_at,equipment_type,equipment_details,results',
      order: 'created_at.desc',
      limit: 50
    });
    res.json(data || []);
  } catch (err) { res.json([]); }
});
 
async function generateEmbedding(text) {
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/text-embedding-004',
          content: { parts: [{ text: text.slice(0, 8000) }] }
        })
      }
    );
    const data = await resp.json();
    return data?.embedding?.values || null;
  } catch (e) { return null; }
}
 
async function searchRegulations(body, limit = 35) {
  const seen = new Set();
  const results = [];
  const SELECT = 'id,source,part,subpart,section,title,content,url,equipment_tags';
 
  const addRows = (rows) => {
    if (!Array.isArray(rows)) return;
    rows.forEach(r => { if (r && !seen.has(r.id)) { seen.add(r.id); results.push(r); } });
  };
 
  const searchWords = [body.equipmentCategory, body.equipmentType, body.fuelType, body.description]
    .filter(Boolean).join(' ').split(/\s+/).filter(w => w.length > 3).slice(0, 8);
 
  for (const word of [...new Set(searchWords)]) {
    try {
      const rows = await dbGet('regulations', { select: SELECT, title: `ilike.*${word}*`, limit: 8 });
      addRows(rows);
    } catch (e) {}
  }
 
  try {
    const kw = searchWords.slice(0, 4).join(' ');
    if (kw) addRows(await dbRpc('keyword_search_regulations', { search_terms: kw, result_limit: 10 }));
  } catch (e) {}
 
  try {
    const embedText = searchWords.join(' ') + ' air quality regulation Kentucky';
    const embedding = await generateEmbedding(embedText);
    if (embedding) {
      addRows(await dbRpc('search_regulations', { query_embedding: embedding, match_threshold: 0.2, match_count: 15 }));
    }
  } catch (e) {}
 
  try {
    addRows(await dbGet('regulations', { select: SELECT, source: 'eq.kentucky', limit: 20 }));
  } catch (e) {}
 
  return results.slice(0, limit);
}
 
// ── FETCH FULL REGULATION TEXT FOR DEEP ANALYSIS ─────────────────────────
// After finding which regulations likely apply, fetch their complete text
// so Gemini can reason through every paragraph, not just use memory
async function fetchFullRegText(part, subpart) {
  try {
    const SELECT = 'id,source,part,subpart,title,content,url';
    const rows = await dbGet('regulations', {
      select: SELECT,
      source: 'eq.federal',
      part: `eq.${part}`,
      subpart: `eq.${subpart}`,
      limit: 1
    });
    if (rows && rows.length > 0) return rows[0];
    return null;
  } catch (e) {
    console.log(`fetchFullRegText error Part ${part} Subpart ${subpart}:`, e.message);
    return null;
  }
}
 
// Fetch full text of all applicable regulations for ANY equipment type
// This is the core of accurate determination — read actual CFR text
async function fetchApplicableRegTexts(body) {
  const cat = (body.equipmentCategory || '').toLowerCase();
  const fuel = (body.fuelType || '').toLowerCase();
  const use = (body.equipmentType || '').toLowerCase();
  const desc = (body.description || '').toLowerCase();
  const capStr = (body.capacity || '').replace(/[^0-9.]/g, '');
  const cap = parseFloat(capStr) || 0;
  const capUnit = (body.capacity || '').toLowerCase();
  const isMMBtu = capUnit.includes('mmbtu') || capUnit.includes('btu');
  const isHP = capUnit.includes('hp') || capUnit.includes('horsepower');
  const capMMBtu = isMMBtu ? cap : 0;
  const capHP = isHP ? cap : 0;
  const isEmergency = use.includes('emergency') || use.includes('standby');
  const isMajor = (body.sourceClass || '').toLowerCase().includes('major');
  const isArea = (body.sourceClass || '').toLowerCase().includes('area');
 
  // Always fetch Kentucky regulations
  const toFetch = [
    { part: '401 KAR 52', subpart: null },
    { part: '401 KAR 59', subpart: null },
    { part: '401 KAR 63', subpart: null },
  ];
 
  // ── ENGINES ──────────────────────────────────────────────────────────
  const isCI = cat.includes('ci') || cat.includes('diesel') || cat.includes('compression ignition');
  const isSI = cat.includes('si') || cat.includes('spark ignition') || cat.includes('natural gas') || cat.includes('gasoline') || cat.includes('landfill gas');
  const isEngine = isCI || isSI || cat.includes('engine');
 
  if (isCI) {
    toFetch.push({ part: '60', subpart: 'IIII' });   // NSPS CI engines
    toFetch.push({ part: '63', subpart: 'ZZZZ' });   // RICE NESHAP
  }
  if (isSI) {
    toFetch.push({ part: '60', subpart: 'JJJJ' });   // NSPS SI engines
    toFetch.push({ part: '63', subpart: 'ZZZZ' });   // RICE NESHAP
  }
 
  // ── BOILERS ──────────────────────────────────────────────────────────
  const isBoiler = cat.includes('boiler') || cat.includes('steam generating') || cat.includes('process heater') || cat.includes('indirect heat');
  if (isBoiler) {
    // Size-based NSPS
    if (capMMBtu > 100 || (!isMMBtu && cap > 100)) {
      toFetch.push({ part: '60', subpart: 'Db' });   // Large industrial boiler
      toFetch.push({ part: '60', subpart: 'Da' });   // Electric utility
    } else if (capMMBtu >= 10 || (!isMMBtu && cap >= 10)) {
      toFetch.push({ part: '60', subpart: 'Dc' });   // Small industrial boiler
    } else {
      toFetch.push({ part: '60', subpart: 'Dc' });
      toFetch.push({ part: '60', subpart: 'Db' });
    }
    // MACT - source type determines which
    if (isMajor) toFetch.push({ part: '63', subpart: 'DDDDD' });
    if (isArea) toFetch.push({ part: '63', subpart: 'JJJJJJ' });
    if (!isMajor && !isArea) {
      toFetch.push({ part: '63', subpart: 'DDDDD' });
      toFetch.push({ part: '63', subpart: 'JJJJJJ' });
    }
    // Utility boiler
    if (cat.includes('utility') || cat.includes('electric')) {
      toFetch.push({ part: '63', subpart: 'UUUUU' });
    }
    // Kentucky new/existing
    toFetch.push({ part: '401 KAR 61', subpart: null });
  }
 
  // ── COMBUSTION TURBINES ───────────────────────────────────────────────
  const isTurbine = cat.includes('turbine') || cat.includes('gas turbine') || cat.includes('combustion turbine');
  if (isTurbine) {
    toFetch.push({ part: '60', subpart: 'KKKK' });
    toFetch.push({ part: '63', subpart: 'YYYY' });
  }
 
  // ── INCINERATORS ─────────────────────────────────────────────────────
  const isIncinHazWaste = cat.includes('hazardous waste') || desc.includes('rcra');
  const isIncinMedical = cat.includes('medical') || cat.includes('infectious') || cat.includes('hospital');
  const isIncinMSW = cat.includes('municipal solid waste') || cat.includes('msw');
  const isIncinCISWI = cat.includes('ciswi') || cat.includes('commercial') || cat.includes('industrial solid waste');
  const isIncinPharma = cat.includes('pharmaceutical') || cat.includes('drug waste');
  const isIncinSewage = cat.includes('sewage sludge');
 
  if (isIncinHazWaste) toFetch.push({ part: '63', subpart: 'EEE' });
  if (isIncinMedical) toFetch.push({ part: '60', subpart: 'Ec' });
  if (isIncinMSW) {
    toFetch.push({ part: '60', subpart: 'Eb' });
    toFetch.push({ part: '60', subpart: 'AAAA' });
  }
  if (isIncinCISWI || isIncinPharma) {
    toFetch.push({ part: '60', subpart: 'CCCC' });
    toFetch.push({ part: '63', subpart: 'EEE' }); // check HW status
  }
  if (isIncinSewage) {
    toFetch.push({ part: '60', subpart: 'LLLL' });
  }
  if (cat.includes('incinerat')) {
    toFetch.push({ part: '60', subpart: 'E' });
    toFetch.push({ part: '401 KAR 64', subpart: null });
  }
 
  // ── LANDFILLS ────────────────────────────────────────────────────────
  const isLandfill = cat.includes('landfill');
  if (isLandfill) {
    toFetch.push({ part: '60', subpart: 'WWW' });    // NSPS new landfills
    toFetch.push({ part: '63', subpart: 'AAAA' });   // NESHAP landfills
    toFetch.push({ part: '98', subpart: 'HH' });     // GHG landfills
    // Federal plan for existing landfills
    toFetch.push({ part: '62', subpart: 'OOO' });
  }
 
  // ── STORAGE TANKS ─────────────────────────────────────────────────────
  const isTank = cat.includes('storage tank') || cat.includes('volatile organic liquid') || cat.includes('vol ');
  if (isTank) {
    toFetch.push({ part: '60', subpart: 'Kb' });     // VOL storage vessels
    toFetch.push({ part: '60', subpart: 'K' });      // Older petroleum tanks
    toFetch.push({ part: '60', subpart: 'Ka' });     // 1978-1984 petroleum tanks
    toFetch.push({ part: '63', subpart: 'OO' });     // Tanks Level 1 NESHAP
    toFetch.push({ part: '63', subpart: 'WW' });     // Tanks Level 2 NESHAP
  }
  if (cat.includes('bulk') && cat.includes('gasoline')) {
    toFetch.push({ part: '60', subpart: 'XX' });     // Bulk gasoline terminals
    toFetch.push({ part: '63', subpart: 'BBBBBB' }); // Bulk terminals area source
  }
  if (cat.includes('gasoline dispensing')) {
    toFetch.push({ part: '63', subpart: 'CCCCCC' }); // Gasoline dispensing area
  }
 
  // ── MINERAL PROCESSING / CRUSHING / QUARRYING ─────────────────────────
  const isMineral = cat.includes('mineral') || cat.includes('crush') || cat.includes('quarry') || cat.includes('screen') || cat.includes('aggregate') || cat.includes('sand') || cat.includes('gravel') || cat.includes('stone');
  if (isMineral) {
    toFetch.push({ part: '60', subpart: 'OOO' });   // Nonmetallic mineral processing
    toFetch.push({ part: '401 KAR 61', subpart: null }); // KY existing sources
  }
 
  // ── ASPHALT ──────────────────────────────────────────────────────────
  if (cat.includes('asphalt') || cat.includes('hot mix')) {
    toFetch.push({ part: '60', subpart: 'I' });      // Hot mix asphalt
    toFetch.push({ part: '60', subpart: 'UU' });     // Asphalt processing
  }
 
  // ── CEMENT ───────────────────────────────────────────────────────────
  if (cat.includes('cement') || cat.includes('portland')) {
    toFetch.push({ part: '60', subpart: 'F' });      // Portland cement NSPS
    toFetch.push({ part: '63', subpart: 'LLL' });    // Portland cement NESHAP
  }
 
  // ── GLASS ────────────────────────────────────────────────────────────
  if (cat.includes('glass')) {
    toFetch.push({ part: '60', subpart: 'CC' });     // Glass manufacturing NSPS
    toFetch.push({ part: '63', subpart: 'SSSSSS' }); // Glass area source NESHAP
  }
 
  // ── LIME ─────────────────────────────────────────────────────────────
  if (cat.includes('lime')) {
    toFetch.push({ part: '60', subpart: 'HH' });     // Lime manufacturing NSPS
    toFetch.push({ part: '63', subpart: 'AAAAA' });  // Lime manufacturing NESHAP
    toFetch.push({ part: '63', subpart: 'YYYYYY' }); // Lime area source NESHAP
  }
 
  // ── PULP AND PAPER ───────────────────────────────────────────────────
  const isPulp = cat.includes('pulp') || cat.includes('paper') || cat.includes('kraft');
  if (isPulp) {
    toFetch.push({ part: '60', subpart: 'BB' });     // Kraft pulp NSPS
    toFetch.push({ part: '60', subpart: 'BBa' });    // Kraft pulp NSPS amended
    toFetch.push({ part: '63', subpart: 'S' });      // Pulp/paper NESHAP
    toFetch.push({ part: '63', subpart: 'MM' });     // Chemical recovery NESHAP
  }
 
  // ── METAL FOUNDRY / SMELTER ───────────────────────────────────────────
  const isFoundry = cat.includes('foundry') || cat.includes('smelter') || cat.includes('metal') || cat.includes('iron') || cat.includes('steel') || cat.includes('aluminum') || cat.includes('copper');
  if (isFoundry) {
    if (cat.includes('iron') || cat.includes('steel')) {
      toFetch.push({ part: '60', subpart: 'AA' });   // EAF steel NSPS
      toFetch.push({ part: '63', subpart: 'EEEEE' }); // Iron steel NESHAP major
      toFetch.push({ part: '63', subpart: 'YYYYY' }); // EAF area source
      toFetch.push({ part: '63', subpart: 'ZZZZZ' }); // Foundry area source
    }
    if (cat.includes('aluminum')) {
      toFetch.push({ part: '60', subpart: 'S' });    // Primary aluminum NSPS
      toFetch.push({ part: '63', subpart: 'LL' });   // Primary aluminum NESHAP
      toFetch.push({ part: '63', subpart: 'RRR' });  // Secondary aluminum NESHAP
      toFetch.push({ part: '63', subpart: 'ZZZZZZ' }); // Nonferrous foundry area
    }
    if (cat.includes('copper')) {
      toFetch.push({ part: '60', subpart: 'P' });    // Primary copper NSPS
      toFetch.push({ part: '63', subpart: 'QQQ' });  // Primary copper NESHAP
      toFetch.push({ part: '63', subpart: 'EEEEEE' }); // Copper area source
    }
    if (cat.includes('lead')) {
      toFetch.push({ part: '60', subpart: 'L' });    // Secondary lead
      toFetch.push({ part: '63', subpart: 'X' });    // Secondary lead NESHAP
      toFetch.push({ part: '63', subpart: 'TTT' });  // Primary lead NESHAP
    }
  }
 
  // ── SURFACE COATING ───────────────────────────────────────────────────
  const isCoating = cat.includes('coating') || cat.includes('paint') || cat.includes('finishing') || cat.includes('spray');
  if (isCoating) {
    toFetch.push({ part: '63', subpart: 'HHHHHH' }); // Paint stripping area source
    toFetch.push({ part: '63', subpart: 'MMMM' });   // Misc metal parts coating
    toFetch.push({ part: '63', subpart: 'OOOO' });   // Metal furniture coating
    if (cat.includes('wood')) toFetch.push({ part: '63', subpart: 'RRRR' }); // Wood furniture
    if (cat.includes('auto') || cat.includes('vehicle')) toFetch.push({ part: '60', subpart: 'MM' });
    if (cat.includes('large appliance')) toFetch.push({ part: '60', subpart: 'SS' });
    if (cat.includes('metal coil')) toFetch.push({ part: '60', subpart: 'TT' });
  }
 
  // ── PRINTING ─────────────────────────────────────────────────────────
  if (cat.includes('print') || cat.includes('graphic arts') || cat.includes('publishing')) {
    toFetch.push({ part: '60', subpart: 'QQ' });     // Rotogravure/flexo NSPS
    toFetch.push({ part: '63', subpart: 'KK' });     // Printing/publishing NESHAP
  }
 
  // ── CHEMICAL MANUFACTURING / SOCMI ────────────────────────────────────
  const isChem = cat.includes('chemical') || cat.includes('socmi') || cat.includes('pharmaceutical') || cat.includes('tnt') || cat.includes('explosive') || cat.includes('reactor') || cat.includes('distillat') || cat.includes('solvent');
  if (isChem) {
    if (isMajor) toFetch.push({ part: '63', subpart: 'FFFF' });  // MON major source
    if (isArea) toFetch.push({ part: '63', subpart: 'VVVVVV' }); // CMAS area source
    if (!isMajor && !isArea) {
      toFetch.push({ part: '63', subpart: 'FFFF' });
      toFetch.push({ part: '63', subpart: 'VVVVVV' });
    }
    toFetch.push({ part: '60', subpart: 'VVa' });   // Equipment leaks SOCMI
    toFetch.push({ part: '60', subpart: 'RRR' });   // Reactor processes SOCMI
    toFetch.push({ part: '60', subpart: 'NNN' });   // Distillation SOCMI
    toFetch.push({ part: '68', subpart: 'A' });     // RMP
    toFetch.push({ part: '68', subpart: 'G' });     // RMP plan requirements
  }
 
  // ── PETROLEUM REFINERY ────────────────────────────────────────────────
  if (cat.includes('refiner') || cat.includes('petroleum refin')) {
    toFetch.push({ part: '60', subpart: 'J' });     // Petroleum refinery NSPS
    toFetch.push({ part: '60', subpart: 'Ja' });    // Petroleum refinery NSPS new
    toFetch.push({ part: '63', subpart: 'CC' });    // Petroleum refinery NESHAP
    toFetch.push({ part: '63', subpart: 'UUU' });   // Catalytic cracking NESHAP
    toFetch.push({ part: '60', subpart: 'GGG' });   // Equipment leaks refinery
  }
 
  // ── OIL AND GAS PRODUCTION ────────────────────────────────────────────
  const isOilGas = cat.includes('oil') || cat.includes('natural gas') || cat.includes('well') || cat.includes('pipeline') || cat.includes('compressor station') || cat.includes('gas processing');
  if (isOilGas && !isEngine) { // Avoid double-adding for gas engines
    toFetch.push({ part: '60', subpart: 'OOOOb' }); // 2024 oil/gas NSPS
    toFetch.push({ part: '60', subpart: 'OOOOa' }); // 2016 oil/gas NSPS
    toFetch.push({ part: '60', subpart: 'OOOO' });  // 2012 oil/gas NSPS
    toFetch.push({ part: '63', subpart: 'HHH' });   // Natural gas transmission
    toFetch.push({ part: '60', subpart: 'KKK' });   // Equipment leaks nat gas
  }
 
  // ── ELECTROPLATING / METAL FINISHING ──────────────────────────────────
  const isPlating = cat.includes('electro') || cat.includes('plat') || cat.includes('chrome') || cat.includes('metal finish') || cat.includes('anodiz');
  if (isPlating) {
    toFetch.push({ part: '63', subpart: 'N' });     // Chrome electroplating major
    toFetch.push({ part: '63', subpart: 'IIIIII' }); // Chrome plating area source
    toFetch.push({ part: '63', subpart: 'VVVVVV' }); // Plating/polishing area
  }
 
  // ── DRY CLEANING ─────────────────────────────────────────────────────
  if (cat.includes('dry clean') || desc.includes('perchloroethylene') || desc.includes('pce')) {
    toFetch.push({ part: '63', subpart: 'M' });     // PCE dry cleaning NESHAP
  }
 
  // ── SOLVENT CLEANING / DEGREASING ────────────────────────────────────
  if (cat.includes('solvent') || cat.includes('degreasing') || cat.includes('cleaning')) {
    toFetch.push({ part: '63', subpart: 'T' });     // Halogenated solvent cleaning
  }
 
  // ── GRAIN ELEVATOR ───────────────────────────────────────────────────
  if (cat.includes('grain') || cat.includes('elevator') || cat.includes('feed mill')) {
    toFetch.push({ part: '60', subpart: 'DD' });    // Grain elevators NSPS
  }
 
  // ── WASTEWATER TREATMENT ─────────────────────────────────────────────
  if (cat.includes('wastewater') || cat.includes('potw') || cat.includes('sewage treatment')) {
    toFetch.push({ part: '60', subpart: 'O' });     // Sewage treatment plants
    toFetch.push({ part: '63', subpart: 'VVV' });   // POTW NESHAP
  }
 
  // ── RUBBER / TIRE ─────────────────────────────────────────────────────
  if (cat.includes('rubber') || cat.includes('tire')) {
    toFetch.push({ part: '63', subpart: 'BBBB' });  // Rubber tire major source
    toFetch.push({ part: '63', subpart: 'XXXX' });  // Rubber tire area source
  }
 
  // ── WOOD PRODUCTS / FURNITURE ─────────────────────────────────────────
  if (cat.includes('wood') || cat.includes('furniture') || cat.includes('plywood') || cat.includes('composite')) {
    toFetch.push({ part: '63', subpart: 'JJ' });    // Wood furniture manufacturing
    toFetch.push({ part: '63', subpart: 'CCCC' });  // Plywood composite major
    toFetch.push({ part: '63', subpart: 'DDDD' });  // Plywood composite area
  }
 
  // ── SEMICONDUCTOR / ELECTRONICS ───────────────────────────────────────
  if (cat.includes('semiconductor') || cat.includes('electronic') || cat.includes('circuit board')) {
    toFetch.push({ part: '63', subpart: 'BBBBB' }); // Semiconductor major
    toFetch.push({ part: '63', subpart: 'WWWWWW' }); // Semiconductor area
  }
 
  // ── REFRIGERATION / HVAC ─────────────────────────────────────────────
  if (cat.includes('refriger') || cat.includes('hvac') || cat.includes('chiller') || cat.includes('cooling') || desc.includes('refrigerant')) {
    toFetch.push({ part: '82', subpart: 'F' });     // Refrigerant recycling Subpart F
    toFetch.push({ part: '82', subpart: 'A' });     // Ozone protection general
  }
 
  // ── ALWAYS: Check RMP for any large chemical/flammable storage ────────
  if (desc.includes('ammonia') || desc.includes('chlorine') || desc.includes('propane') || desc.includes('hydrogen') || desc.includes('flammable') || desc.includes('toxic') || isChem) {
    toFetch.push({ part: '68', subpart: 'A' });
  }
 
  // ── ALWAYS: Check GHG for large combustion sources ───────────────────
  if (capMMBtu > 100 || (isBoiler && cap > 50) || isTurbine || cat.includes('cement') || cat.includes('lime') || isLandfill) {
    toFetch.push({ part: '98', subpart: 'C' });     // Stationary combustion GHG
  }
 
  // ── SIC CODE-BASED REGULATION TRIGGERING ────────────────────────────────
  // Catches facility-level regulations that equipment-type search misses
  const sic = (body.sicCode || '').toString().trim();
  const sicNum = parseInt(sic) || 0;
 
  // Iron and Steel (SIC 3312-3317)
  if ([3312,3313,3314,3315,3316,3317].includes(sicNum) ||
      cat.includes('steel') || cat.includes('iron') || cat.includes('electric arc')) {
    toFetch.push({ part: '63', subpart: 'EEEEE' });
    toFetch.push({ part: '63', subpart: 'FFFFF' });
    toFetch.push({ part: '63', subpart: 'YYYYY' });
    toFetch.push({ part: '60', subpart: 'AA' });
    toFetch.push({ part: '60', subpart: 'AAa' });
  }
 
  // Petroleum Refining (SIC 2910-2919)
  if (sicNum >= 2910 && sicNum <= 2919) {
    toFetch.push({ part: '60', subpart: 'J' });
    toFetch.push({ part: '63', subpart: 'CC' });
    toFetch.push({ part: '63', subpart: 'UUU' });
    toFetch.push({ part: '68', subpart: 'A' });
  }
 
  // Chemical Manufacturing (SIC 2800-2899)
  if (sicNum >= 2800 && sicNum <= 2899) {
    toFetch.push({ part: '63', subpart: 'FFFF' });
    toFetch.push({ part: '63', subpart: 'VVVVVV' });
    toFetch.push({ part: '60', subpart: 'VVa' });
    toFetch.push({ part: '68', subpart: 'A' });
  }
 
  // Explosives/TNT (SIC 2892, 2899, 3760)
  if ([2892,2899,3489,3760,3761,3769].includes(sicNum) ||
      desc.includes('tnt') || desc.includes('explosive')) {
    toFetch.push({ part: '63', subpart: 'FFFF' });
    toFetch.push({ part: '68', subpart: 'A' });
  }
 
  // Portland Cement (SIC 3241)
  if (sicNum === 3241) {
    toFetch.push({ part: '60', subpart: 'F' });
    toFetch.push({ part: '63', subpart: 'LLL' });
  }
 
  // Glass (SIC 3211-3290)
  if (sicNum >= 3211 && sicNum <= 3290) {
    toFetch.push({ part: '60', subpart: 'CC' });
    toFetch.push({ part: '63', subpart: 'SSSSSS' });
  }
 
  // Pulp and Paper (SIC 2611-2679)
  if (sicNum >= 2611 && sicNum <= 2679) {
    toFetch.push({ part: '60', subpart: 'BB' });
    toFetch.push({ part: '60', subpart: 'BBa' });
    toFetch.push({ part: '63', subpart: 'S' });
    toFetch.push({ part: '63', subpart: 'MM' });
  }
 
  // Rubber/Tire (SIC 3011, 3069)
  if ([3011,3052,3053,3069].includes(sicNum)) {
    toFetch.push({ part: '63', subpart: 'BBBB' });
    toFetch.push({ part: '63', subpart: 'XXXX' });
  }
 
  // Wood Products (SIC 2400-2499)
  if (sicNum >= 2400 && sicNum <= 2499) {
    toFetch.push({ part: '63', subpart: 'CCCC' });
    toFetch.push({ part: '63', subpart: 'DDDD' });
    toFetch.push({ part: '63', subpart: 'JJ' });
  }
 
  // Printing (SIC 2700-2796)
  if (sicNum >= 2700 && sicNum <= 2796) {
    toFetch.push({ part: '60', subpart: 'QQ' });
    toFetch.push({ part: '63', subpart: 'KK' });
  }
 
  // Dry Cleaning (SIC 7212-7216)
  if ([7212,7215,7216].includes(sicNum)) {
    toFetch.push({ part: '63', subpart: 'M' });
  }
 
  // Electroplating (SIC 3471, 3469)
  if ([3462,3469,3471,3484,3499].includes(sicNum)) {
    toFetch.push({ part: '63', subpart: 'N' });
    toFetch.push({ part: '63', subpart: 'IIIIII' });
    toFetch.push({ part: '63', subpart: 'VVVVVV' });
  }
 
  // Semiconductor (SIC 3672-3679)
  if (sicNum >= 3672 && sicNum <= 3679) {
    toFetch.push({ part: '63', subpart: 'BBBBB' });
    toFetch.push({ part: '63', subpart: 'WWWWWW' });
  }
 
  // MSW Landfill (SIC 4953)
  if (sicNum === 4953) {
    toFetch.push({ part: '60', subpart: 'WWW' });
    toFetch.push({ part: '63', subpart: 'AAAA' });
    toFetch.push({ part: '62', subpart: 'OOO' });
    toFetch.push({ part: '98', subpart: 'HH' });
  }
 
  // Wastewater (SIC 4941, 4952)
  if ([4941,4952].includes(sicNum)) {
    toFetch.push({ part: '63', subpart: 'VVV' });
    toFetch.push({ part: '60', subpart: 'O' });
  }
 
  // Oil and Gas (SIC 1311, 1321, 4922-4925)
  if ([1311,1321,1381,1382,1389,4922,4923,4924,4925].includes(sicNum)) {
    toFetch.push({ part: '60', subpart: 'OOOOb' });
    toFetch.push({ part: '60', subpart: 'OOOOa' });
    toFetch.push({ part: '63', subpart: 'HHH' });
  }
 
  // Mining (SIC 1400-1499)
  if (sicNum >= 1400 && sicNum <= 1499) {
    toFetch.push({ part: '60', subpart: 'OOO' });
  }
 
  // Asphalt (SIC 2951, 2952)
  if ([2951,2952].includes(sicNum)) {
    toFetch.push({ part: '60', subpart: 'I' });
  }
 
  // GHG reporting - major sources and large facilities
  if (isMajor || sicNum === 3312 || sicNum === 3241 ||
      cat.includes('cement') || cat.includes('lime') || isLandfill ||
      (sicNum >= 2800 && sicNum <= 2899) || capMMBtu > 100) {
    toFetch.push({ part: '98', subpart: 'C' });
    toFetch.push({ part: '98', subpart: 'A' });
  }
 
  // RMP - chemical/flammable facilities
  if (desc.includes('ammonia') || desc.includes('chlorine') ||
      desc.includes('hydrogen fluoride') || desc.includes('propane') ||
      (sicNum >= 2800 && sicNum <= 2899) ||
      [2911,2910,1311,1321].includes(sicNum)) {
    toFetch.push({ part: '68', subpart: 'A' });
  }
 
  // ── Deduplicate and fetch full text ───────────────────────────────────
  const unique = [];
  const seen = new Set();
  for (const t of toFetch) {
    const key = `${t.part}|${t.subpart||'null'}`;
    if (!seen.has(key)) { seen.add(key); unique.push(t); }
  }
 
  console.log(`Fetching full text for ${unique.length} regulations:`, unique.map(t => `${t.part} ${t.subpart||''}`).join(', '));
 
  const fetched = [];
  // Fetch all — limit to 8 to stay within Gemini context window
  for (const { part, subpart } of unique.slice(0, 8)) {
    try {
      let rows;
      if (subpart) {
        rows = await dbGet('regulations', {
          select: 'id,source,part,subpart,title,content,url',
          source: 'eq.federal',
          part: `eq.${part}`,
          subpart: `eq.${subpart}`,
          limit: 1
        });
      } else {
        // Kentucky chapter — search by part name
        rows = await dbGet('regulations', {
          select: 'id,source,part,subpart,title,content,url',
          source: 'eq.kentucky',
          part: `ilike.*${part}*`,
          limit: 1
        });
      }
      if (rows && rows.length > 0 && rows[0].content) {
        fetched.push(rows[0]);
      }
    } catch (e) {
      console.log(`Fetch error ${part} ${subpart}:`, e.message);
    }
  }
 
  console.log(`Successfully fetched full text for ${fetched.length} regulations`);
  return fetched;
}
 
// ── ECFR PARAGRAPH URL BUILDER ────────────────────────────────────────────
// Builds direct links to specific paragraphs on eCFR
function buildEcfrUrl(part, subpart, section, paragraph) {
  const base = 'https://www.ecfr.gov/current/title-40';
  if (!section) {
    return `${base}/chapter-I/subchapter-C/part-${part}/subpart-${subpart}`;
  }
  const anchor = paragraph ? `#p-${section}${encodeURIComponent(paragraph)}` : '';
  return `${base}/chapter-I/subchapter-C/part-${part}/subpart-${subpart}/section-${section}${anchor}`;
}
 
function buildControlCtx(devices) {
  if (!devices || devices.length === 0) return 'None installed.';
  return devices.map((d, i) =>
    `Device ${i+1}: ${d.type}${d.efficiency ? ` | ${d.efficiency}` : ''}${d.pollutants ? ` | Controls: ${d.pollutants}` : ''}`
  ).join('\n');
}
 
// ── TCEQ-STYLE DECISION LOGIC ─────────────────────────────────────────────
const TCEQ_FLOW_CHART_LOGIC = `
=====================================================================
TCEQ-STYLE FLOW CHART DECISION LOGIC
Follow this step-by-step for each regulation. Answer each question
in order. First NO answer determines the outcome.
=====================================================================
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. 40 CFR 60 SUBPART IIII — CI ENGINE NSPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is the engine a stationary compression ignition (CI/diesel) engine? NO→not subject
Q2: Did construction commence AFTER July 11, 2005? NO→not subject
Q3: Is displacement LESS THAN 30 L/cylinder? NO→not subject (use §60.4213)
Q4: Is it used at a test cell/stand? YES→exempt per §60.4200(b)
 
If all pass → SUBJECT. Then determine category:
EMERGENCY ENGINE:
  - §60.4205 emission standards apply
  - §60.4207 fuel: ultra-low sulfur diesel <15 ppm sulfur
  - §60.4211(f) operating limits: max 100 hrs/yr maintenance/testing + 50 hrs/yr non-emergency
  - §60.4211(f)(3) non-resettable hour meter required
  - §60.4214(b) no initial notification required but must keep records
  - §60.4214(c) must submit deviation reports if hour limits exceeded
 
NON-EMERGENCY ENGINE:
  Tier/model year determines emission standards:
  - 2007+ model year: §60.4204(a) — must meet 40 CFR Part 1039 standards
  - Pre-2007 model year ≥130 KW (175 HP): §60.4204(b) — Tier 1/2 PM standards
  - Pre-2007 model year <130 KW: §60.4205(c) — Tier 1 standards
  - §60.4207 ultra-low sulfur diesel required
  - §60.4209 monitoring requirements
  - §60.4211(a) must operate per manufacturer emission-related written instructions
  - §60.4214(a) initial notification required for: >2237 KW (3000 HP), OR ≥10 L/cyl displacement, OR pre-2007 >130 KW uncertified
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. 40 CFR 60 SUBPART JJJJ — SI ENGINE NSPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a stationary spark ignition (SI) engine? NO→not subject
Q2: Did construction commence AFTER June 12, 2006? NO→not subject
Q3: Is it at a test cell/stand? YES→exempt per §60.4230(b)
 
CRITICAL SIZE DETERMINATION:
≤25 HP (≤19 KW):
  - Technically subject BUT emission standards reference 40 CFR Part 1054
  - Engine must be certified under Part 1054 by manufacturer
  - In Kentucky DAQ practice: NOT cited as subject to JJJJ in permits
  - Owner/operator has NO additional compliance obligations beyond buying certified engine
  - STATUS: Does NOT apply as standalone permit requirement for ≤25 HP engines
 
>25 HP (>19 KW) — determine fuel/use category:
  GASOLINE engines >25 HP: §60.4233(b) — comply with 40 CFR Part 1048 standards
  NATURAL GAS/LPG lean burn 19-75 KW (25-100 HP): §60.4233(d) field testing
  NATURAL GAS/LPG ≥75 KW (≥100 HP): §60.4233(e) Table 1 emission limits:
    - NOx: 2.0 g/HP-hr (non-emergency), 3.0 g/HP-hr (emergency <500HP), 1.0 (≥500HP non-emerg)
    - CO: 4.0 g/HP-hr (non-emergency), 4.0 g/HP-hr (emergency)
    - VOC: 1.0 g/HP-hr (non-emergency ≥500HP), 0.7 (emergency ≥500HP)
  LANDFILL GAS: §60.4233(f) — specific NOx limits
  RICH BURN LPG: §60.4233(c) — 3-way catalyst required
 
EMERGENCY SI ENGINES >25 HP:
  - Same 100 hrs/yr maintenance + 50 hrs/yr non-emergency limit as IIII
  - §60.4243(d) operating restrictions
  - §60.4245 recordkeeping: all engines keep maintenance records
  - §60.4245(c) initial notification ONLY for non-certified engines ≥500 HP
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. 40 CFR 63 SUBPART ZZZZ — RICE NESHAP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a reciprocating internal combustion engine (CI or SI)? NO→not subject
Q2: Is it at a test cell/stand? YES→exempt per §63.6585(b)
 
MAJOR SOURCE:
  ALL sizes subject. New vs existing determined by Jun 12 2006 cutoff.
  New CI major source: Table 2a emission limits (CO, formaldehyde, HAP metals)
  New SI major source: Table 2b emission limits
  Existing CI ≥500 HP major source: Table 2c
  Existing SI ≥500 HP major source: Table 2d
  Key sections: §63.6595, §63.6600, §63.6605, §63.6625
 
AREA SOURCE:
  CI engines ≥300 HP: subject to §63.6625 work practice standards
  CI engines <300 HP: ONLY annual maintenance inspection per §63.6625(e)
  SI engines ≥500 HP: subject to §63.6625 work practice standards
  SI engines <500 HP: ONLY annual maintenance inspection per §63.6625(e)
  Emergency engines at area source ≤500 HP (CI or SI): annual inspection ONLY
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. 40 CFR 60 SUBPART KKKK — COMBUSTION TURBINE NSPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a stationary combustion turbine? NO→not subject
Q2: Did construction commence AFTER February 18, 2005? NO→not subject
Q3: Is it ≤10 MW combined cycle or ≤30 MW simple cycle? May be exempt
Emission standards: NOx in ppmvd at 15% O2, varies by fuel and turbine size
§60.4320 NOx limits: natural gas 25 ppm (>850 kW), oil 96 ppm
§60.4330 monitoring: CEMS or parametric monitoring
§60.4333 performance testing requirements
§60.4340 notifications and recordkeeping
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. 40 CFR 63 SUBPART YYYY — COMBUSTION TURBINE NESHAP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a stationary combustion turbine? NO→not subject
Q2: Is it at a major or area HAP source? Determines tier of requirements
Q3: Construction after January 14, 2003? Determines new vs existing
MAJOR SOURCE turbines: emission limits for formaldehyde, CO, HAP metals
AREA SOURCE turbines: work practice standards only
Emergency turbines: significant exemptions available
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. 40 CFR 60 SUBPART Db — INDUSTRIAL BOILER NSPS (>100 MMBtu/hr)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it an industrial/commercial/institutional steam generating unit? NO→not subject
Q2: Heat input capacity >100 MMBtu/hr? NO→use Subpart Dc instead
Q3: Construction commenced after June 19, 1984? NO→not subject
Q4: Is it a recovery furnace at a kraft pulp mill? YES→use Subpart BB instead
Q5: Is it a waste heat boiler? Some exemptions available
 
Subject → determine fuel:
NATURAL GAS: exempt from SO2 and PM emission limits; NOx limits may apply
  §60.44b NOx limits for gas-fired: 0.20 lb/MMBtu (>300 MMBtu/hr), 0.30 (≤300)
OIL-FIRED: §60.42b SO2 limits 0.80 lb/MMBtu; PM 0.10 lb/MMBtu
COAL-FIRED: §60.42b SO2 and PM limits; §60.43b NOx limits
§60.47b monitoring: continuous opacity, SO2, NOx monitoring
§60.48b notification: initial notification within 30 days of startup
§60.49b recordkeeping requirements
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
7. 40 CFR 60 SUBPART Dc — SMALL BOILER NSPS (10-100 MMBtu/hr)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it an industrial/commercial/institutional steam generating unit? NO→not subject
Q2: Heat input capacity ≥10 MMBtu/hr AND ≤100 MMBtu/hr? NO→different subpart
Q3: Construction commenced after June 9, 1989? NO→not subject
Q4: Does it use a listed exempted fuel (natural gas, distillate oil)? 
    YES (natural gas/distillate oil): EXEMPT from SO2 and PM LIMITS but:
    - STILL subject to opacity standard (20%)
    - STILL subject to notification and recordkeeping
    - STILL subject to fuel monitoring
 
NATURAL GAS/DISTILLATE OIL fired:
  §60.40c(d) exemption from SO2 PM limits
  §60.43c SO2 limits if using other fuels
  §60.44c opacity standard 20%
  §60.48c notification: initial notification required
  §60.49c recordkeeping: fuel records required
 
OTHER FUELS (residual oil, coal, biomass):
  §60.42c SO2 limits
  §60.43c PM limits  
  §60.44c opacity 20% limit
  Full testing and monitoring requirements
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
8. 40 CFR 63 SUBPART DDDDD — MAJOR SOURCE BOILER MACT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it an industrial/commercial/institutional boiler or process heater? NO→not subject
Q2: Is it at a MAJOR HAP source? NO→use Subpart JJJJJJ (area source boilers)
Q3: Is it an electric utility steam generating unit subject to Subpart UUUUU? YES→exempt
Q4: Is it a temporary boiler (≤12 consecutive months)? YES→exempt
Q5: Is heat input capacity <10 MMBtu/hr? YES→limited requirements only
Q6: Construction commenced after June 4, 2010? Determines new vs existing
 
NEW major source boilers (after Jun 4 2010):
  §63.7500 Table 2 emission limits by subcategory and fuel type
  HAP metals, CO, mercury limits apply
  §63.7510 initial compliance testing
  §63.7515 continuous compliance monitoring
  §63.7545 initial notification
  §63.7550 recordkeeping
 
EXISTING major source boilers (before Jun 4 2010):
  §63.7500 Table 2 (different columns) emission limits
  Tune-up requirements §63.7540
  Energy assessment required §63.7530
  Compliance dates per §63.7495
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
9. 40 CFR 63 SUBPART JJJJJJ — AREA SOURCE BOILER NESHAP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it an industrial/commercial/institutional boiler or process heater? NO→not subject
Q2: Is it at an AREA HAP source? NO→use Subpart DDDDD (major source)
Q3: Is it a temporary boiler (≤12 consecutive months)? YES→exempt
Q4: Is it a residential boiler? YES→generally exempt
 
NATURAL GAS-FIRED at area source:
  §63.11196(e) EXEMPT from emission limits
  Only tune-up requirements per §63.11223
  No performance testing required
 
FUEL OIL/BIOMASS/COAL at area source:
  §63.11210 Table 1 emission limits (CO, mercury, PM if applicable)
  ≥10 MMBtu/hr: performance testing required
  <10 MMBtu/hr: work practice standards only
  §63.11222 initial notification required
  §63.11225 tune-up requirements every 2 years (or annually if ≥1 MMBtu/hr oil/gas seasonal)
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
10. 40 CFR 60 SUBPART Kb — VOL STORAGE TANK NSPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a storage vessel (tank) storing volatile organic liquid (VOL)? NO→not subject
Q2: Construction commenced after July 23, 1984? NO→use K or Ka
Q3: Capacity ≥75 m3 (19,812 gallons)? NO→not subject
Q4: True vapor pressure (TVP) of stored liquid ≥27.6 kPa (4.0 psia)? NO→not subject
Q5: Is it a pressure vessel (no emissions at storage conditions)? YES→exempt
Q6: Is it used for wastewater treatment? YES→may be exempt
 
Subject → determine control requirements by capacity and TVP:
≥75 m3 AND TVP ≥27.6 kPa: basic requirements
≥151 m3 (39,894 gal) AND TVP ≥27.6 kPa: internal floating roof OR
≥151 m3 AND TVP ≥76.6 kPa (11.1 psia): external floating roof or equivalent
§60.112b control equipment requirements
§60.113b inspection requirements  
§60.115b notification requirements
§60.116b recordkeeping
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
11. 40 CFR 60 SUBPART WWW — MUNICIPAL SOLID WASTE LANDFILL NSPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a municipal solid waste (MSW) landfill? NO→not subject
Q2: Construction commenced after May 30 1991? NO→use emission guidelines (Subpart Cc)
Q3: Design capacity ≥2.5 million Mg AND ≥2.5 million m3? NO→not subject
Q4: NMOC emissions ≥50 Mg/yr? NO→not subject yet (monitor and recalculate annually)
 
SUBJECT → determine GCCS installation status:
 
NO GCCS INSTALLED (NMOC first exceeds 50 Mg/yr):
  §60.752(b)(1) must install GCCS within 30 months of exceeding threshold
  §60.752(b)(2) submit GCCS design plan to state within 1 year of exceeding threshold
  §60.755 monitoring: quarterly surface methane, semi-annual wellhead
  §60.756(a) initial design plan report
  §60.756(b) annual reports
 
GCCS INSTALLED AND OPERATING:
  §60.752(b)(2)(ii) GCCS operational standards
  §60.753(a) operate GCCS to maintain wellhead pressure <0 inches H2O
  §60.753(b) monthly wellhead monitoring — temperature, nitrogen, oxygen
  §60.753(c) quarterly surface methane monitoring
  §60.753(d) quarterly GCCS performance monitoring
  §60.754 test methods (Method 2, 3C, 25C)
  §60.755(a) operational monitoring requirements
  §60.755(b) surface emission monitoring
  §60.756(a) initial annual report
  §60.756(b) annual reports — include wellhead data, surface monitoring, deviations
  §60.756(c) semi-annual reports if monitoring shows exceedances
 
GCCS REMOVAL (POST-CLOSURE):
  §60.752(b)(2)(v) GCCS must operate until NMOC <50 Mg/yr for 3 consecutive years
  Must demonstrate NMOC rate below threshold before removing GCCS
 
LEGACY CONTROLLED LANDFILL (pre-existing GCCS before rule):
  Previously submitted design plans — certify previously submitted rather than resubmit
  §60.756(c) annual certification of previously submitted reports
 
40 CFR 62 SUBPART OOO — MSW LANDFILL FEDERAL PLAN (existing landfills)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it an existing MSW landfill (construction before May 30 1991)? NO→use WWW
Q2: Design capacity ≥2.5 million Mg? NO→not subject
Q3: NMOC ≥50 Mg/yr? NO→not subject
 
GCCS INSTALLATION REQUIREMENTS:
  §62.16714(b) GCCS must be installed within 30 months of exceeding NMOC threshold
  §62.16714(c) GCCS design capacity must handle maximum gas generation rate
  §62.16714(f) requirements prior to GCCS removal — must demonstrate NMOC <50 Mg/yr
 
GCCS OPERATIONAL STANDARDS:
  §62.16716(a) operate to maintain negative pressure at each wellhead
  §62.16716(b) monthly wellhead monitoring — flow rate, pressure, temperature, N2, O2
  §62.16716(c) address exceedances within 15 days
  §62.16716(d) quarterly surface methane monitoring (500 ppm action level)
  §62.16716(e) repair surface exceedances within 60 days
  §62.16716(f) quarterly GCCS performance monitoring
  §62.16716(g) minimize emissions during planned shutdowns
 
POST-CLOSURE REQUIREMENTS:
  §62.16718(b) operate GCCS for 30 years after closure or until NMOC <50 Mg/yr
  §62.16718(d) continue monitoring requirements after closure
 
MONITORING:
  §62.16722(a) wellhead monitoring — monthly
  §62.16722(c) surface monitoring — quarterly
  §62.16722(e) control device monitoring — continuous
  §62.16722(f) GCCS flow rate monitoring
  §62.16722(g) gas collection efficiency monitoring
  §62.16722(h) NMOCs at control device inlet/outlet
 
REPORTING:
  §62.16724(a) initial design plan submittal
  §62.16724(b) initial performance test report
  §62.16724(c)-(f) annual reports
  §62.16724(g)-(h) semi-annual compliance reports
  §62.16724(i)-(l) startup/shutdown/malfunction reports
  §62.16724(q) LEGACY LANDFILL: certify previously submitted reports rather than resubmit
 
RECORDKEEPING:
  §62.16726(a) wellhead monitoring records — 5 years
  §62.16726(b) surface monitoring records — 5 years
  §62.16726(c) control device records — 5 years
  §62.16726(d) collection efficiency records
  §62.16726(e) NMOC calculation records
  §62.16726(f) design plan and amendments
  §62.16726(g) equipment maintenance records
  §62.16726(h) operator certification
  §62.16726(l) LEGACY LANDFILL: records of previously submitted certifications
 
COLLECTION SYSTEM SITING AND CONSTRUCTION:
  §62.16728(a) wells must be placed to maximize gas collection
  §62.16728(b) pipes must be constructed to withstand landfill settlement
 
40 CFR 63 SUBPART AAAA — MSW LANDFILL NESHAP (HAP emissions)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it an MSW landfill? NO→not subject
Q2: NMOC >34 Mg/yr (for major sources) OR NMOC >50 Mg/yr (for area sources)? 
    NO→not subject to GCCS requirements
Q3: Is it at a major HAP source? Determines which NMOC threshold applies
 
COMPLIANCE DATES:
  §63.1930(b) new sources: comply upon startup
  §63.1930(b) existing sources: comply per original compliance schedule
 
GCCS REQUIREMENTS:
  §63.1955(c) minimize emissions from the GCCS — operate to minimize LFG releases
  §63.1957(a) GCCS must operate continuously except during planned maintenance
  §63.1958(a) wellhead gas temperature <55°C
  §63.1958(b) wellhead oxygen content <5% by volume
  §63.1958(c) wellhead nitrogen content <20% by volume
  §63.1958(d) monthly wellhead parameter monitoring
  §63.1958(e) address parameter exceedances within 5 days
  §63.1958(f) quarterly surface monitoring
  §63.1958(g) GCCS must operate all collection wells continuously
 
GCCS DESIGN:
  §63.1959(b)(2) GCCS design must account for settlement and subsidence
 
COLLECTION STANDARDS:
  §63.1960(a) collection wells spaced to capture all LFG
  §63.1960(b) wellhead fittings must minimize LFG releases
  §63.1960(c) pipes must minimize leaks
  §63.1960(d) GCCS must handle maximum design gas flow
 
MONITORING:
  §63.1961(a) continuous monitoring of control device operating parameters
  §63.1961(c) monthly wellhead monitoring
  §63.1961(e) quarterly surface emission monitoring
  §63.1961(f) quarterly GCCS performance
  §63.1961(g) record all monitoring data
  §63.1961(h) address monitoring exceedances
 
SITING AND CONSTRUCTION:
  §63.1962(a) wells in waste mass to maximize capture
  §63.1962(b) pipes sloped to prevent condensate accumulation
  §63.1962(c) connect new waste areas within 5 years of waste placement
 
SSM PROVISIONS:
  §63.1964(b) SSM provisions NO LONGER APPLY after September 27 2021
  Must maintain compliance at all times including startup shutdown malfunction
 
REPORTING:
  §63.1981 annual compliance report required
  Include: wellhead monitoring data, surface monitoring, deviations, GCCS performance
 
RECORDKEEPING:
  §63.1983(a) wellhead monitoring records
  §63.1983(b) surface monitoring records
  §63.1983(c) control device operating records
  §63.1983(d) NMOC calculation records
  §63.1983(e) design plan and amendments
  §63.1983(f) startup/shutdown records
  §63.1983(g) equipment maintenance records
  §63.1983(h) operator training records
 
LEGACY CONTROLLED LANDFILL distinction:
  Landfills that had GCCS installed before the rule compliance date
  §63.1981 reports: certify previously submitted reports rather than full resubmission
  Must maintain certification records showing previous submissions
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
12. 40 CFR 60 SUBPART OOO — NONMETALLIC MINERAL PROCESSING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a nonmetallic mineral processing plant (crushing, screening, grinding)? NO→not subject
Q2: Construction commenced after August 31, 1983? NO→not subject (for most)
Q3: Is it a wet process operation? Some exemptions for wet processes
 
Subject → PM emission limits and opacity standards
§60.672 PM and opacity limits for each affected facility
§60.674 monitoring requirements (opacity)
§60.675 test methods
§60.676 recordkeeping
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
13. 40 CFR 60 SUBPART I — HOT MIX ASPHALT NSPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a hot mix asphalt (HMA) facility? NO→not subject
Q2: Construction commenced after June 11, 1973? NO→not subject
PM standard: 90 mg/dscm (0.04 gr/dscf)
Opacity standard: 20%
§60.92 PM limits | §60.93 opacity | §60.94 monitoring | §60.96 recordkeeping
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
14. 40 CFR 60 SUBPART F — PORTLAND CEMENT NSPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a Portland cement plant? NO→not subject
Q2: Construction commenced after August 17, 1971? NO→not subject
Kilns: PM 0.15 kg/Mg, opacity 20%
Clinker coolers: PM 0.050 kg/Mg, opacity 10%
Raw mills, finish mills: opacity 20%
§60.62 emission limits | §60.63 monitoring | §60.65 recordkeeping
NOTE: Subpart LLL (NESHAP) likely also applies at major sources
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
15. 40 CFR 63 SUBPART S — PULP AND PAPER NESHAP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a pulp or paper production facility? NO→not subject
Q2: Is it at a major HAP source? NO→area source rules may apply instead
Q3: CRITICAL: What pulping process is used?
  KRAFT (sulfate): SUBJECT §63.440
  SULFITE: SUBJECT §63.440
  SODA: SUBJECT §63.440
  SEMI-CHEMICAL: SUBJECT §63.440
  MECHANICAL PULPING (groundwood, TMP, CTMP, SGW): NOT SUBJECT TO SUBPART S
  SECONDARY FIBER/RECYCLED PAPER: NOT SUBJECT TO SUBPART S
  PAPER-ONLY (no pulping): NOT SUBJECT TO SUBPART S
Q4: Construction commenced after April 15, 1998? New vs existing
 
Subject (chemical pulping only):
§63.443 emission standards for pulping systems
§63.444 emission standards for bleach plants
§63.445 emission standards for condensate streams
§63.446 alternative standard for total HAP
§63.457 monitoring requirements
§63.458 recordkeeping and reporting
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
16. 40 CFR 60 SUBPART BB — KRAFT PULP MILL NSPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a kraft pulp mill? NO→not subject
Q2: Construction commenced after September 24, 1976? NO→not subject
TRS (total reduced sulfur) emission limits for:
  Recovery furnaces, smelt dissolving tanks, lime kilns
§60.282 TRS standards | §60.283 opacity | §60.284 monitoring
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
17. 40 CFR 63 SUBPART M — DRY CLEANING NESHAP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a dry cleaning facility using perchloroethylene (PCE)? NO→not subject
Q2: Is it at a major OR area source? Both covered (different requirements)
MAJOR SOURCE: strict PCE emission limits, refrigerated condenser, carbon adsorber
AREA SOURCE: equipment standards, leak inspection, recordkeeping
§63.320 applicability | §63.322 standards | §63.324 monitoring | §63.325 recordkeeping
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
18. 40 CFR 63 SUBPART N — CHROME ELECTROPLATING NESHAP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a chromium electroplating or anodizing tank? NO→not subject
Q2: Major or area source? Both covered
DECORATIVE: different limits than hard chrome
HARD CHROME: stricter limits
Tank type and rectifier amperage determine category
§63.341 emission limits | §63.342 compliance requirements | §63.346 recordkeeping
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
19. 40 CFR 63 SUBPART CCCC — COMMERCIAL/INDUSTRIAL SOLID WASTE INCINERATOR (CISWI)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a commercial/industrial solid waste incineration unit? NO→not subject
Q2: Is it burning RCRA hazardous waste? YES→use Subpart EEE instead
Q3: Is it burning MSW at a facility >250 tons/day? YES→use Subpart Eb instead
Q4: Does it burn pathological/medical/infectious waste? YES→may use Subpart Ec
Q5: Construction commenced after November 30, 1999? New vs existing
Emission limits for PM, CO, dioxins, mercury, cadmium, lead, HCl, SO2, NOx
§63.1200-§63.1209 requirements
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
20. 40 CFR 63 SUBPART EEE — HAZARDOUS WASTE COMBUSTOR NESHAP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it burning RCRA hazardous waste as defined in 40 CFR Part 261? NO→not subject
Q2: Types covered: hazardous waste incinerators, cement kilns burning HW,
    lightweight aggregate kilns burning HW, solid fuel boilers burning HW,
    liquid fuel boilers burning HW, hydrochloric acid production furnaces burning HW
Q3: NON-RCRA pharmaceutical waste: NOT subject to EEE → evaluate CISWI (CCCC) instead
Emission limits: dioxins/furans, mercury, PM, semivolatile metals, low-volatile metals, HCl/Cl2, CO, HC
§63.1203 emission standards | §63.1206 compliance | §63.1209 reporting
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
21. 40 CFR 60 SUBPART OOOO/OOOOa/OOOOb — OIL AND GAS NSPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a crude oil or natural gas production/processing/transmission/storage facility? NO→not subject
Q2: Determine which subpart by construction date:
  After Aug 23 2011 through Sep 18 2015: Subpart OOOO
  After Sep 18 2015 through Dec 6 2022: Subpart OOOOa
  After Dec 6 2022: Subpart OOOOb (2024 rule — most stringent)
Covered equipment: wells, separators, tanks, compressors, dehydrators,
  pneumatic controllers, fugitive emission components
OOOOb adds: methane standards, enhanced fugitive monitoring, new well requirements
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
22. 40 CFR 63 SUBPART FFFF — MON (ORGANIC CHEMICAL MFGR, MAJOR SOURCE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a miscellaneous organic chemical manufacturing operation? NO→not subject
Q2: Is it at a MAJOR HAP source? NO→use Subpart VVVVVV (area source) instead
Q3: Construction commenced after April 4, 2002? New vs existing
Covers: process vents, storage tanks, wastewater, equipment leaks, heat exchangers
§63.2440 emission limits | §63.2450 compliance | §63.2520 recordkeeping
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
23. 40 CFR 68 — RISK MANAGEMENT PROGRAM (RMP)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Does facility have a regulated substance? Check 40 CFR 68.130 list
Q2: Is quantity above threshold quantity (TQ)?
  Toxic substances: ammonia (anhydrous) 10,000 lb, chlorine 2,500 lb,
    HF 1,000 lb, sulfur dioxide 5,000 lb, phosgene 500 lb, many others
  Flammable substances: LPG/propane/butane 10,000 lb, hydrogen 10,000 lb,
    gasoline 75,000 lb, crude oil 42,000 lb, natural gas 10,000 lb
Q3: If above TQ → determine Program level:
  Program 1: worst-case scenario has no offsite impact, no accident history
  Program 2: not Program 1 or 3 requirements
  Program 3: SIC codes listed in §68.10(d)(1), or subject to OSHA PSM
§68.150 Risk Management Plan required | §68.155-§68.185 plan elements
Submit RMP to EPA Central Data Exchange every 5 years
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
24. 40 CFR 98 — GHG MANDATORY REPORTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Does facility emit ≥25,000 metric tons CO2e per year? NO→not subject
Q2: Is any source category listed in §98.2(a) present regardless of threshold?
  (Certain source categories subject regardless of emissions)
Subpart C (stationary combustion): applies to all combustion units
  Threshold: facility-wide stationary combustion emissions ≥25,000 MT CO2e
  Large boilers (>250 MMBtu/hr continuous), large turbines, cement kilns typically exceed
Annual reporting to EPA by March 31 for prior year
§98.3 general requirements | §98.32-§98.36 stationary combustion calculation methods
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
25. 40 CFR 82 — STRATOSPHERIC OZONE/REFRIGERANTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Does facility use, purchase, recover, recycle, or dispose of refrigerants? NO→not subject
Q2: Are the refrigerants Class I (CFCs) or Class II (HCFCs) or HFCs? 
  Class I: R-11, R-12, R-113, R-114, R-115, carbon tetrachloride, methyl chloroform
  Class II: R-22, R-123, R-124, R-141b, R-142b, R-225
  NO SIZE THRESHOLD — applies to any amount
Subpart F requirements:
  §82.154 venting prohibited — illegal to vent refrigerants to atmosphere
  §82.156 safe disposal requirements
  §82.158 reclaim requirements — must use certified reclaimer
  §82.160 recordkeeping for all refrigerant purchases/recovery
  EPA-certified technicians required for servicing (§82.161)
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
26. 401 KAR CHAPTER 59 — NEW EQUIPMENT STANDARDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a NEW stationary source? NO→use 401 KAR Chapter 61
Q2: Construction commenced after July 2, 1975? NO→use Chapter 61
Q3: Is it a simple combustion engine or turbine? YES→NOT subject to process 
    emission standards (federal NSPS/NESHAP covers those sources instead)
Q4: Is it a process operation (boiler, indirect heat exchanger, dryer, kiln,
    chemical reactor, coating line, process unit converting materials)?
    YES→subject to 401 KAR 59 process emission standards
 
APPLIES TO:
  Indirect heat exchangers (boilers, process heaters): 401 KAR 59:016
  Process operations: 401 KAR 59:015 (visible emissions 20% opacity)
  Incinerators in Kentucky: 401 KAR 59:020
 
DOES NOT APPLY TO:
  CI or SI stationary engines (covered by Subpart IIII/JJJJ)
  Combustion turbines (covered by Subpart KKKK/YYYY)
  Sources subject to specific state chapter (e.g., Chapter 64 for incinerators)
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
27. 401 KAR CHAPTER 61 — EXISTING EQUIPMENT STANDARDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Same applicability as Chapter 59 but for EXISTING sources
Construction commenced on or before July 2, 1975
Same exemptions for engines and turbines as Chapter 59
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
28. 401 KAR 52:070 — REGISTRATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is the source subject to any applicable requirement in 40 CFR Parts 60, 61, or 63?
    YES→Registration automatically required regardless of emission level
Q2: OR does source have PTE ≥10 tpy of any regulated pollutant (below major threshold)?
    YES→Registration required
Forms: DEP7007AI through DEP7007HH
Must register BEFORE commencing construction
Annual compliance certification required
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
29. 40 CFR 63 SUBPART EEEEE — INTEGRATED IRON AND STEEL NESHAP (MAJOR SOURCE)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it an integrated iron and steel manufacturing facility? NO→not subject
    Integrated = facility that uses blast furnace OR electric arc furnace
    to produce steel from iron ore or scrap, includes all associated operations
Q2: Is it at a MAJOR HAP source? NO→use Subpart FFFFF (if applicable)
Q3: Construction commenced after January 5, 2004? New vs existing
Affected sources: EAF, argon-oxygen decarburization (AOD) vessels, 
    ladle metallurgy furnace (LMF), continuous casting, reheat furnace,
    blast furnace, basic oxygen furnace, slab reheat
§63.7782 emission limits for PM, D/F, Pb, Hg, HCl
§63.7790 operation and maintenance requirements
§63.7800 performance testing requirements
§63.7810 monitoring requirements — baghouse operating parameters
§63.7821 recordkeeping requirements
§63.7822 reporting requirements
NOTE: SIC 3312 major source → Subpart EEEEE almost certainly applies
NOTE: Subpart YYYYY (area source EAF) does NOT apply to major sources
 
30. 40 CFR 60 SUBPART AAa — EAF NSPS (1983-2022)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it an electric arc furnace (EAF) or AOD vessel? NO→not subject
Q2: Construction after Aug 17 1983 AND on or before May 16 2022? NO→use AA or AAb
Subject → PM emission limit 0.0052 gr/dscf from control device
§60.270a applicability | §60.272a emission limits
§60.273a opacity standards: 0% control device exit, 6% melt shop fugitives
§60.274a continuous monitoring of baghouse parameters
§60.276a recordkeeping and reporting
 
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NSR/PSD FLOW CHART
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is source new or undergoing major modification? NO→NSR/PSD not triggered
Q2: Is source in an attainment or unclassifiable area for the pollutant?
    YES→PSD applies if major | NO→Nonattainment NSR applies if major
Q3: Is source a major stationary source?
    Listed source category: PTE ≥100 tpy any regulated pollutant
    Unlisted source category: PTE ≥250 tpy any regulated pollutant
    Major modification: significant emission increase (NOx/VOC/SO2: ≥40 tpy,
      PM10: ≥15 tpy, PM2.5: ≥10 tpy, CO: ≥100 tpy, lead: ≥0.6 tpy)
 
PSD APPLIES → 401 KAR 55:005, 401 KAR 55:010, 40 CFR 52.21
  BACT analysis required
  Air quality impact analysis
  Class I area review if within 100 km
  Preconstruction permit BEFORE construction begins
 
NONATTAINMENT NSR → 401 KAR 56:005
  LAER required
  Offsets required (ratio depends on area classification)
  Alternative siting analysis
 
MINOR NSR/STATE PERMIT → 401 KAR 52:020 or 52:030
  Below major thresholds but subject to applicable requirements
`;
 
app.post('/check', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'API key not configured.' });
  const body = req.body;
  if (!body.equipmentCategory && !body.description) {
    return res.status(400).json({ error: 'Provide equipment type or description.' });
  }
 
  try {
    // Search for relevant regulations
    const regs = await searchRegulations(body, 35);
 
    // Fetch FULL TEXT of the most likely applicable regulations
    // This allows Gemini to reason through every paragraph, not just memory
    const fullTextRegs = await fetchApplicableRegTexts(body);
    console.log(`Using ${fullTextRegs.length} full-text regulations for deep analysis`);
 
    // Build regulation context — full text first, then search results
    const fullTextContext = fullTextRegs.length > 0
      ? fullTextRegs.map(r =>
          `===== FULL REGULATION TEXT: ${r.title} =====\nCFR: 40 CFR Part ${r.part}${r.subpart ? ' Subpart '+r.subpart : ''}\nURL: ${r.url||'N/A'}\n\n${(r.content||'').slice(0, 8000)}\n`
        ).join('\n' + '='.repeat(60) + '\n')
      : '';
 
    const searchContext = regs.length > 0
      ? regs.filter(r => !fullTextRegs.find(f => f.id === r.id))
           .map(r =>
          `=== ${r.title} ===\nSource: ${r.source === 'federal'
            ? `40 CFR Part ${r.part}${r.subpart ? ' Subpart '+r.subpart : ''}`
            : r.part}\nURL: ${r.url||'N/A'}\n${(r.content||'').slice(0,500)}\n`
        ).join('\n---\n')
      : '';
 
    const regContext = [
      fullTextContext ? `FULL REGULATION TEXTS (read carefully — reason through every paragraph):\n${fullTextContext}` : '',
      searchContext ? `ADDITIONAL REGULATIONS FROM DATABASE:\n${searchContext}` : '',
      (!fullTextContext && !searchContext) ? 'No database results — use flow chart logic and regulatory knowledge.' : ''
    ].filter(Boolean).join('\n\n');
 
    const controlCtx = buildControlCtx(body.controlDevices);
    const hasDevices = body.controlDevices && body.controlDevices.length > 0;
 
    // Build landfill-specific context
    const isLandfill = (body.equipmentCategory||'').toLowerCase().includes('landfill');
    const landfillCtx = isLandfill ? [
      body.landfillDesignCapacity ? `Landfill design capacity: ${body.landfillDesignCapacity}` : '',
      body.landfillNmocRate ? `NMOC emission rate: ${body.landfillNmocRate} Mg/yr` : '',
      body.landfillGccsInstalled ? `GCCS installed: ${body.landfillGccsInstalled}` : '',
      body.landfillWellCount ? `Number of extraction wells: ${body.landfillWellCount}` : '',
      body.landfillStatus ? `Landfill status: ${body.landfillStatus}` : '',
      body.landfillOpenYear ? `Landfill open year: ${body.landfillOpenYear}` : '',
      body.landfillCloseYear ? `Landfill close year: ${body.landfillCloseYear}` : '',
      body.landfillControlDevice ? `LFG control device: ${body.landfillControlDevice}` : '',
      body.landfillGhgEmissions ? `Annual GHG emissions: ${body.landfillGhgEmissions} MT CO2e` : '',
    ].filter(Boolean).join('\n') : '';
 
    const equipDetails = [
      `Equipment category: ${body.equipmentCategory||'Not specified'}`,
      `Equipment use: ${body.equipmentType||'Not specified'}`,
      `Fuel type: ${body.fuelType||'Not specified'}`,
      `Capacity: ${body.capacity||'Not specified'}`,
      `Construction date: ${body.constructDate||'Not specified'}`,
      `Model year: ${body.modelYear||'Not specified'}`,
      `Source class (HAP): ${body.sourceClass||'Not specified'}`,
      `Regulated pollutant class: ${body.pollutantClass||'Not specified'}`,
      `SIC code: ${body.sicCode||'Not specified'}`,
      `Control devices:\n${controlCtx}`,
      landfillCtx ? `LANDFILL-SPECIFIC DETAILS:\n${landfillCtx}` : '',
      body.description ? `Additional info: ${body.description}` : ''
    ].filter(Boolean).join('\n');
 
    const prompt = `You are an expert Kentucky air quality permitting engineer at the Kentucky EEC Division for Air Quality.
 
RELEVANT REGULATIONS FROM DATABASE (${regs.length} retrieved):
${regContext}
 
SOURCE DETAILS:
${equipDetails}
 
${TCEQ_FLOW_CHART_LOGIC}
 
=====================================================================
INSTRUCTIONS
=====================================================================
1. READ THE FULL REGULATION TEXT PROVIDED ABOVE CAREFULLY.
   The full text of the most likely applicable regulations has been provided.
   Do NOT rely on memory — read the actual text and reason through every
   paragraph, table, and condition. Check every exemption. Follow every
   cross-reference. This is how a permit engineer would actually read the CFR.
 
2. Use the TCEQ-style flow chart logic to structure your analysis.
   For each regulation: Q1, Q2, Q3... in order. First NO = not subject.
 
3. PARAGRAPH-LEVEL CITATIONS ARE REQUIRED:
   Do not just cite the subpart. Cite the SPECIFIC PARAGRAPHS that apply
   to this source based on its characteristics. For example:
   WRONG: "40 CFR 62 Subpart OOO applies"
   RIGHT: "§62.16714(b),(c) — GCCS installation within 30 months;
           §62.16716(a)-(g) — GCCS operational standards;
           §62.16722(a),(c),(e),(f),(g),(h) — monitoring requirements;
           §62.16724(a)-(l),(q) — reporting requirements;
           §62.16726(a)-(h),(l) — recordkeeping requirements"
   
   For each applicable regulation, determine which specific paragraphs
   apply based on the source's characteristics (size, GCCS status,
   new vs existing, major vs area source, etc.)
 
3. CONDITIONAL LOGIC — only cite paragraphs that actually apply:
   - If GCCS is installed: cite operational monitoring paragraphs
   - If GCCS is NOT yet installed: cite installation requirement paragraphs
   - If legacy controlled landfill: cite certification paragraphs not resubmission
   - If post-closure: cite post-closure requirement paragraphs
   - SSM provisions after Sep 27 2021: flag as no longer applicable
 
2. Only include regulations that are RELEVANT to this equipment type.
   Do not include all 428 regulations — only those plausibly applicable.
 
3. For each applicable regulation, cite the SPECIFIC SECTIONS that apply
   to this particular source based on its characteristics.
 
4. Auto-determine new vs existing from construction date ${body.constructDate||'NOT PROVIDED'}
   using each regulation's own cutoff date from the flow charts above.
 
5. NSR/PSD: Always evaluate using the flow chart above.
 
6. CAM (40 CFR Part 64): For each control device, evaluate all 3 criteria:
   (1) numeric emission limit exists, (2) add-on control device used to comply,
   (3) pre-control PTE >100 tpy. ALL three must be yes.
   ${!hasDevices ? 'No control devices → CAM does not apply.' : ''}
 
Respond ONLY with valid JSON:
{
  "summary": "3-4 sentences specific to this source — regulations found, new/existing status, most important actions",
  "newExistingDetermination": "Per-regulation: cutoff date, construction date, conclusion",
  "dataQuality": "complete|partial|insufficient",
  "missingInfo": ["specific missing item and why needed"],
  "regulations": [
    {
      "id": "unique-id",
      "name": "e.g. 40 CFR 60 Subpart IIII",
      "fullName": "Full descriptive name",
      "category": "Federal NSPS|Federal NESHAP|Federal NSR/PSD|Federal Other|Kentucky State",
      "status": "applies|not-applies|needs-info",
      "badge": "Applies|Does not apply|More info needed",
      "newExisting": "New source|Existing source|N/A|Needs construction date",
      "flowChartResult": "Q1: Yes — CI engine. Q2: Yes — after Jul 11 2005. Q3: Yes — <30 L/cyl. No exemptions apply → SUBJECT",
      "reason": "2-3 sentences explaining determination with specific thresholds and source characteristics",
      "cite": "§60.4200(a)(2) — applies because CI engine after Jul 11 2005; §60.4205(a) — emergency engine emission standards table; §60.4205(b) — opacity limit 20%; §60.4207 — ULSD <15 ppm sulfur required at all times; §60.4211(a) — operate per manufacturer written instructions; §60.4211(f)(1) — max 100 hrs/yr maintenance/testing; §60.4211(f)(2) — max 50 hrs/yr non-emergency use; §60.4211(f)(3) — non-resettable hour meter required; §60.4214(b) — no initial notification required for emergency engines; §60.4214(b)(1) — maintain hour meter records",
      "keyRequirements": ["Specific requirement 1", "Specific requirement 2", "Specific requirement 3"],
      "controlDeviceNotes": "How each device affects this regulation",
      "url": "Direct eCFR URL to the specific section — format: https://www.ecfr.gov/current/title-40/chapter-I/subchapter-C/part-60/subpart-IIII/section-60.4205 — for paragraph links add #p-60.4205(a)"
    }
  ],
  "nsrPsd": {
    "psdStatus": "applies|not-applies|needs-info",
    "psdReason": "Flow chart result with PTE thresholds",
    "nonattainmentStatus": "applies|not-applies|needs-info",
    "nonattainmentReason": "Explanation",
    "minorNsrStatus": "applies|not-applies|needs-info",
    "minorNsrReason": "Explanation",
    "cite": "401 KAR 55:005, 401 KAR 55:010, 40 CFR 52.21"
  },
  "permitType": {
    "determination": "Registration (401 KAR 52:070)|State Origin Permit (401 KAR 52:040)|Conditional Major|Title V (401 KAR 52:020)|No permit required|Needs more info",
    "reason": "Explanation with thresholds"
  },
  "camApplicability": {
    "status": "applies|not-applies|needs-info",
    "devices": [
      {
        "device": "Device name and pollutant",
        "criterion1": "Numeric emission limit? Yes/No — cite specific limit",
        "criterion2": "Add-on control device? Yes/No",
        "criterion3": "Pre-control PTE >100 tpy? Yes/No/Unknown",
        "conclusion": "CAM applies/not-applies/needs-info"
      }
    ],
    "reason": "Overall CAM conclusion"
  }
}
Order: applies first, needs-info second, not-applies last.`;
 
    const gemResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 8192, responseMimeType: 'application/json' }
        })
      }
    );
 
    const gemData = await gemResp.json();
    if (!gemResp.ok) return res.status(500).json({ error: 'Gemini error: ' + (gemData?.error?.message||'Unknown') });
 
    const rawText = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) return res.status(500).json({ error: 'Empty response.' });
 
    const cleaned = rawText.replace(/```json/g,'').replace(/```/g,'').trim();
    const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
    if (s === -1 || e === -1) return res.status(500).json({ error: 'No JSON. Raw: '+rawText.slice(0,300) });
 
    const parsed = JSON.parse(cleaned.slice(s, e+1));
    parsed.regulationsSearched = regs.length;
    parsed.fullTextRegsUsed = fullTextRegs.length;
    parsed.fullTextRegNames = fullTextRegs.map(r => `40 CFR Part ${r.part}${r.subpart ? ' Subpart '+r.subpart : ''}`);
 
    try {
      await dbInsert('determinations', {
        equipment_type: body.equipmentCategory || body.description || 'Unknown',
        equipment_details: body,
        results: parsed,
        created_at: new Date().toISOString()
      });
    } catch (e) { console.log('History save:', e.message); }
 
    res.json(parsed);
 
  } catch (err) {
    console.error('Check error:', err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});
 
app.listen(PORT, () => {
  console.log(`EEC AI Assistant API v14.0 running on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? 'SET' : 'MISSING'} | Gemini: ${GEMINI_API_KEY ? 'SET' : 'MISSING'}`);
});
 
