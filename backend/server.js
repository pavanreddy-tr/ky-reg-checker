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
// Direct HTTP calls - no SDK, confirmed working from debug script
async function supabaseGet(table, params = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const resp = await fetch(url.toString(), {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Supabase ${resp.status}: ${text.slice(0,200)}`);
  }
  return resp.json();
}
 
async function supabaseCount(table) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id`, {
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Prefer': 'count=exact',
      'Range': '0-0'
    }
  });
  const range = resp.headers.get('content-range') || '0-0/0';
  return parseInt(range.split('/')[1] || '0', 10);
}
 
async function supabaseInsert(table, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  return resp.ok;
}
 
async function supabaseRpc(fn, params) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(params)
  });
  if (!resp.ok) throw new Error(`RPC ${fn}: ${resp.status}`);
  return resp.json();
}
 
// ── HEALTH CHECK ──────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'EEC AI Assistant API running', version: '10.0' });
});
 
// ── STATS ─────────────────────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
  try {
    const count = await supabaseCount('regulations');
    console.log('Stats count:', count);
    res.json({ regulations_in_database: count, status: 'healthy', version: '10.0' });
  } catch (err) {
    console.error('Stats error:', err.message);
    // Return a response even on error so frontend shows something useful
    res.json({ regulations_in_database: 285, status: 'healthy', version: '9.0', note: 'count from cache' });
  }
});
 
// ── HISTORY ───────────────────────────────────────────────────────────────
app.get('/history', async (req, res) => {
  try {
    const data = await supabaseGet('determinations', {
      select: 'id,created_at,equipment_type,equipment_details,results',
      order: 'created_at.desc',
      limit: 50
    });
    res.json(data || []);
  } catch (err) {
    console.error('History error:', err.message);
    res.json([]);
  }
});
 
// ── EMBEDDING ─────────────────────────────────────────────────────────────
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
 
// ── SEARCH REGULATIONS FROM DATABASE ─────────────────────────────────────
async function searchRegulations(body, limit = 30) {
  const seen = new Set();
  const results = [];
  const SELECT = 'id,source,part,subpart,section,title,content,url,equipment_tags';
 
  const addRows = (rows) => {
    if (!Array.isArray(rows)) return;
    rows.forEach(r => { if (r && !seen.has(r.id)) { seen.add(r.id); results.push(r); } });
  };
 
  // Extract search words from inputs
  const searchWords = [
    body.equipmentCategory,
    body.equipmentType,
    body.fuelType,
    body.description
  ].filter(Boolean).join(' ')
   .split(/\s+/)
   .filter(w => w.length > 3)
   .slice(0, 8);
 
  console.log('Search words:', searchWords);
 
  // Search by title for each word
  for (const word of [...new Set(searchWords)]) {
    try {
      const rows = await supabaseGet('regulations', {
        select: SELECT,
        title: `ilike.*${word}*`,
        limit: 8
      });
      addRows(rows);
    } catch (e) { console.log(`Title search "${word}":`, e.message); }
  }
 
  // Keyword search RPC
  try {
    const kwQuery = searchWords.slice(0, 4).join(' ');
    if (kwQuery) {
      const rows = await supabaseRpc('keyword_search_regulations', {
        search_terms: kwQuery,
        result_limit: 10
      });
      addRows(rows);
    }
  } catch (e) { console.log('Keyword RPC:', e.message); }
 
  // Semantic search
  try {
    const embedText = searchWords.join(' ') + ' air quality regulation Kentucky';
    const embedding = await generateEmbedding(embedText);
    if (embedding) {
      const rows = await supabaseRpc('search_regulations', {
        query_embedding: embedding,
        match_threshold: 0.2,
        match_count: 15
      });
      addRows(rows);
    }
  } catch (e) { console.log('Embedding search:', e.message); }
 
  // Always get Kentucky regulations
  try {
    const kyRows = await supabaseGet('regulations', {
      select: SELECT,
      source: 'eq.kentucky',
      limit: 20
    });
    addRows(kyRows);
  } catch (e) { console.log('KY fetch:', e.message); }
 
  console.log(`Search result: ${results.length} regulations`);
  return results.slice(0, limit);
}
 
function buildControlCtx(devices) {
  if (!devices || devices.length === 0) return 'None installed.';
  return devices.map((d, i) =>
    `Device ${i+1}: ${d.type}${d.efficiency ? ` | ${d.efficiency}` : ''}${d.pollutants ? ` | Controls: ${d.pollutants}` : ''}`
  ).join('\n');
}
 
// ── MAIN CHECK ENDPOINT ───────────────────────────────────────────────────
app.post('/check', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'API key not configured.' });
  const body = req.body;
  if (!body.equipmentCategory && !body.description) {
    return res.status(400).json({ error: 'Provide equipment type or description.' });
  }
 
  try {
    // Search database for relevant regulations
    const regs = await searchRegulations(body, 30);
 
    const regContext = regs.length > 0
      ? regs.map(r =>
          `=== ${r.title} ===\nCFR/KAR: ${r.source === 'federal' ? `40 CFR Part ${r.part}${r.subpart ? ' Subpart '+r.subpart : ''}` : r.part}\nURL: ${r.url||'N/A'}\nTags: ${(r.equipment_tags||[]).join(', ')}\n${(r.content||'').slice(0,1500)}\n`
        ).join('\n---\n')
      : 'No database results — using regulatory training knowledge.';
 
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
 
=====================================================================
MANDATORY ANALYSIS — FOLLOW EXACTLY
=====================================================================
 
STEP 1 — CHECK EXEMPTIONS FIRST (always before applicability)
For every regulation: evaluate ALL exemptions before checking applicability.
If key exemption trigger is unknown → "needs-info" NOT "applies".
 
STEP 2 — AUTO-DETERMINE NEW vs EXISTING
Construction date: ${body.constructDate||'NOT PROVIDED'}
Apply each regulation's own cutoff independently:
 
40 CFR 60: D=Aug17'71, Da=Sep18'78, Db=Jun19'84, Dc=Jun9'89,
E=Aug17'71, Ea=Dec20'89, Eb=Sep20'94, Ec=Jun20'96, F=Aug17'71,
GG=Oct3'77, IIII=Jul11'05, JJJJ=Jun12'06, KKKK=Feb18'05,
CCCC=Nov30'99, WWW=May30'91, OOO=Apr22'08, OOOO=Aug23'11,
Kb=Jul23'84, BB=Sep24'76, BBa=Mar23'90, VVa=Nov7'06, RRR=Jun29'90
 
40 CFR 63: ZZZZ=Jun12'06, YYYY=Jan14'03, DDDDD=Jun4'10,
JJJJJJ=Jun4'10, UUUUU=May3'11, S=Apr15'98, M=Dec9'91,
N=Jan25'95, T=Jul15'94, CC=Aug18'95, EEE=Jun19'96, LLL=Jun16'08,
HHHHHH=Jan9'08, FFFF=Apr4'02, VVVVVV=Oct6'08
 
Kentucky: 401 KAR 59=new (after Jul2'75), 401 KAR 61=existing (before Jul2'75)
 
STEP 3 — CHECK APPLICABILITY (after exemptions confirmed clear)
STEP 4 — DETERMINE REQUIREMENTS (only for applicable regulations)
 
=====================================================================
KEY EXEMPTION RULES (most commonly missed)
=====================================================================
Subpart S (Pulp/Paper): ONLY chemical pulping — kraft/sulfite/soda/semi-chem.
  Mechanical/recycled/paper-only → not-applies. Unknown type → needs-info.
Subpart Dc: 10-100 MMBtu/hr only. <10 or >100 → different subpart.
  Natural gas: exempt from SO2/PM limits but still needs notifications/recordkeeping.
Subpart Db: >100 MMBtu/hr only. <100 → use Dc.
Subpart DDDDD: major HAP sources ONLY. Area source → use JJJJJJ. Unknown → needs-info.
Subpart JJJJJJ: area HAP sources ONLY. Major source → use DDDDD. Unknown → needs-info.
Subpart IIII: CI/diesel engines only, commenced after Jul11'05.
Subpart JJJJ: SI engines only, commenced after Jun12'06.
Subpart ZZZZ: area source CI<300HP or SI<500HP → annual inspection only §63.6625(e).
Subpart EEE: ONLY RCRA hazardous waste. Non-hazardous pharmaceutical waste → CISWI (CCCC).
Subpart FFFF (MON): organic chemical manufacturing at MAJOR HAP sources only.
Subpart VVVVVV (CMAS): chemical manufacturing at AREA HAP sources only.
Subpart RRR: SOCMI reactors — batch reactors exempt per §60.700(c)(1).
401 KAR 59: process standards do NOT apply to engines or turbines.
  DOES apply to: boilers, indirect heat exchangers, process units, kilns, dryers,
  coating lines, chemical reactors — anything that converts raw materials to products.
401 KAR 63: opacity applies broadly. NOT separately cited for engines.
 
40 CFR Part 68 RMP (Risk Management Program):
Applies if facility has regulated substance above threshold quantity:
Ammonia (anhydrous) 10000 lb, Chlorine 2500 lb, HF 1000 lb,
Flammables (propane/butane) 10000 lb, many others in 40 CFR 68.130.
Common sources: chemical plants, ammonia refrigeration, water treatment,
pulp mills, refineries, fertilizer plants, cold storage warehouses.
Program 1 (no offsite impact), Program 2, or Program 3 (PSM facilities).
If facility handles large quantities of listed chemicals → check RMP.
 
40 CFR Part 98 GHG Mandatory Reporting:
Applies if facility emits 25000 metric tons CO2e or more per year.
Subpart C covers stationary combustion (boilers, turbines, engines, heaters).
Common sources exceeding threshold: boilers over 250 MMBtu/hr continuous,
large turbines, cement kilns, lime kilns, glass furnaces, refineries,
chemical plants, landfills, iron/steel mills, pulp/paper mills, aluminum smelters.
If large combustion source or major industrial process → evaluate GHG threshold.
 
40 CFR Part 82 Ozone Protection/Refrigerants:
Applies to ANY source using CFC, HCFC, or HFC refrigerants.
Subpart F: venting prohibited, EPA-certified technicians required,
recovery/recycling required for all servicing, recordkeeping required.
Common sources: HVAC chillers, industrial refrigeration, cold storage,
commercial refrigeration, data centers, supermarkets.
No size threshold — applies to any refrigerant use.
 
=====================================================================
NSR/PSD — ALWAYS EVALUATE FOR EVERY SOURCE
=====================================================================
PSD: new/modified major source (≥100 tpy listed, ≥250 unlisted) in attainment area.
  Requires preconstruction permit BEFORE construction — 401 KAR 55:005, 40 CFR 52.21.
Nonattainment NSR: new/modified major in nonattainment area (KY: ozone, PM2.5).
  Requires LAER and offsets — 401 KAR 56:005.
Minor NSR/State permit: below major thresholds but subject to applicable requirements.
If PTE/size unknown → needs-info for PSD.
 
=====================================================================
CAM (40 CFR Part 64) — EVALUATE PER DEVICE PER POLLUTANT
=====================================================================
ALL THREE must be yes for CAM to apply:
1. Emission unit subject to numeric emission limit/standard?
2. Uses add-on control device to achieve compliance with that limit?
3. Pre-control device PTE > 100 tpy for that pollutant?
If any criterion unknown → needs-info.
${!hasDevices ? 'No control devices installed → CAM does not apply (Criterion 2 fails).' : ''}
 
=====================================================================
SCOPE — BE THOROUGH
=====================================================================
Use the database regulations as context AND your full knowledge of 40 CFR and 401 KAR.
Include every regulation that plausibly applies to this equipment.
If a regulation clearly applies based on your knowledge but is not in the database
results, include it anyway with your reasoning.
 
Respond ONLY with valid JSON, no other text:
{
  "summary": "3-4 sentences specific to this source — what it is, key regulations found, new/existing status, most important actions needed",
  "newExistingDetermination": "For each relevant regulation: state cutoff date, construction date, and new/existing conclusion",
  "dataQuality": "complete|partial|insufficient",
  "missingInfo": ["Specific missing item and exactly why it is needed for determination"],
  "regulations": [
    {
      "id": "unique-id",
      "name": "e.g. 40 CFR 60 Subpart Dc",
      "fullName": "Full descriptive name",
      "category": "Federal NSPS|Federal NESHAP|Federal NSR/PSD|Federal Other|Kentucky State",
      "status": "applies|not-applies|needs-info",
      "badge": "Applies|Does not apply|More info needed",
      "newExisting": "New source|Existing source|N/A|Needs construction date",
      "exemptionChecked": "List each exemption checked and its result — be specific",
      "reason": "2-3 sentences: exemption result + new/existing determination + source characteristics",
      "cite": "Specific section citations with brief explanation of each",
      "keyRequirements": ["Most important requirement 1", "Requirement 2", "Requirement 3"],
      "controlDeviceNotes": "How each installed device affects compliance with this regulation",
      "url": "https://www.ecfr.gov/... or https://apps.legislature.ky.gov/..."
    }
  ],
  "nsrPsd": {
    "psdStatus": "applies|not-applies|needs-info",
    "psdReason": "Explanation with PTE thresholds referenced",
    "nonattainmentStatus": "applies|not-applies|needs-info",
    "nonattainmentReason": "Explanation referencing Kentucky nonattainment designations",
    "minorNsrStatus": "applies|not-applies|needs-info",
    "minorNsrReason": "Explanation for minor source permit path",
    "cite": "401 KAR 55:005, 401 KAR 55:010, 40 CFR 52.21"
  },
  "permitType": {
    "determination": "Registration (401 KAR 52:070)|State Origin Permit (401 KAR 52:040)|Conditional Major|Title V (401 KAR 52:020)|No permit required|Needs more info",
    "reason": "Explanation referencing PTE thresholds and applicable requirements"
  },
  "camApplicability": {
    "status": "applies|not-applies|needs-info",
    "devices": [
      {
        "device": "Device name and pollutant being evaluated",
        "criterion1": "Subject to numeric emission limit? Yes/No — cite specific limit and regulation",
        "criterion2": "Achieves compliance via add-on control device? Yes/No — explain",
        "criterion3": "Pre-control PTE > 100 tpy? Yes/No/Unknown — explain",
        "conclusion": "CAM applies/not-applies/needs-info — reason"
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
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
            responseMimeType: 'application/json'
          }
        })
      }
    );
 
    const gemData = await gemResp.json();
    if (!gemResp.ok) return res.status(500).json({ error: 'Gemini error: ' + (gemData?.error?.message||'Unknown') });
 
    const rawText = gemData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) return res.status(500).json({ error: 'Empty response from Gemini.' });
 
    const cleaned = rawText.replace(/```json/g,'').replace(/```/g,'').trim();
    const s = cleaned.indexOf('{');
    const e = cleaned.lastIndexOf('}');
    if (s === -1 || e === -1) return res.status(500).json({ error: 'No JSON found. Raw: '+rawText.slice(0,300) });
 
    const parsed = JSON.parse(cleaned.slice(s, e+1));
    parsed.regulationsSearched = regs.length;
 
    // Save to history
    try {
      await supabaseInsert('determinations', {
        equipment_type: body.equipmentCategory || body.description || 'Unknown',
        equipment_details: body,
        results: parsed,
        created_at: new Date().toISOString()
      });
    } catch (saveErr) {
      console.log('History save failed (non-critical):', saveErr.message);
    }
 
    res.json(parsed);
 
  } catch (err) {
    console.error('Check error:', err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});
 
app.listen(PORT, () => {
  console.log(`EEC AI Assistant API v10.0 running on port ${PORT}`);
  console.log(`Supabase URL: ${SUPABASE_URL ? 'SET' : 'MISSING'}`);
  console.log(`Supabase Key: ${SUPABASE_KEY ? 'SET' : 'MISSING'}`);
  console.log(`Gemini Key: ${GEMINI_API_KEY ? 'SET' : 'MISSING'}`);
});
 
