Server v5 · JS
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
  res.json({ status: 'EEC AI Assistant API running', version: '5.0' });
});
 
// ─── FIX 1: SMARTER SEARCH ───────────────────────────────────────────────────
// Build multiple targeted search queries to maximize database hits
function buildSearchQueries(body) {
  const queries = new Set();
  const cat = (body.equipmentCategory || '').toLowerCase();
  const fuel = (body.fuelType || '').toLowerCase();
  const use = (body.equipmentType || '').toLowerCase();
  const desc = (body.description || '').toLowerCase();
 
  // Primary query - most specific
  queries.add([body.equipmentCategory, body.equipmentType, body.fuelType].filter(Boolean).join(' '));
 
  // Equipment-specific keyword queries
  if (cat.includes('engine') || cat.includes('ci') || cat.includes('diesel')) {
    queries.add('stationary compression ignition internal combustion engine CI diesel NSPS RICE');
    queries.add('NSPS Subpart IIII compression ignition diesel engine');
    queries.add('NESHAP Subpart ZZZZ RICE reciprocating internal combustion engine');
  }
  if (cat.includes('engine') && (fuel.includes('gas') || cat.includes('si') || cat.includes('spark'))) {
    queries.add('stationary spark ignition internal combustion engine natural gas NSPS');
    queries.add('NSPS Subpart JJJJ spark ignition natural gas engine');
  }
  if (cat.includes('boiler') || cat.includes('steam') || cat.includes('heat')) {
    queries.add('industrial commercial institutional boiler steam generating unit NSPS');
    queries.add('NSPS Subpart Dc small industrial boiler MMBtu');
    queries.add('NSPS Subpart Db industrial boiler MMBtu');
    queries.add('NESHAP Subpart DDDDD boiler major source MACT');
    queries.add('NESHAP Subpart JJJJJJ boiler area source');
    queries.add('401 KAR 59 new indirect heat exchanger boiler combustion');
  }
  if (cat.includes('turbine')) {
    queries.add('stationary combustion turbine gas turbine NSPS NESHAP');
    queries.add('NSPS Subpart KKKK combustion turbine NOx');
    queries.add('NESHAP Subpart YYYY combustion turbine HAP');
  }
  if (cat.includes('incinerator') || cat.includes('incinerat')) {
    queries.add('incinerator solid waste combustion NSPS NESHAP');
    queries.add('CISWI commercial industrial solid waste incineration Subpart CCCC');
    queries.add('hazardous waste combustor NESHAP Subpart EEE');
    queries.add('hospital medical infectious waste incinerator Subpart Ec');
    queries.add('municipal waste combustor Subpart Ea Eb');
  }
  if (cat.includes('storage') || cat.includes('tank')) {
    queries.add('storage tank volatile organic liquid petroleum VOC NSPS');
    queries.add('NSPS Subpart Kb volatile organic liquid storage vessel');
    queries.add('NESHAP storage tank HAP emissions');
  }
  if (cat.includes('coating') || cat.includes('paint')) {
    queries.add('surface coating operation VOC HAP NSPS NESHAP');
    queries.add('paint stripping coating area source NESHAP Subpart HHHHHH');
  }
  if (cat.includes('pulp') || cat.includes('paper') || cat.includes('kraft')) {
    queries.add('kraft pulp mill paper NSPS Subpart BB BBa');
    queries.add('pulp paper NESHAP Subpart S HAP');
    queries.add('401 KAR 59 process operation particulate matter');
  }
  if (cat.includes('cement')) {
    queries.add('Portland cement plant NSPS Subpart F NESHAP Subpart LLL');
  }
  if (cat.includes('mineral') || cat.includes('crush') || cat.includes('quarry') || cat.includes('asphalt')) {
    queries.add('nonmetallic mineral processing crushing screening NSPS Subpart OOO');
    queries.add('hot mix asphalt plant NSPS Subpart I');
    queries.add('401 KAR 59 process operation particulate matter');
  }
  if (cat.includes('chemical') || cat.includes('pharmaceutical') || desc.includes('tnt') || desc.includes('explosive')) {
    queries.add('chemical manufacturing SOCMI VOC HAP NESHAP NSPS');
    queries.add('pharmaceutical manufacturing HAP NESHAP');
    queries.add('hazardous waste combustion EEE');
  }
  if (cat.includes('electroplat') || cat.includes('metal finish') || cat.includes('chrome')) {
    queries.add('chromium electroplating metal finishing HAP NESHAP area source');
    queries.add('NESHAP Subpart N chrome electroplating NESHAP Subpart IIIIII area');
  }
  if (cat.includes('dry clean')) {
    queries.add('perchloroethylene dry cleaning NESHAP Subpart M');
  }
  if (cat.includes('solvent') || cat.includes('degreasing')) {
    queries.add('halogenated solvent cleaning degreasing NESHAP Subpart T');
  }
  if (cat.includes('landfill')) {
    queries.add('municipal solid waste landfill gas collection NSPS Subpart WWW');
  }
  if (cat.includes('wastewater') || cat.includes('potw')) {
    queries.add('publicly owned treatment works wastewater POTW HAP');
  }
  if (cat.includes('refin') || cat.includes('petroleum')) {
    queries.add('petroleum refinery NSPS NESHAP HAP benzene');
  }
  if (cat.includes('oil') || cat.includes('gas') || cat.includes('well')) {
    queries.add('crude oil natural gas production processing VOC methane NSPS Subpart OOOO');
  }
  if (cat.includes('printing') || cat.includes('graphic')) {
    queries.add('printing publishing graphic arts VOC NSPS Subpart QQ');
  }
  if (cat.includes('glass')) {
    queries.add('glass manufacturing HAP PM NSPS NESHAP');
  }
  if (cat.includes('lime')) {
    queries.add('lime manufacturing kiln NSPS Subpart HH NESHAP');
  }
  if (cat.includes('wood') || cat.includes('furniture')) {
    queries.add('wood furniture manufacturing HAP VOC NESHAP');
  }
 
  // Always include Kentucky permits and general provisions
  queries.add('401 KAR 52 permits registration Title V Kentucky air quality');
  queries.add('401 KAR 59 new stationary source performance standards Kentucky');
  queries.add('NSR PSD prevention significant deterioration major source review');
 
  return [...queries].filter(q => q.trim().length > 0).slice(0, 8);
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
 
async function searchRegulations(queries, limit = 30) {
  const seen = new Set();
  const results = [];
 
  for (const query of queries) {
    try {
      // Try semantic search first
      const embedding = await generateEmbedding(query);
      if (embedding) {
        const { data } = await supabase.rpc('search_regulations', {
          query_embedding: embedding,
          match_threshold: 0.25,
          match_count: 10
        });
        if (data) {
          data.forEach(r => {
            if (!seen.has(r.id)) { seen.add(r.id); results.push(r); }
          });
        }
      }
 
      // Also try keyword search
      const { data: kwData } = await supabase.rpc('keyword_search_regulations', {
        search_terms: query.split(' ').slice(0, 6).join(' '),
        result_limit: 8
      });
      if (kwData) {
        kwData.forEach(r => {
          if (!seen.has(r.id)) { seen.add(r.id); results.push(r); }
        });
      }
    } catch (e) {
      console.error('Search error for query:', query, e.message);
    }
 
    if (results.length >= limit) break;
  }
 
  return results.slice(0, limit);
}
 
function buildControlDeviceContext(controlDevices) {
  if (!controlDevices || controlDevices.length === 0) return 'None installed.';
  return controlDevices.map((d, i) =>
    `Device ${i + 1}: ${d.type}${d.efficiency ? ` | Efficiency: ${d.efficiency}` : ''}${d.pollutants ? ` | Controls: ${d.pollutants}` : ''}`
  ).join('\n');
}
 
// ─── FIX 2 & 3: NSR/PSD + ENHANCED CAM IN PROMPT ────────────────────────────
app.post('/check', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'API key not configured.' });
 
  const body = req.body;
  if (!body.equipmentCategory && !body.description) {
    return res.status(400).json({ error: 'Please provide equipment type or description.' });
  }
 
  try {
    const searchQueries = buildSearchQueries(body);
    console.log('Search queries:', searchQueries);
 
    const relevantRegs = await searchRegulations(searchQueries, 30);
    console.log(`Found ${relevantRegs.length} regulations from database`);
 
    const regContext = relevantRegs.length > 0
      ? relevantRegs.map(r =>
          `=== ${r.title} ===\nSource: ${r.source === 'federal'
            ? `40 CFR Part ${r.part}${r.subpart ? ' Subpart ' + r.subpart : ''}`
            : r.part}\nURL: ${r.url || 'N/A'}\n${(r.content || '').slice(0, 1500)}\n`
        ).join('\n---\n')
      : 'Database search returned no results. Use general regulatory knowledge.';
 
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
 
RELEVANT REGULATIONS RETRIEVED FROM DATABASE (${relevantRegs.length} found):
${regContext}
 
SOURCE DETAILS:
${equipDetails}
 
=====================================================================
MANDATORY ANALYSIS LOGIC
=====================================================================
 
STEP 1 — EXEMPTIONS FIRST (NON-NEGOTIABLE)
For EVERY regulation: check ALL exemptions before checking applicability.
If exempt → "not-applies" with exact exemption citation.
If key exemption trigger is UNKNOWN → "needs-info" NOT "applies".
 
STEP 2 — AUTO-DETERMINE NEW vs EXISTING
Construction date: ${body.constructDate || 'NOT PROVIDED'}
 
Key cutoff dates:
Federal NSPS (40 CFR 60):
- Subpart D: Aug 17 1971 | Subpart Da: Sep 18 1978 | Subpart Db: Jun 19 1984
- Subpart Dc: Jun 9 1989 | Subpart E: Aug 17 1971 | Subpart Ea: Dec 20 1989
- Subpart Eb: Sep 20 1994 | Subpart Ec: Jun 20 1996 | Subpart F: Aug 17 1971
- Subpart GG: Oct 3 1977 | Subpart IIII: Jul 11 2005 | Subpart JJJJ: Jun 12 2006
- Subpart KKKK: Feb 18 2005 | Subpart CCCC: Nov 30 1999 | Subpart WWW: May 30 1991
- Subpart OOO: Apr 22 2008 | Subpart OOOO: Aug 23 2011 | Subpart Kb: Jul 23 1984
- Subpart BB: Sep 24 1976 | Subpart BBa: Mar 23 1990
 
Federal NESHAP (40 CFR 63):
- Subpart ZZZZ: Jun 12 2006 | Subpart YYYY: Jan 14 2003
- Subpart DDDDD: Jun 4 2010 | Subpart JJJJJJ: Jun 4 2010
- Subpart UUUUU: May 3 2011 | Subpart S: Apr 15 1998
- Subpart M: Dec 9 1991 | Subpart N: Jan 25 1995 | Subpart T: Jul 15 1994
- Subpart CC: Aug 18 1995 | Subpart EEE: Jun 19 1996 | Subpart LLL: Jun 16 2008
- Subpart HHHHHH: Jan 9 2008 | Subpart IIIIII: Jun 23 2006
 
Kentucky: 401 KAR 59 (new, after ~Jul 2 1975) vs 401 KAR 61 (existing, before that date)
 
STEP 3 — APPLICABILITY CHECK
Only after exemptions confirmed clear and new/existing determined.
 
STEP 4 — REQUIREMENTS
Only for applicable regulations.
 
=====================================================================
SPECIFIC EXEMPTION RULES (most commonly missed)
=====================================================================
 
40 CFR 63 Subpart S (Pulp/Paper):
- ONLY applies to chemical pulping: kraft, sulfite, soda, semi-chemical
- Exempt: mechanical pulping, secondary fiber, recycled paper, paper-only
- Unknown pulping type → "needs-info"
 
40 CFR 60 Subpart Dc (Small Boilers):
- Applies to 10-100 MMBtu/hr only. <10 or >100 → use different subpart
- Natural gas: exempt from SO2/PM limits but subject to notifications/recordkeeping
 
40 CFR 60 Subpart Db (Large Boilers):
- Applies to >100 MMBtu/hr only. <100 → use Dc
 
40 CFR 63 Subpart DDDDD (Major Source Boilers):
- Does NOT apply to area sources → use JJJJJJ
- Electric utility EGUs subject to UUUUU: exempt
- <10 MMBtu/hr at major source: exempt
- Unknown major/area status → "needs-info"
 
40 CFR 63 Subpart JJJJJJ (Area Source Boilers):
- Does NOT apply to major sources → use DDDDD
- Natural gas units: significant exemptions from emission limits
- Unknown major/area status → "needs-info"
 
40 CFR 60 Subpart IIII (CI Engines):
- Commenced before Jul 11 2005: not subject (not just exempt)
- Test cells/stands: exempt
 
40 CFR 60 Subpart JJJJ (SI Engines):
- Commenced before Jun 12 2006: not subject
- Test cells/stands: exempt
 
40 CFR 63 Subpart ZZZZ (RICE):
- Area source CI <300 HP: only annual inspection required (§63.6625(e))
- Area source SI <500 HP: only annual inspection required
 
40 CFR 63 Subpart EEE (Hazardous Waste Combustors):
- ONLY applies if burning RCRA hazardous waste
- Non-hazardous pharmaceutical waste → CISWI (Subpart CCCC) instead
- Unknown waste classification → "needs-info"
 
40 CFR 60 Subpart CCCC (CISWI):
- Applies to non-hazardous commercial/industrial solid waste
- Burning hazardous waste → use EEE instead
- Burning only MSW → use Ea/Eb instead
 
401 KAR 59 process emission standards:
- Does NOT apply to engines, turbines (federal NSPS/NESHAP covers those)
- DOES apply to: boilers, indirect heat exchangers, kilns, dryers,
  process units converting raw materials to products, coating lines
 
401 KAR 63 opacity: applies to boilers, process sources, incinerators
(NOT separately cited for engines in Kentucky DAQ practice)
 
=====================================================================
FIX 2 — NSR/PSD APPLICABILITY (ALWAYS CHECK THIS)
=====================================================================
NSR (New Source Review) and PSD (Prevention of Significant Deterioration)
under 40 CFR Part 51/52 and 401 KAR Chapter 55 MUST be evaluated for:
 
PSD (major source, attainment areas):
- Applies if: new MAJOR stationary source (PTE ≥ 100 tpy any regulated pollutant,
  or ≥ 250 tpy for non-listed source categories, or ≥ 100 tpy for listed categories)
  in an attainment or unclassifiable area
- Also applies to: MAJOR MODIFICATION at existing major source exceeding
  significant emission increase thresholds (e.g., NOx: 40 tpy, SO2: 40 tpy,
  PM10: 15 tpy, PM2.5: 10 tpy, CO: 100 tpy, VOC: 40 tpy)
- Requirement: obtain PSD preconstruction permit BEFORE construction begins
- Key cited regulation: 401 KAR 55:005, 401 KAR 55:010, 40 CFR 52.21
 
Nonattainment NSR (major source, nonattainment areas):
- Applies if: new or modified major source in a nonattainment area for a pollutant
- Kentucky nonattainment: check current 8-hr ozone and PM2.5 designations
- Requires: Lowest Achievable Emission Rate (LAER), offsets
- Key cited regulation: 401 KAR 56:005, 401 KAR 56:010
 
Minor NSR (below major source thresholds):
- Kentucky requires minor source permits for sources below major thresholds
  but above registration thresholds, or with federally applicable requirements
- Covered under 401 KAR 52:020 (state origin permits)
 
NSR/PSD STATUS LOGIC:
- If source is major (criteria PTE ≥ 100 tpy) AND new → PSD likely required
- If source is major AND in nonattainment area → Nonattainment NSR required
- If source is major AND modified → check significant emission increase thresholds
- If source is minor → NSR/PSD does not apply, registration or state permit applies
- If source classification unknown → "needs-info"
 
Always include NSR/PSD as a separate regulation entry in your response.
 
=====================================================================
FIX 3 — ENHANCED CAM ANALYSIS (40 CFR Part 64)
=====================================================================
CAM applies ONLY when ALL THREE criteria are met for a specific pollutant-device pair:
 
CRITERION 1: Is the emission unit subject to an emission limit or standard
for the applicable regulated air pollutant?
- Look for: NSPS emission limits, NESHAP emission limits, SIP limits,
  permit conditions with numeric emission limits
- Note: work practice standards alone are NOT emission limits for CAM
 
CRITERION 2: Does the emission unit use an add-on control device to achieve
compliance with that emission limit or standard?
- Add-on control device = equipment added to reduce emissions (baghouse, scrubber,
  catalytic oxidizer, SCR, ESP, carbon adsorber, etc.)
- If unit meets limits through inherent process design or fuel switching
  without add-on controls → CAM does NOT apply for that pollutant
 
CRITERION 3: Are pre-control device potential emissions of the regulated
pollutant greater than 100 tons per year?
- Pre-control = uncontrolled emissions before the control device
- Must calculate or estimate uncontrolled PTE
- If unknown → flag as "needs-info" for this criterion
 
Control devices installed:
${controlDeviceContext}
 
${hasControlDevices ? `
For EACH control device listed above, evaluate CAM for EACH pollutant it controls:
- Identify the emission limit that the device helps achieve
- Determine if that limit is an enforceable numeric standard
- Estimate pre-control PTE for each pollutant
- State your conclusion for each device-pollutant combination
` : 'No control devices installed — CAM does not apply (Criterion 2 not met).'}
 
=====================================================================
RESPOND WITH VALID JSON ONLY:
=====================================================================
{
  "summary": "3-4 sentence summary specific to this source: what it is, key regulations found, new/existing status, most important actions needed",
  "newExistingDetermination": "For each relevant regulation found, state: cutoff date, construction date, conclusion (new/existing/not subject)",
  "dataQuality": "complete|partial|insufficient",
  "missingInfo": ["Specific item 1 needed and why", "Specific item 2"],
  "regulations": [
    {
      "id": "unique-id",
      "name": "Regulation name",
      "fullName": "Full descriptive name",
      "category": "Federal NSPS|Federal NESHAP|Federal NSR/PSD|Federal Other|Kentucky State",
      "status": "applies|not-applies|needs-info",
      "badge": "Applies|Does not apply|More info needed",
      "newExisting": "New source|Existing source|N/A|Needs construction date",
      "exemptionChecked": "Each exemption checked and result — be specific",
      "reason": "2-3 sentences explaining determination. Reference exemption check result, new/existing determination, and specific source characteristics.",
      "cite": "Specific section citations with brief explanation of each",
      "keyRequirements": ["Requirement 1", "Requirement 2", "Requirement 3"],
      "controlDeviceNotes": "How each installed control device affects this regulation",
      "url": "Regulation URL"
    }
  ],
  "nsrPsd": {
    "psdStatus": "applies|not-applies|needs-info",
    "psdReason": "Explanation referencing major source status and PTE thresholds",
    "nonattainmentStatus": "applies|not-applies|needs-info",
    "nonattainmentReason": "Explanation referencing nonattainment designations",
    "minorNsrStatus": "applies|not-applies|needs-info",
    "minorNsrReason": "For sources below major thresholds",
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
        "criterion3": "Pre-control PTE > 100 tpy? Yes/No/Unknown — explain calculation or estimate",
        "conclusion": "CAM applies/not-applies/needs-info — reason"
      }
    ],
    "reason": "Overall CAM conclusion"
  }
}
 
Order: applies first, needs-info second, not-applies last.
Always include NSR/PSD as a regulation entry in the regulations array.`;
 
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
    parsed.searchQueriesUsed = searchQueries.length;
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
    res.json({ regulations_in_database: count, status: 'healthy', version: '5.0' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
 
app.listen(PORT, () => {
  console.log(`EEC AI Assistant API v5.0 running on port ${PORT}`);
});
 
