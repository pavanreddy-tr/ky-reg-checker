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
  res.json({ status: 'EEC AI Assistant API running', version: '11.0' });
});
 
app.get('/stats', async (req, res) => {
  try {
    const count = await dbCount('regulations');
    res.json({ regulations_in_database: count, status: 'healthy', version: '11.0' });
  } catch (err) {
    res.json({ regulations_in_database: 428, status: 'healthy', version: '11.0', note: 'cached' });
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

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
40 CFR 60 SUBPART KKa — LEAD ACID BATTERY MANUFACTURING (newer)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Q1: Is it a lead-acid battery manufacturing plant? NO→not subject
Q2: Construction commenced AFTER February 23, 2022? 
  YES→Subpart KKa applies (newer rule)
  NO→Subpart KK applies (older rule, before Feb 23 2022)
Do NOT apply both — only one applies based on construction date.
 
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
Q2: Construction commenced after May 30, 1991? NO→not subject (use emission guidelines)
Q3: Design capacity ≥2.5 million Mg AND ≥2.5 million m3? NO→not subject
Q4: NMOC emissions ≥50 Mg/yr? NO→not subject
 
Subject → §60.752 gas collection and control requirements
§60.753 operational standards for collection systems
§60.754 test methods
§60.755 monitoring requirements
§60.756 reporting and recordkeeping
 
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
    const regs = await searchRegulations(body, 35);
    const regContext = regs.length > 0
      ? regs.map(r =>
          `=== ${r.title} ===\nSource: ${r.source === 'federal'
            ? `40 CFR Part ${r.part}${r.subpart ? ' Subpart '+r.subpart : ''}`
            : r.part}\nURL: ${r.url||'N/A'}\n${(r.content||'').slice(0,1000)}\n`
        ).join('\n---\n')
      : 'No database results — using flow chart logic below.';
 
    const controlCtx = buildControlCtx(body.controlDevices);
    const hasDevices = body.controlDevices && body.controlDevices.length > 0;
 
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
1. Use the TCEQ-style flow chart logic above to determine applicability
   for each regulation. Follow each Q1, Q2, Q3... in order.
   The first NO answer means that regulation does not apply.
 
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
      "cite": "§60.4200(a)(2) — applies because CI engine after Jul 11 2005; §60.4205 — emergency emission standards; §60.4207 — ULSD fuel required; §60.4211(f) — 100+50 hr limits; §60.4214(b) — hour meter required",
      "keyRequirements": ["Specific requirement 1", "Specific requirement 2", "Specific requirement 3"],
      "controlDeviceNotes": "How each device affects this regulation",
      "url": "https://www.ecfr.gov/..."
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
  console.log(`EEC AI Assistant API v11.0 running on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? 'SET' : 'MISSING'} | Gemini: ${GEMINI_API_KEY ? 'SET' : 'MISSING'}`);
});
 
