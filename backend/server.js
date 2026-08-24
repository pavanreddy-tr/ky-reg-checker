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
 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
 
app.get('/', (req, res) => {
  res.json({ status: 'EEC AI Assistant API running', version: '6.0' });
});
 
// ─── UNIVERSAL SEARCH ─────────────────────────────────────────────────────────
// Step 1: Ask Gemini to identify relevant regulation keywords for ANY equipment
async function getRegulationKeywords(body) {
  try {
    const prompt = `You are a Kentucky air quality engineer. For this equipment, list the most likely
applicable federal and state air quality regulation identifiers.
 
Equipment: ${body.equipmentCategory || ''}
Use/Operation: ${body.equipmentType || ''}
Fuel: ${body.fuelType || ''}
Capacity: ${body.capacity || ''}
Description: ${body.description || ''}
 
List the most likely applicable regulations as short search terms.
Respond ONLY with JSON array of strings, nothing else:
["search term 1", "search term 2", ...]
 
Include: specific subpart names, equipment type keywords, pollutant keywords.
Example for a boiler: ["boiler industrial Subpart Db", "boiler Subpart Dc", "NESHAP DDDDD boiler major", "JJJJJJ boiler area source", "401 KAR 59 indirect heat exchanger", "boiler PM NOx SO2"]
Limit to 10 most relevant terms.`;
 
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 500, responseMimeType: 'application/json' }
        })
      }
    );
 
    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const cleaned = rawText.replace(/```json/g,'').replace(/```/g,'').trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('Keyword generation error:', e.message);
    return [];
  }
}
 
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
 
async function searchRegulations(body, limit = 35) {
  const seen = new Set();
  const results = [];
 
  const addResults = (data) => {
    if (!data) return;
    data.forEach(r => {
      if (!seen.has(r.id)) { seen.add(r.id); results.push(r); }
    });
  };
 
  // ── METHOD 1: Gemini identifies the right regulation keywords ──────────────
  // This works for ANY equipment type — Gemini knows what regulations apply
  const aiKeywords = await getRegulationKeywords(body);
  console.log('AI-suggested keywords:', aiKeywords);
 
  for (const keyword of aiKeywords) {
    try {
      // Title search
      const words = keyword.split(' ').filter(w => w.length > 3);
      for (const word of words.slice(0, 2)) {
        const { data } = await supabase
          .from('regulations')
          .select('id, source, part, subpart, section, title, content, url, equipment_tags')
          .ilike('title', `%${word}%`)
          .limit(6);
        addResults(data);
      }
 
      // Keyword search function
      const { data } = await supabase.rpc('keyword_search_regulations', {
        search_terms: keyword.split(' ').slice(0, 5).join(' '),
        result_limit: 8
      });
      addResults(data);
    } catch (e) {}
 
    if (results.length >= limit) break;
  }
 
  // ── METHOD 2: Tag search using equipment words ─────────────────────────────
  const equipWords = [
    body.equipmentCategory,
    body.equipmentType,
    body.fuelType
  ].filter(Boolean).join(' ').toLowerCase().split(/\s+/).filter(w => w.length > 3);
 
  for (const word of [...new Set(equipWords)].slice(0, 8)) {
    try {
      // Search in title
      const { data: titleData } = await supabase
        .from('regulations')
        .select('id, source, part, subpart, section, title, content, url, equipment_tags')
        .ilike('title', `%${word}%`)
        .limit(5);
      addResults(titleData);
 
      // Search in equipment_tags
      const { data: tagData } = await supabase
        .from('regulations')
        .select('id, source, part, subpart, section, title, content, url, equipment_tags')
        .contains('equipment_tags', [word])
        .limit(5);
      addResults(tagData);
    } catch (e) {}
 
    if (results.length >= limit) break;
  }
 
  // ── METHOD 3: Semantic embedding search ───────────────────────────────────
  const embedQuery = [
    body.equipmentCategory,
    body.equipmentType,
    body.fuelType,
    body.description,
    'air quality regulation Kentucky federal'
  ].filter(Boolean).join(' ');
 
  try {
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
 
  // ── METHOD 4: Always include Kentucky regulations ──────────────────────────
  try {
    const { data } = await supabase
      .from('regulations')
      .select('id, source, part, subpart, section, title, content, url, equipment_tags')
      .eq('source', 'kentucky')
      .limit(15);
    addResults(data);
  } catch (e) {}
 
  console.log(`Total regulations found: ${results.length}`);
  return results.slice(0, limit);
}
 
function buildControlDeviceContext(controlDevices) {
  if (!controlDevices || controlDevices.length === 0) return 'None installed.';
  return controlDevices.map((d, i) =>
    `Device ${i + 1}: ${d.type}${d.efficiency ? ` | Efficiency: ${d.efficiency}` : ''}${d.pollutants ? ` | Controls: ${d.pollutants}` : ''}`
  ).join('\n');
}
 
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
      : 'No database results. Use regulatory knowledge.';
 
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
MANDATORY ANALYSIS ORDER
=====================================================================
 
STEP 1 — EXEMPTIONS FIRST (NON-NEGOTIABLE)
Check ALL exemptions before applicability.
Unknown key trigger → "needs-info" NOT "applies".
 
STEP 2 — AUTO-DETERMINE NEW vs EXISTING
Construction date: ${body.constructDate || 'NOT PROVIDED'}
 
Key cutoffs (40 CFR 60): D=Aug17'71, Da=Sep18'78, Db=Jun19'84, Dc=Jun9'89,
E=Aug17'71, Ea=Dec20'89, Eb=Sep20'94, Ec=Jun20'96, F=Aug17'71, GG=Oct3'77,
IIII=Jul11'05, JJJJ=Jun12'06, KKKK=Feb18'05, CCCC=Nov30'99, WWW=May30'91,
OOO=Apr22'08, OOOO=Aug23'11, Kb=Jul23'84, BB=Sep24'76, BBa=Mar23'90
 
Key cutoffs (40 CFR 63): ZZZZ=Jun12'06, YYYY=Jan14'03, DDDDD=Jun4'10,
JJJJJJ=Jun4'10, UUUUU=May3'11, S=Apr15'98, M=Dec9'91, N=Jan25'95,
T=Jul15'94, CC=Aug18'95, EEE=Jun19'96, LLL=Jun16'08, HHHHHH=Jan9'08
 
Kentucky: 401 KAR 59=new (after Jul2'75), 401 KAR 61=existing (before Jul2'75)
 
STEP 3 — APPLICABILITY (after exemptions and new/existing confirmed)
 
STEP 4 — REQUIREMENTS
 
=====================================================================
KEY EXEMPTION RULES
=====================================================================
 
40 CFR 63 Subpart S: ONLY chemical pulping (kraft/sulfite/soda/semi-chem).
Mechanical/recycled/paper-only → not-applies. Unknown type → needs-info.
 
40 CFR 60 Subpart Dc: 10-100 MMBtu/hr only. Gas-fired exempt from SO2/PM limits.
40 CFR 60 Subpart Db: >100 MMBtu/hr only.
40 CFR 63 Subpart DDDDD: major HAP sources only. Unknown status → needs-info.
40 CFR 63 Subpart JJJJJJ: area HAP sources only. Unknown status → needs-info.
40 CFR 60 Subpart IIII: CI engines only, after Jul11'05.
40 CFR 60 Subpart JJJJ: SI engines only, after Jun12'06.
40 CFR 63 Subpart ZZZZ: area CI<300HP or SI<500HP → annual inspection only.
40 CFR 63 Subpart EEE: ONLY RCRA hazardous waste. Non-hazardous → CISWI (CCCC).
401 KAR 59: does NOT apply to engines/turbines (covered by federal standards).
  DOES apply to boilers, indirect heat exchangers, process units, kilns, dryers.
401 KAR 63 opacity: applies to boilers/process/incinerators. NOT cited for engines.
 
=====================================================================
NSR/PSD — ALWAYS EVALUATE FOR EVERY SOURCE
=====================================================================
PSD: new/modified major source (≥100 tpy listed, ≥250 tpy unlisted) in attainment area.
Nonattainment NSR: new/modified major in nonattainment area (Kentucky: ozone, PM2.5).
Minor NSR: below major but subject to applicable federal requirements.
Unknown PTE → needs-info. Major source confirmed → PSD likely applies.
 
=====================================================================
CAM (40 CFR Part 64) — ALL THREE CRITERIA PER DEVICE
=====================================================================
1. Subject to numeric emission limit for regulated pollutant?
2. Uses add-on control device to comply with that limit?
3. Pre-control PTE > 100 tpy for that pollutant?
ALL THREE yes → CAM applies. Any unknown → needs-info.
${!hasControlDevices ? 'No control devices installed → CAM not applicable (Criterion 2 fails).' : ''}
 
=====================================================================
SCOPE — BE THOROUGH FOR THIS EQUIPMENT TYPE
=====================================================================
Based on the database regulations retrieved AND your regulatory knowledge,
identify ALL potentially applicable regulations for this specific equipment.
Do not limit yourself to only what was retrieved — use the database as context
but apply your full knowledge of air quality regulations for this equipment category.
If you know a regulation likely applies that isn't in the retrieved set, include it.
 
Respond ONLY with valid JSON:
{
  "summary": "3-4 sentences specific to this source covering key applicable regs, new/existing status, most important actions",
  "newExistingDetermination": "Per-regulation new/existing conclusions with cutoff dates cited",
  "dataQuality": "complete|partial|insufficient",
  "missingInfo": ["Specific missing item and exactly why it is needed"],
  "regulations": [
    {
      "id": "unique-id",
      "name": "Regulation name e.g. 40 CFR 60 Subpart Dc",
      "fullName": "Full descriptive name",
      "category": "Federal NSPS|Federal NESHAP|Federal NSR/PSD|Federal Other|Kentucky State",
      "status": "applies|not-applies|needs-info",
      "badge": "Applies|Does not apply|More info needed",
      "newExisting": "New source|Existing source|N/A|Needs construction date",
      "exemptionChecked": "Each exemption checked and the result — be specific",
      "reason": "2-3 sentences: exemption result + new/existing + specific source characteristics",
      "cite": "Specific section citations with brief explanation",
      "keyRequirements": ["Requirement 1", "Requirement 2", "Requirement 3"],
      "controlDeviceNotes": "How each installed device affects this specific regulation",
      "url": "Regulation URL if available"
    }
  ],
  "nsrPsd": {
    "psdStatus": "applies|not-applies|needs-info",
    "psdReason": "Explanation with PTE thresholds and attainment status",
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
        "criterion1": "Numeric emission limit? Yes/No — cite the specific limit and regulation",
        "criterion2": "Add-on control device used to comply? Yes/No — explain",
        "criterion3": "Pre-control PTE > 100 tpy? Yes/No/Unknown — explain",
        "conclusion": "CAM applies/not-applies/needs-info — reason"
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
    if (start === -1 || end === -1) return res.status(500).json({ error: 'No JSON. Raw: ' + rawText.slice(0,300) });
 
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
 
aapp.get('/stats', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('regulations')
      .select('id')
      .limit(1000);
    if (error) throw error;
    const count = data ? data.length : 0;
    
    // Get exact count with a separate query
    const { data: allData } = await supabase
      .from('regulations')
      .select('id', { count: 'exact' });
    
    res.json({ 
      regulations_in_database: allData?.length || count, 
      status: 'healthy', 
      version: '6.0' 
    });
  } catch (err) { 
    res.status(500).json({ error: err.message, regulations_in_database: 0 }); 
  }
});
 
app.listen(PORT, () => {
  console.log(`EEC AI Assistant API v6.0 running on port ${PORT}`);
});
 
