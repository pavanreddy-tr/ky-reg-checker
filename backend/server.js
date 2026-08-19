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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'EEC AI Assistant API running', version: '2.0' });
});

// Generate embedding for search query
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
  } catch (err) {
    return null;
  }
}

// Search regulations from database
async function searchRegulations(query, equipmentType, limit = 25) {
  try {
    // Try semantic search first
    const embedding = await generateEmbedding(query);
    
    if (embedding) {
      const { data, error } = await supabase.rpc('search_regulations', {
        query_embedding: embedding,
        match_threshold: 0.3,
        match_count: limit
      });
      if (!error && data && data.length > 0) {
        return data;
      }
    }

    // Fallback to keyword search
    const { data, error } = await supabase.rpc('keyword_search_regulations', {
      search_terms: query,
      result_limit: limit
    });
    
    if (!error && data) return data;
    
    // Final fallback - get all regulations
    const { data: allData } = await supabase
      .from('regulations')
      .select('id, source, part, subpart, section, title, content, url, equipment_tags')
      .limit(limit);
    
    return allData || [];
  } catch (err) {
    console.error('Search error:', err);
    return [];
  }
}

// Build search query from equipment details
function buildSearchQuery(body) {
  const parts = [];
  if (body.equipmentType) parts.push(body.equipmentType);
  if (body.equipmentCategory) parts.push(body.equipmentCategory);
  if (body.fuelType) parts.push(body.fuelType);
  if (body.process) parts.push(body.process);
  if (body.capacity) parts.push(body.capacity);
  if (body.pollutants) parts.push(body.pollutants);
  if (body.description) parts.push(body.description);
  return parts.join(' ') || 'stationary source air quality regulations Kentucky';
}

// Main regulation check endpoint
app.post('/check', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Gemini API key not configured.' });
  }

  const body = req.body;

  if (!body.equipmentType && !body.description) {
    return res.status(400).json({ error: 'Please provide equipment type or description.' });
  }

  try {
    // Step 1: Search for relevant regulations from database
    const searchQuery = buildSearchQuery(body);
    const relevantRegs = await searchRegulations(searchQuery, body.equipmentType, 20);

    // Step 2: Build regulation context from search results
    let regContext = '';
    if (relevantRegs.length > 0) {
      regContext = relevantRegs.map(r => 
        `=== ${r.title} ===\nSource: ${r.source === 'federal' ? `40 CFR Part ${r.part}${r.subpart ? ' Subpart ' + r.subpart : ''}` : r.part}\nURL: ${r.url || 'N/A'}\n${r.content ? r.content.slice(0, 2000) : 'See regulation text'}\n`
      ).join('\n---\n');
    } else {
      regContext = 'No specific regulations found in database. Use your general knowledge of 40 CFR Parts 60, 61, 62, 63 and 401 KAR Chapters 50-65.';
    }

    // Step 3: Build equipment details string
    const equipDetails = Object.entries(body)
      .filter(([k, v]) => v && v !== '')
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');

    // Step 4: Send to Gemini with actual regulation text
    const prompt = `You are an expert Kentucky air quality permitting engineer at the Kentucky Environmental and Energy Cabinet (EEC), Division for Air Quality. 

You have been given the following RELEVANT REGULATION TEXT extracted from the official regulation database. Use this text as your PRIMARY source for determining applicability. Cite specific sections from this text.

RELEVANT REGULATIONS FROM DATABASE:
${regContext}

EQUIPMENT/SOURCE DETAILS SUBMITTED:
${equipDetails}

YOUR TASK:
1. Review the regulation text provided above
2. Determine which regulations apply to this specific equipment/source
3. For each applicable regulation, cite the SPECIFIC SECTION that triggers applicability
4. Explain WHY it applies based on the equipment details
5. Flag any regulations that need more information
6. Note any regulations that clearly do not apply and why

IMPORTANT KENTUCKY PRACTICE NOTES:
- 401 KAR Chapter 59 (New Equipment) and Chapter 61 (Existing Sources) process operation emission standards do NOT apply to simple combustion equipment like engines and turbines - only to true process operations that convert raw materials into products
- 401 KAR Chapter 63 opacity standards are NOT separately cited for engines - covered by federal standards
- 401 KAR 52:070 Registration is automatically triggered whenever any 40 CFR Part 60, 61, or 63 standard applies
- Always check both major source AND area source applicability for Part 63 standards
- CAM (Compliance Assurance Monitoring) under 40 CFR Part 64 applies if: (1) subject to emission limit, (2) uses control device to comply, (3) pre-control emissions >100 tpy

Respond ONLY with valid JSON, no markdown, no text outside the JSON:
{
  "summary": "3-4 sentence plain English summary of the complete regulatory picture for this source, including most important compliance actions",
  "dataQuality": "complete" | "partial" | "insufficient",
  "missingInfo": ["list of any critical missing information needed for complete determination"],
  "regulations": [
    {
      "id": "unique-id",
      "name": "Regulation name e.g. 40 CFR 60 Subpart IIII",
      "fullName": "Full descriptive name",
      "category": "Federal NSPS" | "Federal NESHAP" | "Federal Other" | "Kentucky State",
      "status": "applies" | "not-applies" | "needs-info",
      "badge": "Applies" | "Does not apply" | "More info needed",
      "reason": "Detailed 2-3 sentence explanation of exactly why this regulation applies or does not apply to THIS specific equipment, referencing specific thresholds, dates, and criteria from the regulation text",
      "cite": "Specific citations with brief explanation e.g. §60.4200(a)(2) - applies because CI engine commenced construction after July 11 2005; §60.4205 - emergency engine emission standards",
      "keyRequirements": ["Most important compliance requirement 1", "Most important compliance requirement 2"],
      "url": "URL to regulation if available"
    }
  ],
  "permitType": {
    "determination": "Registration (401 KAR 52:070)" | "State Origin Permit (401 KAR 52:040)" | "Conditional Major Permit" | "Title V Permit (401 KAR 52:020)" | "No permit required" | "Needs more information",
    "reason": "Brief explanation of permit type determination based on PTE and applicable requirements"
  },
  "camApplicability": {
    "status": "applies" | "not-applies" | "needs-info",
    "reason": "Brief explanation of CAM applicability based on the three criteria"
  }
}

Order regulations: applicable ones first, needs-info second, not-applies last.
Be thorough - include ALL potentially applicable regulations found in the database text above.`;

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

    if (!response.ok) {
      return res.status(500).json({ error: 'Gemini API error: ' + (data?.error?.message || 'Unknown') });
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    if (!rawText) {
      return res.status(500).json({ error: 'Empty response from Gemini.' });
    }

    const cleaned = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');

    if (start === -1 || end === -1) {
      return res.status(500).json({ error: 'No JSON in response. Raw: ' + rawText.slice(0, 300) });
    }

    const parsed = JSON.parse(cleaned.slice(start, end + 1));

    // Save determination to database
    try {
      await supabase.from('determinations').insert({
        equipment_type: body.equipmentType || body.description,
        equipment_details: body,
        results: parsed
      });
    } catch (saveErr) {
      // Non-critical - don't fail if save fails
    }

    // Add metadata
    parsed.regulationsSearched = relevantRegs.length;
    parsed.searchQuery = searchQuery;

    res.json(parsed);

  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

// Get past determinations
app.get('/history', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('determinations')
      .select('id, created_at, equipment_type, equipment_details, results')
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get database stats
app.get('/stats', async (req, res) => {
  try {
    const { count } = await supabase
      .from('regulations')
      .select('*', { count: 'exact', head: true });
    res.json({ 
      regulations_in_database: count,
      status: 'healthy'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`EEC AI Assistant API running on port ${PORT}`);
});
