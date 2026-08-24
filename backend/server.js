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
  res.json({ status: 'EEC AI Assistant API running', version: '3.0' });
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
 
===== CRITICAL LOGIC — FOLLOW THIS EXACT ORDER FOR EVERY REGULATION =====
 
STEP 1 — CHECK EXEMPTIONS FIRST (before anything else)
Look for and evaluate ALL exemption provisions in the regulation:
- Source category exemptions
- Size/threshold exemptions (below cutoff HP, MMBtu/hr, etc.)
- Date exemptions (commenced construction before X date)
- Use exemptions (emergency use, temporary, research)
- Geographic exemptions
If any exemption applies → "not-applies" — cite the exact exemption section.
Do NOT proceed to Step 2 if an exemption applies.
 
STEP 2 — AUTO-DETERMINE NEW vs EXISTING FROM CONSTRUCTION DATE
Construction date provided: ${body.constructDate || 'NOT PROVIDED'}
Determine new vs existing INDEPENDENTLY for each regulation based on that regulation's own cutoff:
- 40 CFR 60 Subpart IIII: new = after July 11, 2005
- 40 CFR 60 Subpart JJJJ: new = after June 12, 2006  
- 40 CFR 60 Subpart KKKK: new = after February 18, 2005
- 40 CFR 63 Subpart ZZZZ: new = after June 12, 2006
- 40 CFR 63 Subpart DDDDD (Boiler MACT major): new = after June 4, 2010
- 40 CFR 63 Subpart JJJJJJ (Boiler area source): new = after June 4, 2010
- 401 KAR 59: applies to NEW sources (after state regulation effective date)
- 401 KAR 61: applies to EXISTING sources (before state regulation effective date)
State your new/existing conclusion for each regulation.
 
STEP 3 — CHECK APPLICABILITY CRITERIA
Only if no exemption applies:
- Equipment type match?
- Capacity/size threshold met?
- Source classification (major/area source) relevant?
 
STEP 4 — DETERMINE REQUIREMENTS
Only if applicable — what must the owner/operator do?
 
===== CONTROL DEVICES =====
Control devices installed:
${controlDeviceContext}
${body.controlDevices && body.controlDevices.length > 1 ?
'MULTIPLE CONTROL DEVICES: Analyze each device separately for each regulation. Consider whether multiple devices affect monitoring, testing, or CAM applicability differently.' :
''}
 
===== KENTUCKY PRACTICE NOTES =====
- 401 KAR 59 process emission standards: do NOT apply to simple combustion equipment (engines, gas turbines). DO apply to boilers, process heaters, dryers, coating lines, process units that convert raw materials to products.
- 401 KAR 61: same as 59 but for existing sources
- 401 KAR 63 opacity: applies broadly to all combustion and process sources
- 401 KAR 52:070 Registration: automatically triggered by any applicable 40 CFR 60/61/63 requirement
- 401 KAR 55 PSD/NSR: check if new or modified major source triggers preconstruction review
 
===== CAM (40 CFR Part 64) =====
Check THREE criteria for each control device:
1. Is this emission unit subject to an emission limit or standard?
2. Does it use a control device to achieve compliance with that limit?
3. Are pre-control device emissions of the regulated pollutant greater than 100 tpy?
CAM applies only if ALL THREE are true for a device-pollutant combination.
 
Respond ONLY with valid JSON:
{
  "summary": "3-4 sentence summary: what source is, key applicable regulations, new/existing determination, most important compliance actions",
  "newExistingDetermination": "How new vs existing was determined from construction date ${body.constructDate || 'not provided'} against each regulation's cutoff",
  "dataQuality": "complete|partial|insufficient",
  "missingInfo": ["missing info items"],
  "regulations": [
    {
      "id": "60-IIII",
      "name": "40 CFR 60 Subpart IIII",
      "fullName": "Full name",
      "category": "Federal NSPS|Federal NESHAP|Federal Other|Kentucky State",
      "status": "applies|not-applies|needs-info",
      "badge": "Applies|Does not apply|More info needed",
      "newExisting": "New source|Existing source|N/A|Needs construction date",
      "exemptionChecked": "What exemptions were checked and result",
      "reason": "2-3 sentences explaining determination, must reference exemption check and new/existing determination",
      "cite": "Specific citations with explanation of each",
      "keyRequirements": ["requirement 1", "requirement 2"],
      "controlDeviceNotes": "How each installed control device affects this regulation",
      "url": "regulation URL"
    }
  ],
  "permitType": {
    "determination": "Registration (401 KAR 52:070)|State Origin Permit (401 KAR 52:040)|Conditional Major|Title V (401 KAR 52:020)|No permit required|Needs more info",
    "reason": "Brief explanation"
  },
  "camApplicability": {
    "status": "applies|not-applies|needs-info",
    "devices": [
      {
        "device": "Device name",
        "criterion1": "Subject to emission limit? Yes/No — why",
        "criterion2": "Uses control device to comply? Yes/No — why",
        "criterion3": "Pre-control >100 tpy? Yes/No/Unknown — why",
        "conclusion": "CAM applies/not-applies/needs-info for this device"
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
    res.json({ regulations_in_database: count, status: 'healthy', version: '3.0' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
 
app.listen(PORT, () => {
  console.log(`EEC AI Assistant API v3.0 running on port ${PORT}`);
});
 
