const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'KY Regulation Checker API is running' });
});

// Main regulation check endpoint
app.post('/check', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'API key not configured on server.' });
  }

  const { engineType, engineUse, hp, modelYear, constructYear, displacement, sourceClass, sourceAge, facilityDesc } = req.body;

  if (!engineType || !engineUse || !hp || !modelYear || !constructYear) {
    return res.status(400).json({ error: 'Missing required engine fields.' });
  }

  const kw = (parseFloat(hp) * 0.7457).toFixed(1);

  const prompt = `You are a Kentucky air quality permitting engineer. Analyze these engine specs and determine which regulations apply.

ENGINE SPECS:
- Type: ${engineType}
- Use: ${engineUse}
- Power: ${hp} HP (${kw} KW)
- Model year: ${modelYear}
- Construction commenced: ${constructYear}
- Displacement: ${displacement ? displacement + ' L/cylinder' : 'not specified, assume <10 L/cyl'}
- Source class: ${sourceClass || 'unknown'}
- New/existing: ${sourceAge || 'new'}
${facilityDesc ? '- Facility: ' + facilityDesc : ''}

DECISION LOGIC:

40 CFR 60 Subpart IIII — CI engines NSPS:
Applies if: CI/diesel engine AND construction commenced AFTER July 11, 2005 AND displacement <30 L/cyl.
Not applicable to SI engines.
Key owner/operator sections: §60.4204 (non-emergency emission standards), §60.4205 (emergency emission standards), §60.4207 (fuel: must use ultra-low sulfur diesel <15 ppm sulfur), §60.4211 (compliance — must follow manufacturer written instructions, non-resettable hour meter required for emergency engines not meeting non-emergency standards), §60.4214 (recordkeeping/reporting — initial notification required for non-emergency engines >2237 KW or pre-2007 >130 KW).
Emergency engines: limited to 100 hrs/yr maintenance+testing PLUS 50 hrs/yr non-emergency use per §60.4211(f). No peak shaving allowed.

40 CFR 60 Subpart JJJJ — SI engines NSPS:
Applies if: SI engine AND construction commenced AFTER June 12, 2006.
Not applicable to CI/diesel engines.
HP thresholds matter: ≤25 HP (19 KW), 25-130 HP emergency only, ≥100 HP non-emergency natural gas, ≥500 HP.
Key sections: §60.4233 (emission standards — Table 1 NOx/CO/VOC limits for ≥100 HP natural gas), §60.4243 (compliance — certified engine must follow manufacturer specs; non-certified must performance test), §60.4245 (recordkeeping — all engines keep maintenance records; ≥500 HP non-certified must submit initial notification).
Emergency engines same 100+50 hr limits per §60.4243(d). No peak shaving.

40 CFR 63 Subpart ZZZZ — RICE NESHAP:
Applies to ALL reciprocating ICE (both CI and SI) at MAJOR sources regardless of HP.
Also applies to CI engines ≥300 HP at AREA sources.
Also applies to SI engines ≥500 HP at AREA sources.
For emergency engines at area sources BELOW those HP thresholds: only requires annual maintenance inspection per §63.6625(e) — much lighter requirement.
New engines at major sources must meet emission limits in Tables 2a (CI) or 2b (SI) of Subpart ZZZZ.
Existing engines have different compliance requirements based on size and source type.

401 KAR Chapter 59 — New Equipment:
Applies to NEW stationary combustion sources in Kentucky.
Visible emissions limit: 20% opacity max per 401 KAR 59:015.
Particulate matter limits from combustion sources per 401 KAR 59:016.
General combustion equipment standards. Applies alongside federal rules for new installations.
If source is "new," this chapter applies.

401 KAR Chapter 61 — Existing Sources:
Applies to EXISTING stationary combustion sources in Kentucky.
Similar emission standards to KAR 59 but for equipment existing before state rules took effect.
If source is "existing," this chapter applies instead of KAR 59.

401 KAR Chapter 63 — Generally Applicable:
Opacity and visible emissions standards applying to virtually all sources regardless of new/existing.
401 KAR 63:020 covers general nuisance/air quality provisions.
Applies to all combustion sources in Kentucky.

401 KAR 52:070 — Registration:
Applies if: (a) source has PTE ≥10 tpy regulated pollutant but below major source threshold, OR (b) source is subject to ANY requirement in 40 CFR Parts 60, 61, or 63 — even with very small emissions.
Since backup generators subject to Subpart IIII or JJJJ automatically trigger this.
Requires: register with KY Division for Air Quality, comply with applicable requirements, allow inspections.
Lighter requirement than Title V permit. Must apply before commencing construction.

Respond ONLY with valid JSON, absolutely no other text before or after the JSON:
{
  "summary": "2-3 sentence plain English summary of the regulatory picture for this specific engine",
  "regulations": [
    {
      "id": "60-IIII",
      "name": "40 CFR 60 Subpart IIII",
      "fullName": "NSPS for Stationary CI Internal Combustion Engines",
      "status": "applies",
      "badge": "Applies",
      "reason": "Specific reason citing the engine specs that trigger or exclude this rule, referencing exact thresholds and dates",
      "cite": "§ 60.4200(a)(2); § 60.4205; § 60.4207; § 60.4211(f); § 60.4214"
    }
  ]
}

Include ALL 7 regulation IDs in this exact order with applicable ones first:
"60-IIII", "60-JJJJ", "63-ZZZZ", "KAR-59", "KAR-61", "KAR-63", "KAR-52-070"
status must be exactly: "applies", "not-applies", or "needs-info"
badge text: "Applies", "Does not apply", or "More info needed"`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini API error:', data);
      return res.status(500).json({ error: 'Gemini API error: ' + (data?.error?.message || 'Unknown error') });
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) {
      return res.status(500).json({ error: 'Empty response from Gemini.' });
    }

    // Parse JSON from response
    const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    const jsonStr = cleaned.slice(start, end + 1);
    const parsed = JSON.parse(jsonStr);

    res.json(parsed);
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`KY Reg Checker API running on port ${PORT}`);
});
