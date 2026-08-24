const express = require('express');
const cors = require('cors');
 
const app = express();
app.use(express.json());
app.use(cors());
 
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
// ── SUPABASE REST API (no SDK — direct HTTP calls, always works) ───────────
const DB_HEADERS = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};
 
async function dbGet(path, params = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url.toString(), { headers: DB_HEADERS });
  if (!resp.ok) throw new Error(`DB error ${resp.status}: ${await resp.text()}`);
  return resp.json();
}
 
async function dbPost(path, body) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { ...DB_HEADERS, 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  });
  return resp.ok;
}
 
async function dbCount(table) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id`, {
    headers: { ...DB_HEADERS, 'Prefer': 'count=exact', 'Range': '0-0' }
  });
  const range = resp.headers.get('content-range') || '0-0/0';
  return parseInt(range.split('/')[1] || '0', 10);
}
 
async function dbRpc(fn, params) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: DB_HEADERS,
    body: JSON.stringify(params)
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`RPC ${fn} error: ${err}`);
  }
  return resp.json();
}
 
app.get('/', (req, res) => {
  res.json({ status: 'EEC AI Assistant API running', version: '8.0' });
});
 
// ── STATS ─────────────────────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
  try {
    const count = await dbCount('regulations');
    res.json({ regulations_in_database: count, status: 'healthy', version: '8.0' });
  } catch (err) {
    console.error('Stats error:', err.message);
    res.status(500).json({ error: err.message, regulations_in_database: 0 });
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
 
// ── AI KEYWORD GENERATION ─────────────────────────────────────────────────
async function getRegulationKeywords(body) {
  try {
    const prompt = `You are a Kentucky air quality engineer. For this equipment, list the most likely applicable federal and state air quality regulation identifiers as short search keywords.
 
Equipment: ${body.equipmentCategory || ''}
Use: ${body.equipmentType || ''}
Fuel: ${body.fuelType || ''}
Capacity: ${body.capacity || ''}
Description: ${body.description || ''}
 
Respond ONLY with a JSON array of 8-10 short search strings (2-5 words each) that would match regulation titles in a database.
Example for boiler: ["boiler Subpart Db", "boiler Subpart Dc", "NESHAP DDDDD boiler major", "boiler JJJJJJ area", "indirect heat exchanger Kentucky"]
Example for dry cleaner: ["perchloroethylene dry cleaning", "NESHAP Subpart M", "dry cleaning HAP"]`;
 
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 300, responseMimeType: 'application/json' }
        })
      }
    );
    const data = await resp.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const parsed = JSON.parse(raw.replace(/```json/g,'').replace(/```/g,'').trim());
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Keyword gen error:', e.message);
    return [];
  }
}
 
// ── UNIVERSAL SEARCH ──────────────────────────────────────────────────────
async function searchRegulations(body, limit = 35) {
  const seen = new Set();
  const results = [];
 
  const addRows = (rows) => {
    if (!Array.isArray(rows)) return;
    rows.forEach(r => { if (!seen.has(r.id)) { seen.add(r.id); results.push(r); } });
  };
 
  const SELECT = 'id,source,part,subpart,section,title,content,url,equipment_tags';
 
  // Step 1: AI generates keywords for ANY equipment type
  const keywords = await getRegulationKeywords(body);
  console.log('Keywords:', keywords);
 
  // Step 2: Title search for each keyword
  for (const kw of keywords) {
    const words = kw.split(' ').filter(w => w.length > 3).slice(0, 2);
    for (const word of words) {
      try {
        const rows = await dbGet('regulations', {
          select: SELECT,
          title: `ilike.*${word}*`,
          limit: 8
        });
        addRows(rows);
      } catch (e) {}
    }
    if (results.length >= limit) break;
  }
 
  // Step 3: Equipment word title search
  const equipWords = [body.equipmentCategory, body.equipmentType, body.fuelType]
    .filter(Boolean).join(' ').split(/\s+/)
    .filter(w => w.length > 3).slice(0, 6);
 
  for (const word of [...new Set(equipWords)]) {
    try {
      const rows = await dbGet('regulations', {
        select: SELECT,
        title: `ilike.*${word}*`,
        limit: 5
      });
      addRows(rows);
    } catch (e) {}
    if (results.length >= limit) break;
  }
 
  // Step 4: Keyword search RPC function
  try {
    const kwQuery = [body.equipmentCategory, body.fuelType]
      .filter(Boolean).join(' ').split(' ').slice(0, 4).join(' ');
    if (kwQuery.trim()) {
      const rows = await dbRpc('keyword_search_regulations', {
        search_terms: kwQuery,
        result_limit: 10
      });
      addRows(rows);
    }
  } catch (e) { console.log('Keyword RPC:', e.message); }
 
  // Step 5: Semantic embedding search
  try {
    const embedText = [body.equipmentCategory, body.equipmentType, body.fuelType, 'air quality regulation Kentucky']
      .filter(Boolean).join(' ');
    const embedding = await generateEmbedding(embedText);
    if (embedding) {
      const rows = await dbRpc('search_regulations', {
        query_embedding: embedding,
        match_threshold: 0.2,
        match_count: 15
      });
      addRows(rows);
    }
  } catch (e) { console.log('Embedding search:', e.message); }
 
  // Step 6: Always get all Kentucky regulations
  try {
    const kyRows = await dbGet('regulations', {
      select: SELECT,
      source: 'eq.kentucky',
      limit: 20
    });
    addRows(kyRows);
  } catch (e) { console.log('KY fetch:', e.message); }
 
  console.log(`Found: ${results.length} regulations`);
  return results.slice(0, limit);
}
 
function buildControlDeviceContext(devices) {
  if (!devices || devices.length === 0) return 'None installed.';
  return devices.map((d, i) =>
    `Device ${i+1}: ${d.type}${d.efficiency ? ` | ${d.efficiency}` : ''}${d.pollutants ? ` | Controls: ${d.pollutants}` : ''}`
  ).join('\n');
}
 
// ── MAIN CHECK ────────────────────────────────────────────────────────────
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
          `=== ${r.title} ===\nSource: ${r.source === 'federal' ? `40 CFR Part ${r.part}${r.subpart ? ' Subpart '+r.subpart : ''}` : r.part}\nURL: ${r.url||'N/A'}\nTags: ${(r.equipment_tags||[]).join(', ')}\n${(r.content||'').slice(0,1200)}\n`
        ).join('\n---\n')
      : 'No database results. Use full regulatory knowledge.';
 
    const controlCtx = buildControlDeviceContext(body.controlDevices);
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
MANDATORY ANALYSIS ORDER
=====================================================================
 
STEP 1 — EXEMPTIONS FIRST
Check ALL exemptions before applicability. Unknown key trigger → "needs-info" NOT "applies".
 
STEP 2 — AUTO-DETERMINE NEW vs EXISTING
Construction date: ${body.constructDate||'NOT PROVIDED'}
 
40 CFR 60 cutoffs: D=Aug17'71, Da=Sep18'78, Db=Jun19'84, Dc=Jun9'89, E=Aug17'71,
Ea=Dec20'89, Eb=Sep20'94, Ec=Jun20'96, F=Aug17'71, GG=Oct3'77, IIII=Jul11'05,
JJJJ=Jun12'06, KKKK=Feb18'05, CCCC=Nov30'99, WWW=May30'91, OOO=Apr22'08,
OOOO=Aug23'11, Kb=Jul23'84, BB=Sep24'76, BBa=Mar23'90, VVa=Nov7'06, RRR=Jun29'90
 
40 CFR 63 cutoffs: ZZZZ=Jun12'06, YYYY=Jan14'03, DDDDD=Jun4'10, JJJJJJ=Jun4'10,
UUUUU=May3'11, S=Apr15'98, M=Dec9'91, N=Jan25'95, T=Jul15'94, CC=Aug18'95,
EEE=Jun19'96, LLL=Jun16'08, HHHHHH=Jan9'08, FFFF=Apr4'02, VVVVVV=Oct6'08
 
Kentucky: 401 KAR 59=new (after Jul2'75), 401 KAR 61=existing (before Jul2'75)
 
STEP 3 — APPLICABILITY (after exemptions confirmed)
STEP 4 — REQUIREMENTS
 
=====================================================================
KEY EXEMPTION RULES
=====================================================================
Subpart S: ONLY chemical pulping. Unknown → needs-info.
Subpart Dc: 10-100 MMBtu/hr. Gas-fired exempt from SO2/PM but needs notifications.
Subpart Db: >100 MMBtu/hr only.
Subpart DDDDD: major HAP sources only. Unknown → needs-info.
Subpart JJJJJJ: area HAP sources only. Unknown → needs-info.
Subpart IIII: CI engines only, after Jul11'05.
Subpart JJJJ: SI engines only, after Jun12'06.
Subpart ZZZZ: area CI<300HP or SI<500HP → annual inspection only §63.6625(e).
Subpart EEE: ONLY RCRA hazardous waste. Non-hazardous → CISWI (CCCC).
Subpart FFFF (MON): organic chemical manufacturing at MAJOR HAP sources only.
Subpart VVVVVV (CMAS): chemical manufacturing at AREA HAP sources only.
Subpart VVa: SOCMI equipment leaks — verify product on 40 CFR 60.489 list.
Subpart RRR: SOCMI reactors — batch reactors exempt per §60.700(c)(1).
401 KAR 59: does NOT apply to engines/turbines. DOES apply to boilers,
  process heaters, kilns, dryers, chemical process units, coating operations.
401 KAR 63: opacity applies to all combustion and process sources.
 
NSR/PSD: PSD if new/modified major (≥100 tpy listed, ≥250 unlisted) in attainment.
Nonattainment NSR if in nonattainment area. Unknown PTE → needs-info.
 
CAM: all 3 must be yes: (1) numeric limit, (2) add-on control device, (3) pre-control PTE>100 tpy.
${!hasDevices ? 'No control devices → CAM does not apply.' : ''}
 
Use database regulations as context AND your full regulatory knowledge.
Include any regulation that likely applies even if not in database results.
 
Respond ONLY with valid JSON:
{
  "summary": "3-4 sentences specific to this source",
  "newExistingDetermination": "Per-regulation new/existing with cutoffs cited",
  "dataQuality": "complete|partial|insufficient",
  "missingInfo": ["item and why"],
  "regulations": [
    {
      "id": "unique-id",
      "name": "Regulation name",
      "fullName": "Full name",
      "category": "Federal NSPS|Federal NESHAP|Federal NSR/PSD|Federal Other|Kentucky State",
      "status": "applies|not-applies|needs-info",
      "badge": "Applies|Does not apply|More info needed",
      "newExisting": "New source|Existing source|N/A|Needs construction date",
      "exemptionChecked": "Each exemption and result",
      "reason": "2-3 sentences: exemption + new/existing + source specifics",
      "cite": "Specific citations with explanation",
      "keyRequirements": ["Requirement 1", "Requirement 2"],
      "controlDeviceNotes": "How each device affects this regulation",
      "url": "URL if available"
    }
  ],
  "nsrPsd": {
    "psdStatus": "applies|not-applies|needs-info",
    "psdReason": "Explanation with thresholds",
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
        "device": "Device and pollutant",
        "criterion1": "Numeric limit? Yes/No — cite",
        "criterion2": "Add-on control? Yes/No",
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
 
    // Save to history
    try {
      await dbPost('determinations', {
        equipment_type: body.equipmentCategory || body.description,
        equipment_details: body,
        results: parsed,
        created_at: new Date().toISOString()
      });
    } catch (e) { console.log('History save:', e.message); }
 
    parsed.regulationsSearched = regs.length;
    res.json(parsed);
 
  } catch (err) {
    console.error('Check error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});
 
// ── HISTORY ───────────────────────────────────────────────────────────────
app.get('/history', async (req, res) => {
  try {
    const data = await dbGet('determinations', {
      select: 'id,created_at,equipment_type,equipment_details,results',
      order: 'created_at.desc',
      limit: 50
    });
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
 
app.listen(PORT, () => {
  console.log(`EEC AI Assistant API v8.0 running on port ${PORT}`);
});
 
