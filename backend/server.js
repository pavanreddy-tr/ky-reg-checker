
/




























Server v4 · JS
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
  res.json({ status: 'EEC AI Assistant API running', version: '4.0' });
});
 
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
 
async function searchRegulations(query, limit = 25) {
  try {
    const embedding = await generateEmbedding(query);
    if (embedding) {
      const { data, error } = await supabase.rpc('search_regulations', {
        query_embedding: embedding,
        match_threshold: 0.3,
        match_count: limit
      });
      if (!error && data && data.length > 0) return data;
    }
    const { data } = await supabase.rpc('keyword_search_regulations', {
      search_terms: query,
      result_limit: limit
    });
    return data || [];
  } catch (err) {
    console.error('Search error:', err);
    return [];
  }
}
 
function buildSearchQuery(body) {
  const parts = [
    body.equipmentCategory,
    body.equipmentType,
    body.fuelType,
    body.description,
    body.controlDevices ? body.controlDevices.map(d => d.type).join(' ') : ''
  ].filter(Boolean);
  return parts.join(' ') || 'stationary source air quality regulations Kentucky';
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
    const searchQuery = buildSearchQuery(body);
    const relevantRegs = await searchRegulations(searchQuery, 20);
 
    const regContext = relevantRegs.length > 0
      ? relevantRegs.map(r =>
          `=== ${r.title} ===\nSource: ${r.source === 'federal' ? `40 CFR Part ${r.part}${r.subpart ? ' Subpart ' + r.subpart : ''}` : r.part}\nURL: ${r.url || 'N/A'}\n${(r.content || '').slice(0, 2000)}\n`
        ).join('\n---\n')
      : 'Use your general knowledge of 40 CFR Parts 60, 61, 62, 63 and 401 KAR Chapters 50-65.';
 
    const controlDeviceContext = buildControlDeviceContext(body.controlDevices);
 
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
 
RELEVANT REGULATIONS FROM DATABASE:
${regContext}
 
SOURCE DETAILS:
${equipDetails}
 
=====================================================================
MANDATORY LOGIC — FOLLOW THIS EXACT SEQUENCE FOR EVERY REGULATION
=====================================================================
 
STEP 1 — CHECK EXEMPTIONS FIRST (NON-NEGOTIABLE)
Before ANYTHING else, check ALL exemptions in the regulation.
If ANY exemption applies → status = "not-applies", cite the exemption section.
DO NOT proceed to applicability if exempt.
 
CRITICAL RULE: If a key exemption trigger is UNKNOWN from the information provided
→ status = "needs-info" (NOT "applies")
→ Ask for the specific missing information needed to check the exemption
 
Examples of unknown = needs-info:
- Subpart S applicability unknown because pulping technology not specified → needs-info
- Subpart DDDDD applicability unknown because major/area source status not confirmed → needs-info
- Subpart IIII applicability unknown because engine displacement not confirmed → needs-info
 
STEP 2 — DETERMINE NEW vs EXISTING AUTOMATICALLY
Construction date provided: ${body.constructDate || 'NOT PROVIDED'}
Use this date against EACH regulation's own cutoff — do not use one cutoff for all:
 
FEDERAL NSPS (40 CFR Part 60) cutoffs:
- Subpart D (large utility boilers): after Aug 17, 1971
- Subpart Da (electric utility): after Sep 18, 1978
- Subpart Db (industrial boilers >100 MMBtu/hr): after Jun 19, 1984
- Subpart Dc (small boilers 10-100 MMBtu/hr): after Jun 9, 1989
- Subpart E (incinerators): after Aug 17, 1971
- Subpart Ea (municipal waste combustors): after Dec 20, 1989
- Subpart Eb (large MWC): after Sep 20, 1994
- Subpart Ec (hospital/medical): after Jun 20, 1996
- Subpart F (Portland cement): after Aug 17, 1971
- Subpart GG (gas turbines): after Oct 3, 1977
- Subpart IIII (CI engines): after Jul 11, 2005
- Subpart JJJJ (SI engines): after Jun 12, 2006
- Subpart KKKK (combustion turbines): after Feb 18, 2005
- Subpart CCCC (CISWI): after Nov 30, 1999
- Subpart OOOO (oil/gas): after Aug 23, 2011
- Subpart WWW (landfills): after May 30, 1991
- Subpart OOO (mineral processing): after Apr 22, 2008
- Subpart Kb (VOL storage tanks): after Jul 23, 1984
- Subpart BB (kraft pulp): after Sep 24, 1976
- Subpart BBa (kraft pulp amended): after Mar 23, 1990
 
FEDERAL NESHAP (40 CFR Part 63) cutoffs:
- Subpart ZZZZ (RICE engines): after Jun 12, 2006
- Subpart YYYY (combustion turbines): after Jan 14, 2003
- Subpart DDDDD (major source boilers): after Jun 4, 2010
- Subpart JJJJJJ (area source boilers): after Jun 4, 2010
- Subpart UUUUU (utility boilers/EGUs): after May 3, 2011
- Subpart S (pulp/paper): after Apr 15, 1998
- Subpart M (dry cleaning): after Dec 9, 1991
- Subpart N (chrome electroplating): after Jan 25, 1995
- Subpart T (halogenated solvents): after Jul 15, 1994
- Subpart CC (petroleum refineries): after Aug 18, 1995
- Subpart EEE (hazardous waste combustors): after Jun 19, 1996
- Subpart LLL (Portland cement): after Jun 16, 2008
- Subpart HHHHHH (paint stripping area): after Jan 9, 2008
- Subpart IIIIII (chrome plating area): after Jun 23, 2006
- Subpart JJJJJJ (area source boilers): after Jun 4, 2010
 
KENTUCKY STATE cutoffs:
- 401 KAR 59 (new sources): applies if construction after each regulation's effective date (~1972 for most)
- 401 KAR 61 (existing sources): applies if construction BEFORE 401 KAR 59 effective date
- Only one of 59 or 61 applies — not both
 
STEP 3 — CHECK APPLICABILITY CRITERIA
Only after exemptions are clear and new/existing is determined:
- Equipment type and fuel match the regulation's scope?
- Capacity/size threshold met?
- Source classification (major/area) relevant?
- Process type matches? (e.g., Subpart S = chemical pulp only, not mechanical)
 
STEP 4 — DETERMINE REQUIREMENTS
Only for applicable regulations — what must owner/operator do?
 
=====================================================================
SPECIFIC EXEMPTION RULES FOR COMMON REGULATIONS
(These are the most commonly missed — check these carefully)
=====================================================================
 
40 CFR 63 Subpart S — Pulp and Paper:
EXEMPTIONS (check FIRST):
- Does NOT apply to mechanical pulping (groundwood, TMP, CTMP, SGW)
- Does NOT apply to secondary fiber / recycled paper mills
- Does NOT apply to paper-only mills with no pulping operation
- Does NOT apply to non-chemical pulping processes
- ONLY applies to chemical pulping: kraft, sulfite, soda, semi-chemical
→ If pulping technology is NOT SPECIFIED → "needs-info" (ask for pulping type)
→ Do NOT assume it applies without knowing the pulping technology
 
40 CFR 60 Subpart Dc — Small Boilers:
EXEMPTIONS:
- Does not apply to units <10 MMBtu/hr heat input
- Does not apply to units >100 MMBtu/hr (use Db or Da instead)
- Natural gas units: exempt from SO2 and PM limits BUT still subject to notifications and recordkeeping
- Hot water heaters <2 MMBtu/hr: exempt
 
40 CFR 60 Subpart Db — Industrial Boilers:
EXEMPTIONS:
- Does not apply to units <100 MMBtu/hr (use Dc instead)
- Gas-fired units: no SO2 or PM standards, but NOx standards may apply
- Recovery furnaces at kraft pulp mills: subject to Subpart BB, not Db
 
40 CFR 63 Subpart DDDDD — Major Source Boilers:
EXEMPTIONS:
- Does NOT apply to area sources (use Subpart JJJJJJ instead)
- Electric utility steam generating units subject to Subpart UUUUU are exempt
- Temporary boilers (<12 months): exempt
- Boilers with a heat input capacity <10 MMBtu/hr at major sources: exempt
→ If major/area source status unknown → "needs-info"
 
40 CFR 63 Subpart JJJJJJ — Area Source Boilers:
EXEMPTIONS:
- Does NOT apply to major sources (use Subpart DDDDD instead)
- Natural gas-fired boilers: significant exemptions from emission limits
- Units <10 MMBtu/hr: limited requirements
→ If major/area source status unknown → "needs-info"
 
40 CFR 60 Subpart IIII — CI Engines:
EXEMPTIONS:
- Engines at test cells/stands: exempt
- Engines used as temporary replacement (<1 year) that are certified nonroad: exempt
- Construction commenced before Jul 11, 2005: NOT subject (not just exempt, simply not covered)
- National security exemptions available
 
40 CFR 60 Subpart JJJJ — SI Engines:
EXEMPTIONS:
- Engines at test cells/stands: exempt
- Temporary replacement units (<1 year) certified nonroad: exempt
- Construction commenced before Jun 12, 2006: NOT subject
 
40 CFR 63 Subpart ZZZZ — RICE:
EXEMPTIONS:
- Engines at test cells/stands: exempt
- For AREA sources: CI engines <300 HP exempt from most requirements (only annual inspection per 63.6625(e))
- For AREA sources: SI engines <500 HP exempt from most requirements (only annual inspection)
 
40 CFR 63 Subpart EEE — Hazardous Waste Combustors:
EXEMPTIONS:
- Only applies if burning RCRA hazardous waste as defined
- Pharmaceutical waste that is NOT RCRA hazardous: NOT subject to EEE, may be subject to CISWI (Subpart CCCC) instead
- Check whether waste stream is RCRA hazardous or non-hazardous
 
40 CFR 60 Subpart CCCC — CISWI:
EXEMPTIONS:
- Does not apply to units that burn hazardous waste (use EEE instead)
- Incinerators that burn only pathological waste or municipal solid waste: different subparts apply
- Units that combust non-hazardous solid waste from commercial/industrial sources
 
401 KAR Chapter 59 — New Equipment:
EXEMPTIONS (CRITICAL — commonly misapplied to engines):
- Process emission standards in KAR 59 do NOT apply to simple combustion equipment
  that simply burns fuel to produce energy (engines, turbines, simple process heaters)
- KAR 59 DOES apply to: boilers, indirect heat exchangers, process units that convert
  raw materials to products, drying operations, coating lines, kilns, calciners
- For engines and turbines: 401 KAR 59 is generally NOT applicable as a standalone
  process emission standard — federal NSPS/NESHAP cover those sources
 
401 KAR Chapter 61 — Existing Sources:
- Same process operation exemption as KAR 59
- Only one of KAR 59 OR KAR 61 applies — determined by construction date
 
401 KAR Chapter 63 — Generally Applicable:
- Opacity standards apply broadly to combustion and process sources
- Does apply to boilers, process heaters, incinerators
- For engines: opacity from exhaust is addressed by federal engine standards, 
  KAR 63 opacity is NOT separately cited for engines in Kentucky DAQ practice
 
=====================================================================
CONTROL DEVICES — ANALYZE EACH SEPARATELY
=====================================================================
Control devices installed:
${controlDeviceContext}
${body.controlDevices && body.controlDevices.length > 1 ?
'MULTIPLE CONTROL DEVICES: Each device must be analyzed separately for compliance obligations and CAM.' : ''}
 
CAM (40 CFR Part 64) — Check ALL THREE criteria for EACH control device:
1. Is the emission unit subject to an emission limit or standard for a regulated pollutant?
2. Does this unit use an add-on control device to achieve compliance with that limit/standard?
3. Are pre-control device emissions of that pollutant > 100 tpy?
CAM APPLIES only if ALL THREE are YES for a device-pollutant combination.
CAM does NOT apply if unit meets limits through inherent process design without add-on controls.
 
=====================================================================
GENERAL RULE — WHEN IN DOUBT → NEEDS-INFO, NOT APPLIES
=====================================================================
If critical information is missing to make a definitive determination:
- Do NOT default to "applies"
- Set status = "needs-info"  
- Specify EXACTLY what information is needed and why
This prevents over-flagging regulations that may not actually apply.
 
Respond ONLY with valid JSON:
{
  "summary": "3-4 sentences: what the source is, key applicable regulations found, new/existing determination, most important compliance actions. Be specific to this source.",
  "newExistingDetermination": "For each relevant regulation, state the construction date, the regulation's cutoff date, and the new/existing conclusion",
  "dataQuality": "complete|partial|insufficient",
  "missingInfo": ["Specific missing information item 1", "Specific missing information item 2"],
  "regulations": [
    {
      "id": "unique-id",
      "name": "40 CFR 60 Subpart Dc",
      "fullName": "Full descriptive name",
      "category": "Federal NSPS|Federal NESHAP|Federal Other|Kentucky State",
      "status": "applies|not-applies|needs-info",
      "badge": "Applies|Does not apply|More info needed",
      "newExisting": "New source|Existing source|N/A|Needs construction date",
      "exemptionChecked": "List each exemption checked and whether it applies or not. Be specific.",
      "reason": "2-3 sentences explaining the determination. Must reference the exemption check result AND the new/existing determination. Be specific to this source's characteristics.",
      "cite": "Specific section citations with brief explanation of each",
      "keyRequirements": ["Most important compliance requirement 1", "Requirement 2", "Requirement 3"],
      "controlDeviceNotes": "How each installed control device affects this regulation specifically",
      "url": "https://www.ecfr.gov/... or https://apps.legislature.ky.gov/..."
    }
  ],
  "permitType": {
    "determination": "Registration (401 KAR 52:070)|State Origin Permit (401 KAR 52:040)|Conditional Major|Title V (401 KAR 52:020)|No permit required|Needs more info",
    "reason": "Brief explanation referencing PTE thresholds and applicable requirements"
  },
  "camApplicability": {
    "status": "applies|not-applies|needs-info",
    "devices": [
      {
        "device": "Device name and type",
        "criterion1": "Subject to emission limit? Yes/No — cite the specific limit",
        "criterion2": "Uses add-on control device to comply? Yes/No — explain",
        "criterion3": "Pre-control emissions > 100 tpy? Yes/No/Unknown — explain",
        "conclusion": "CAM applies/not-applies/needs-info for this device"
      }
    ],
    "reason": "Overall CAM conclusion and explanation"
  }
}
 
Order regulations: applies first, needs-info second, not-applies last.
Include ALL regulations that could plausibly apply to this equipment type.
Do NOT include regulations that clearly cannot apply based on equipment type.`;
 
    const response = await fetch(
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
 
app.get('/stats', async (req, res) => {
  try {
    const { count } = await supabase
      .from('regulations')
      .select('*', { count: 'exact', head: true });
    res.json({ regulations_in_database: count, status: 'healthy', version: '4.0' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
 
app.listen(PORT, () => {
  console.log(`EEC AI Assistant API v4.0 running on port ${PORT}`);
});
 
