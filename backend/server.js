const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
 
const app = express();
app.use(express.json());
app.use(cors());
 
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
 
// Initialize Supabase without realtime to avoid WebSocket issues
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  global: { fetch: fetch }
});
 
app.get('/', (req, res) => {
  res.json({ status: 'EEC AI Assistant API running', version: '7.0' });
});
 
// ── STATS ──────────────────────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('regulations')
      .select('id');
    if (error) {
      console.error('Stats error:', error);
      return res.status(500).json({ error: error.message, regulations_in_database: 0 });
    }
    res.json({
      regulations_in_database: data ? data.length : 0,
      status: 'healthy',
      version: '7.0'
    });
  } catch (err) {
    console.error('Stats catch:', err);
    res.status(500).json({ error: err.message, regulations_in_database: 0 });
  }
});
 
// ── EMBEDDING ─────────────────────────────────────────────────────────────
async function generateEmbedding(text) {
  try {
    const response = await fetch(
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
    const data = await response.json();
    return data?.embedding?.values || null;
  } catch (err) { return null; }
}
 
// ── AI KEYWORD GENERATION ─────────────────────────────────────────────────
// Ask Gemini what regulations to search for — works for ANY equipment type
async function getRegulationKeywords(body) {
  try {
    const prompt = `You are a Kentucky air quality engineer. For this equipment, list the most likely applicable federal and state air quality regulation identifiers as short search keywords.
 
Equipment: ${body.equipmentCategory || ''}
Use: ${body.equipmentType || ''}
Fuel: ${body.fuelType || ''}
Capacity: ${body.capacity || ''}
Description: ${body.description || ''}
 
Respond ONLY with a JSON array of 8-10 short search strings. Each string should be 2-5 words that would match a regulation title or equipment tag in a database.
 
Example for a boiler: ["boiler Subpart Db", "boiler Subpart Dc", "NESHAP DDDDD boiler major", "boiler JJJJJJ area", "indirect heat exchanger Kentucky", "boiler NOx PM SO2"]
Example for a dry cleaner: ["perchloroethylene dry cleaning", "NESHAP Subpart M", "dry cleaning HAP", "401 KAR process operation"]`;
 
    const response = await fetch(
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
    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const cleaned = raw.replace(/```json/g,'').replace(/```/g,'').trim();
    const parsed = JSON.parse(cleaned);
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
 
  const addResults = (data) => {
    if (!data) return;
    data.forEach(r => {
      if (!seen.has(r.id)) { seen.add(r.id); results.push(r); }
    });
  };
 
  // Step 1: AI generates relevant keywords for this equipment type
  const aiKeywords = await getRegulationKeywords(body);
  console.log('AI keywords:', aiKeywords);
 
  // Step 2: Search by title using each keyword
  for (const keyword of aiKeywords) {
    const words = keyword.split(' ').filter(w => w.length > 3);
    for (const word of words.slice(0, 2)) {
      try {
        const { data, error } = await supabase
          .from('regulations')
          .select('id, source, part, subpart, section, title, content, url, equipment_tags')
          .ilike('title', `%${word}%`)
          .limit(8);
        if (!error) addResults(data);
      } catch (e) {}
    }
    if (results.length >= limit) break;
  }
 
  // Step 3: Search by equipment words in title and tags
  const allWords = [body.equipmentCategory, body.equipmentType, body.fuelType]
    .filter(Boolean).join(' ').split(/\s+/)
    .filter(w => w.length > 3)
    .map(w => w.toLowerCase());
 
  for (const word of [...new Set(allWords)].slice(0, 6)) {
    try {
      const { data: titleData } = await supabase
        .from('regulations')
        .select('id, source, part, subpart, section, title, content, url, equipment_tags')
        .ilike('title', `%${word}%`)
        .limit(5);
      addResults(titleData);
    } catch (e) {}
    if (results.length >= limit) break;
  }
 
  // Step 4: Keyword search function
  const kwQuery = [body.equipmentCategory, body.fuelType].filter(Boolean).join(' ');
  if (kwQuery) {
    try {
      const { data } = await supabase.rpc('keyword_search_regulations', {
        search_terms: kwQuery.split(' ').slice(0, 4).join(' '),
        result_limit: 10
      });
      addResults(data);
    } catch (e) {}
  }
 
  // Step 5: Semantic search
  try {
    const embedQuery = [body.equipmentCategory, body.equipmentType, body.fuelType, 'air quality regulation']
      .filter(Boolean).join(' ');
    const embedding = await generateEmbedding(embedQuery);
    if (embedding) {
      const { data } = await supabase.rpc('search_regulations', {
        query_embedding: embedding,
        match_threshold: 0.2,
        match_count: 15
      });
      addResults(data);
    }
  } catch (e) {}
 
  // Step 6: Always include all Kentucky regulations
  try {
    const { data } = await supabase
      .from('regulations')
      .select('id, source, part, subpart, section, title, content, url, equipment_tags')
      .eq('source', 'kentucky');
    addResults(data);
  } catch (e) {}
 
  console.log(`Search complete: ${results.length} regulations found`);
  return results.slice(0, limit);
}
 
// ── CONTROL DEVICE CONTEXT ────────────────────────────────────────────────
function buildControlDeviceContext(controlDevices) {
  if (!controlDevices || controlDevices.length === 0) return 'None installed.';
  return controlDevices.map((d, i) =>
    `Device ${i + 1}: ${d.type}${d.efficiency ? ` | Efficiency: ${d.efficiency}` : ''}${d.pollutants ? ` | Controls: ${d.pollutants}` : ''}`
  ).join('\n');
}
 
// ── MAIN CHECK ENDPOINT ───────────────────────────────────────────────────
app.post('/check', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'API key not configured.' });
 
  const body = req.body;
  if (!body.equipmentCategory && !body.description) {
    return res.status(400).json({ error: 'Please provide equipment type or description.' });
  }
 
  try {
    const relevantRegs = await searchRegulations(body, 35);
 
    const regContext = relevantRegs.length > 0
      ? relevantRegs.map(r =>
          `=== ${r.title} ===\nSource: ${r.source === 'federal'
            ? `40 CFR Part ${r.part}${r.subpart ? ' Subpart ' + r.subpart : ''}`
            : r.part}\nURL: ${r.url || 'N/A'}\nTags: ${(r.equipment_tags || []).join(', ')}\n${(r.content || '').slice(0, 1200)}\n`
        ).join('\n---\n')
      : 'No database results. Use your full regulatory knowledge.';
 
    const controlDeviceContext = buildControlDeviceContext(body.controlDevices);
    const hasControlDevices = body.controlDevices && body.controlDevices.length > 0;
 
    const equipDetails = [
      `Equipment category: ${body.equipmentCategory || 'Not specified'}`,
      `Equipment use/operation: ${body.equipmentType || 'Not specified'}`,
      `Fuel type: ${body.fuelType || 'Not specified'}`,
      `Capacity: ${body.capacity || 'Not specified'}`,
      `Construction date: ${body.constructDate || 'Not specified'}`,
      `Model year: ${body.modelYear || 'Not specified'}`,
      `Source class (HAP): ${body.sourceClass || 'Not specified'}`,
      `Regulated pollutant class: ${body.pollutantClass || 'Not specified'}`,
      `SIC code: ${body.sicCode || 'Not specified'}`,
      `Control devices:\n${controlDeviceContext}`,
      body.description ? `Additional info: ${body.description}` : ''
    ].filter(Boolean).join('\n');
 
    const prompt = `You are an expert Kentucky air quality permitting engineer at the Kentucky EEC Division for Air Quality.
 
RELEVANT REGULATIONS FROM DATABASE (${relevantRegs.length} retrieved):
${regContext}
 
SOURCE DETAILS:
${equipDetails}
 
=====================================================================
MANDATORY ANALYSIS ORDER — FOLLOW EXACTLY
=====================================================================
 
STEP 1 — EXEMPTIONS FIRST (NON-NEGOTIABLE)
For every regulation: check ALL exemptions before applicability.
Unknown key exemption trigger → "needs-info" NOT "applies".
 
STEP 2 — AUTO-DETERMINE NEW vs EXISTING
Construction date: ${body.constructDate || 'NOT PROVIDED'}
Apply each regulation's own cutoff independently.
 
Key cutoffs (40 CFR 60): D=Aug17'71, Da=Sep18'78, Db=Jun19'84, Dc=Jun9'89,
E=Aug17'71, Ea=Dec20'89, Eb=Sep20'94, Ec=Jun20'96, F=Aug17'71, GG=Oct3'77,
IIII=Jul11'05, JJJJ=Jun12'06, KKKK=Feb18'05, CCCC=Nov30'99, WWW=May30'91,
OOO=Apr22'08, OOOO=Aug23'11, Kb=Jul23'84, BB=Sep24'76, BBa=Mar23'90,
VV=Jan5'81, VVa=Nov7'06, RRR=Jun29'90, NNN=Jun29'90, QQQ=Jun29'90
 
Key cutoffs (40 CFR 63): ZZZZ=Jun12'06, YYYY=Jan14'03, DDDDD=Jun4'10,
JJJJJJ=Jun4'10, UUUUU=May3'11, S=Apr15'98, M=Dec9'91, N=Jan25'95,
T=Jul15'94, CC=Aug18'95, EEE=Jun19'96, LLL=Jun16'08, HHHHHH=Jan9'08,
FFFF=Apr4'02, VVVVVV=Oct6'08
 
Kentucky: 401 KAR 59=new (after Jul2'75), 401 KAR 61=existing (before Jul2'75)
 
STEP 3 — APPLICABILITY (after exemptions and new/existing confirmed)
STEP 4 — REQUIREMENTS (only for applicable regulations)
 
=====================================================================
KEY EXEMPTION RULES
=====================================================================
 
Subpart S: ONLY chemical pulping. Unknown type → needs-info.
Subpart Dc: 10-100 MMBtu/hr only. Gas-fired exempt from SO2/PM limits.
Subpart Db: >100 MMBtu/hr only.
Subpart DDDDD: major HAP sources only. Unknown → needs-info.
Subpart JJJJJJ: area HAP sources only. Unknown → needs-info.
Subpart IIII: CI engines only, after Jul11'05.
Subpart JJJJ: SI engines only, after Jun12'06.
Subpart ZZZZ: area CI<300HP or SI<500HP → annual inspection only.
Subpart EEE: ONLY RCRA hazardous waste. Non-hazardous → CISWI.
Subpart CCCC: non-hazardous commercial/industrial solid waste only.
Subpart FFFF (MON): organic chemical manufacturing at MAJOR sources only.
Subpart VVVVVV (CMAS): chemical manufacturing at AREA sources only.
Subpart VVa/VV: SOCMI equipment leaks — check if product on 40 CFR 60.489 list.
Subpart RRR: SOCMI reactor processes — batch reactors may be exempt.
401 KAR 59: does NOT apply to engines/turbines. DOES apply to boilers,
  process heaters, kilns, dryers, chemical process units, coating lines.
401 KAR 63 opacity: boilers/process sources. NOT cited for engines.
 
=====================================================================
NSR/PSD — ALWAYS EVALUATE
=====================================================================
PSD: new/modified major source (≥100 tpy listed, ≥250 tpy unlisted) in attainment.
Nonattainment NSR: new/modified major in nonattainment area.
Minor NSR: below major thresholds, subject to applicable requirements.
Unknown PTE → needs-info.
 
=====================================================================
CAM (40 CFR Part 64) — PER DEVICE PER POLLUTANT
=====================================================================
All three must be yes: (1) numeric emission limit, (2) add-on control device,
(3) pre-control PTE >100 tpy. Any unknown → needs-info.
${!hasControlDevices ? 'No control devices → CAM not applicable.' : ''}
 
=====================================================================
BE THOROUGH — USE DATABASE + YOUR KNOWLEDGE
=====================================================================
Use the retrieved database regulations as context AND your full knowledge
of 40 CFR and 401 KAR to identify all potentially applicable regulations.
If a regulation clearly applies based on your knowledge but isn't in the
retrieved set, include it anyway.
 
Respond ONLY with valid JSON:
{
  "summary": "3-4 sentences specific to this source",
  "newExistingDetermination": "Per-regulation conclusions with cutoff dates",
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
      "exemptionChecked": "Each exemption checked and result",
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
        "device": "Device name and pollutant",
        "criterion1": "Numeric limit? Yes/No — cite limit",
        "criterion2": "Add-on control? Yes/No",
        "criterion3": "Pre-control PTE >100 tpy? Yes/No/Unknown",
        "conclusion": "CAM applies/not-applies/needs-info"
      }
    ],
    "reason": "Overall CAM conclusion"
  }
}
Order: applies first, needs-info second, not-applies last.`;
 
    const response = await fetch(
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
 
    const data = await response.json();
    if (!response.ok) return res.status(500).json({ error: 'Gemini error: ' + (data?.error?.message || 'Unknown') });
 
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) return res.status(500).json({ error: 'Empty response.' });
 
    const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1) return res.status(500).json({ error: 'No JSON. Raw: ' + rawText.slice(0, 300) });
 
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
 
    try {
      await supabase.from('determinations').insert({
        equipment_type: body.equipmentCategory || body.description,
        equipment_details: body,
        results: parsed
      });
    } catch (e) {}
 
    parsed.regulationsSearched = relevantRegs.length;
    res.json(parsed);
 
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});
 
// ── HISTORY ───────────────────────────────────────────────────────────────
app.get('/history', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('determinations')
      .select('id, created_at, equipment_type, equipment_details, results')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
 
app.listen(PORT, () => {
  console.log(`EEC AI Assistant API v7.0 running on port ${PORT}`);
});
 
