const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

app.get('/', (req, res) => {
  res.json({ status: 'KY Regulation Checker API is running' });
});

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

40 CFR 60 Subpart IIII: Applies if CI/diesel engine AND construction commenced AFTER July 11 2005 AND displacement less than 30 L/cyl. Key sections: 60.4204, 60.4205, 60.4207, 60.4211, 60.4214. Emergency engines limited to 100 hrs/yr maintenance plus 50 hrs/yr non-emergency use.

40 CFR 60 Subpart JJJJ: Applies if SI engine AND construction commenced AFTER June 12 2006. Key sections: 60.4233, 60.4243, 60.4245. Same 100+50 hr emergency limits.

40 CFR 63 Subpart ZZZZ: Applies to ALL reciprocating ICE at MAJOR sources. Also applies to CI engines 300 HP or more at AREA sources. Also applies to SI engines 500 HP or more at AREA sources. For emergency engines at area sources below those thresholds only requires annual inspection per 63.6625(e).

401 KAR Chapter 59: Applies to NEW stationary combustion sources in Kentucky. Visible emissions limit 20 percent opacity. Particulate matter limits.

401 KAR Chapter 61: Applies to EXISTING stationary combustion sources in Kentucky. Similar to KAR 59 but for existing equipment.

401 KAR Chapter 63: Opacity and visible emissions standards applying to virtually all Kentucky sources regardless of new or existing status.

401 KAR 52:070: Applies if source has PTE 10 tpy or more of regulated pollutant but below major source threshold, OR source is subject to any requirement in 40 CFR Parts 60 61 or 63. Backup generators subject to Subpart IIII or JJJJ automatically trigger this.

You must respond with ONLY a valid JSON object. No explanation, no markdown, no code blocks, just raw JSON.

{
  "summary": "2-3 sentence plain English summary",
  "regulations": [
    {
      "id": "60-IIII",
      "name": "40 CFR 60 Subpart IIII",
      "fullName": "NSPS for Stationary CI Internal Combustion Engines",
      "status": "applies",
      "badge": "Applies",
      "reason": "Specific reason referencing engine specs and thresholds",
      "cite": "60.4200(a)(2); 60.4205; 60.4207; 60.4211(f); 60.4214"
    }
  ]
}

Include all 7 IDs: 60-IIII, 60-JJJJ, 63-ZZZZ, KAR-59, KAR-61, KAR-63, KAR-52-070
Status must be exactly: applies, not-applies, or needs-info
Put applicable ones first, needs-info second, not-applies last.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json'
          }
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ error: 'Gemini API error: ' + (data?.error?.message || 'Unknown') });
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!rawText) {
      return res.status(500).json({ error: 'Empty response from Gemini. Response: ' + JSON.stringify(data).slice(0, 300) });
    }

    const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');

    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'No JSON found. Raw: ' + rawText.slice(0, 300) });
    }

    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    res.json(parsed);

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`KY Reg Checker API running on port ${PORT}`);
});
