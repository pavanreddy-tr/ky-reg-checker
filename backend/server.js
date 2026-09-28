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
const DB_HEADERS = () => ({
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json'
});

async function dbGet(table, params = {}) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, v));
  const resp = await fetch(url.toString(), { headers: DB_HEADERS() });
  if (!resp.ok) throw new Error(`DB ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

async function dbCount(table) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id`, {
    headers: { ...DB_HEADERS(), 'Prefer': 'count=exact', 'Range': '0-0' }
  });
  const range = resp.headers.get('content-range') || '0-0/0';
  return parseInt(range.split('/')[1] || '0', 10);
}

async function dbInsert(table, data) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...DB_HEADERS(), 'Prefer': 'return=minimal' },
    body: JSON.stringify(data)
  });
  return resp.ok;
}

async function dbRpc(fn, params) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: DB_HEADERS(),
    body: JSON.stringify(params)
  });
  if (!resp.ok) throw new Error(`RPC ${fn}: ${resp.status}`);
  return resp.json();
}

// ── EEC PERMIT LANGUAGE TEMPLATES ─────────────────────────────────────────
// Real permit language extracted from Kentucky EEC permits (V-20-025 R2)
// These replace Gemini generation for known equipment types

const PERMIT_TEMPLATES = {

  "boiler_ng_large": {
    applicableRegs: [
      "401 KAR 59:015, New indirect heat exchangers",
      "401 KAR 60:005, Section 2(2)(c) 40 CFR 60.40b through 60.49b (Subpart Db), Standards of Performance for Industrial-Commercial-Institutional Steam Generating Units"
    ],
    stateOriginReqs: "401 KAR 59:015, Section 4; 401 KAR 59:015, Section 7",
    precludedRegs: "401 KAR 51:017, Prevention of significant deterioration of air quality",
    nonApplicableRegs: "401 KAR 63:002, Section 2(4)(jjjjj) 40 CFR 63.11193 through 63.11237, Tables 1 through 8 (Subpart JJJJJJ), National Emission Standards for Hazardous Air Pollutants for Industrial, Commercial, and Institutional Boilers Area Sources",
    operatingLimitations: [
      {
        requirement: "During a startup period or shutdown period, the permittee shall comply with the work practice standards established in 401 KAR 59:015, Section 7 [401 KAR 59:015, Section 7]:\n\ti) The permittee shall comply with 401 KAR 50:055, Section 2(5) [401 KAR 59:015, Section 7(1)(a)].\n\tii) The frequency and duration of startup periods or shutdown periods shall be minimized by the affected facility [401 KAR 59:015, Section 7(1)(b)].\n\tiii) All reasonable steps shall be taken by the permittee to minimize the impact of emissions on ambient air quality from the affected facility during startup periods and shutdown periods [401 KAR 59:015, Section 7(1)(c)].\n\tiv) The actions, including duration of the startup period, of the permittee of each affected facility during startup periods and shutdown periods, shall be documented by signed, contemporaneous logs or other relevant evidence [401 KAR 59:015, Section 7(1)(d)].\n\tv) Startups and shutdowns shall be conducted according to manufacturer recommended procedures, or procedures for a unit of similar design as approved by the Cabinet [401 KAR 59:015, Section 7(1)(e)].\n\tCompliance Demonstration: See 5. Specific Recordkeeping Requirements: (b).",
        citation: "401 KAR 59:015, Section 7"
      }
    ],
    emissionLimitations: [
      {
        requirement: "Particulate emissions from the unit shall not exceed 0.10 lb/MMBtu [401 KAR 59:015, Section 4(1)(b)].\n\tCompliance Demonstration: This unit is assumed to be in compliance with the allowable PM limitation while combusting natural gas.",
        citation: "401 KAR 59:015, Section 4(1)(b)"
      },
      {
        requirement: "Visible emissions shall not exceed 20% opacity from any stack except [401 KAR 59:015 Section 4(2)]:\n\ti) that a maximum of 27% opacity shall be allowed for one 6-minute period in any 60 consecutive minutes [401 KAR 59:015, Section 4(2)(a)];\n\tii) for emissions caused by building a new fire, emissions during the period required to bring up to operating conditions shall be allowed, if the method used is recommended by the manufacturer [401 KAR 59:015, Section 4(2)(c)].\n\tCompliance Demonstration: This unit is assumed to be in compliance with the allowable opacity limitation while combusting natural gas.",
        citation: "401 KAR 59:015, Section 4(2)"
      },
      {
        requirement: "The permittee shall not cause to be discharged into the atmosphere from the unit any gases that contain NOx (expressed as NO2) in excess of 86 ng/J (0.20 lb/MMBtu) heat input [40 CFR 60.44b(l) and 60.44b(l)(1)]. This NOx standard applies at all times including periods of startup, shutdown, or malfunction [40 CFR 60.44b(h)]. Compliance with this NOx standard is determined on a 30-day rolling average basis [40 CFR 60.44b(i)].\n\tCompliance Demonstration: See 3. Testing Requirements: (c).",
        citation: "40 CFR 60.44b(l)"
      },
      {
        requirement: "See Section D Source Emission Limitation and Testing Requirements.",
        citation: "401 KAR 52:020, Section 26"
      }
    ],
    testingRequirements: [
      {
        requirement: "Testing shall be conducted at such time as may be requested by the Cabinet [401 KAR 59:005, Section 2(2) and 401 KAR 50:045, Section 1].",
        citation: "401 KAR 59:005, Section 2(2)"
      },
      {
        requirement: "The permittee shall conduct a performance test for CO and PM10 emissions within 60 days after achieving the maximum production rate, but not later than 180 days after initial start-up of the unit [401 KAR 50:045, Section 1]:\n\ti) The CO performance test shall utilize U.S. EPA Reference Method 10, or an equivalent method approved by the Division.\n\tii) PM10 shall be measured by Reference Method 5 and Reference Method 202, or an equivalent method approved by the Division to determine an emission factor for PM10 (filterable + condensable) in terms of lb/MMscf.",
        citation: "401 KAR 50:045, Section 1"
      },
      {
        requirement: "To determine compliance with the emission limits for NOx required under 40 CFR 60.44b, the permittee shall conduct a performance test using the continuous system for monitoring NOx (NOx CEMS) within 60 days after achieving the maximum production rate, but not later than 180 days after initial startup [40 CFR 60.46b(e) and 40 CFR 60.8].",
        citation: "40 CFR 60.46b(e)"
      },
      {
        requirement: "For the initial compliance test, NOx emissions shall be monitored for 30 successive steam generating unit operating days and the 30-day average emission rate is used to determine compliance with the NOx emission standards under 40 CFR 60.44b [40 CFR 60.46b(e)(1)].",
        citation: "40 CFR 60.46b(e)(1)"
      }
    ],
    monitoringRequirements: [
      {
        requirement: "The permittee shall monitor the amount of natural gas combusted, in MMscf, on a monthly basis for the boiler [401 KAR 52:020, Section 10 and 40 CFR 60.49b(d)(2)].",
        citation: "401 KAR 52:020, Section 10; 40 CFR 60.49b(d)(2)"
      },
      {
        requirement: "The permittee shall install, calibrate, maintain, and operate a continuous emissions monitoring system (CEMS) for measuring NOx and O2 (or CO2) emissions discharged to the atmosphere, and shall record the output of the system [40 CFR 60.48b(b)(1)]:\n\ti) The CEMS shall be operated and data recorded during all periods of operation of the affected facility except for CEMS breakdowns and repairs [40 CFR 60.48b(c)].\n\tii) The 1-hour average NOx emission rates measured by the continuous NOx monitor shall be expressed in ng/J or lb/MMBtu heat input [40 CFR 60.48b(d)].\n\tiii) The procedures under 40 CFR 60.13 shall be followed for installation, evaluation, and operation of the continuous monitoring systems [40 CFR 60.48b(e)].\n\tiv) The NOx CEMS span value is 500 ppm [40 CFR 60.48b(e)(2)(i)].",
        citation: "40 CFR 60.48b(b)"
      }
    ],
    recordkeepingRequirements: [
      {
        requirement: "The permittee shall maintain records of the amount of natural gas combusted, in MMscf, on a monthly basis for the boiler [401 KAR 52:020, Section 10 and 40 CFR 60.49b(d)(2)].",
        citation: "401 KAR 52:020, Section 10"
      },
      {
        requirement: "The permittee shall keep records of the manufacturer startup and shutdown procedures, any instance in which the recommended procedures were not followed, and any corrective actions taken [401 KAR 59:015, Section 7].",
        citation: "401 KAR 59:015, Section 7"
      },
      {
        requirement: "The permittee shall maintain records required by 40 CFR 60, Subpart Db for a period of two (2) years following the date of such record [40 CFR 60.49b(o)], and five years per Section F Monitoring, Recordkeeping, and Reporting Requirements, item 2.",
        citation: "40 CFR 60.49b(o)"
      },
      {
        requirement: "The permittee shall maintain records of the following information for each steam generating unit operating day [40 CFR 60.49b(g)]:\n\ti) Calendar date [40 CFR 60.49b(g)(1)];\n\tii) The average hourly NOx emission rates (expressed as NO2) (ng/J or lb/MMBtu heat input) measured or predicted [40 CFR 60.49b(g)(2)];\n\tiii) The 30-day average NOx emission rates calculated at the end of each steam generating unit operating day [40 CFR 60.49b(g)(3)];\n\tiv) Identification of the steam generating unit operating days when the 30-day average NOx emission rates exceed the standards, with reasons for such excess and corrective actions taken [40 CFR 60.49b(g)(4)];\n\tv) Identification of times when emission data have been excluded from the calculation of average emission rates and the reasons for excluding data [40 CFR 60.49b(g)(6)];\n\tvi) Results of daily CEMS drift tests and quarterly accuracy assessments as required under 40 CFR 60, Appendix F, Procedure 1 [40 CFR 60.49b(g)(10)].",
        citation: "40 CFR 60.49b(g)"
      }
    ],
    reportingRequirements: [
      {
        requirement: "The reporting period required for the periodic reports required under 40 CFR 60, Subpart Db is each six (6)-month period. All reports shall be submitted to the Administrator and shall be postmarked by the thirtieth (30th) day following the end of the reporting period [40 CFR 60.49b(w)].",
        citation: "40 CFR 60.49b(w)"
      },
      {
        requirement: "The permittee shall submit notification of the initial startup to the Cabinet, which includes the design heat input capacity of the affected facility and identification of the fuels to be combusted [40 CFR 60.49b(a)].",
        citation: "40 CFR 60.49b(a)"
      },
      {
        requirement: "The permittee shall submit the performance test data from the initial performance test and the performance evaluation of the CEMS to the Administrator [40 CFR 60.49b(b)].",
        citation: "40 CFR 60.49b(b)"
      },
      {
        requirement: "The permittee shall submit excess emission reports for any excess emissions that occurred during the reporting period. Excess emissions are defined as any calculated 30-day rolling average NOx emission rate that exceeds the applicable emission limits in 40 CFR 60.44b [40 CFR 60.49b(h)].",
        citation: "40 CFR 60.49b(h)"
      },
      {
        requirement: "See Section F Monitoring, Recordkeeping, and Reporting Requirements.",
        citation: "401 KAR 52:020, Section 26"
      }
    ]
  },

  "engine_si_ng_emergency": {
    applicableRegs: [
      "401 KAR 60:005, Section 2(2)(eeee) 40 CFR 60.4230 to 60.4248, Tables 1 to 4 (Subpart JJJJ), Standards of Performance for Stationary Spark Ignition Internal Combustion Engines",
      "401 KAR 63:002, Section 2(4)(eeee) 40 CFR 63.6580 to 63.6675, Tables 1a to 8, and Appendix A (Subpart ZZZZ), National Emission Standards for Hazardous Air Pollutants for Stationary Reciprocating Internal Combustion Engines"
    ],
    stateOriginReqs: "None",
    precludedRegs: "401 KAR 51:017, Prevention of significant deterioration of air quality",
    nonApplicableRegs: "None",
    operatingLimitations: [
      {
        requirement: "The permittee shall operate the emergency stationary ICE according to the requirements of 40 CFR 60.4243(d)(1) through (3). In order for the engine to be considered an emergency stationary ICE under 40 CFR 60, Subpart JJJJ, any operation other than emergency operation, maintenance and testing, and operation in non-emergency situations for 50 hours per year is prohibited [40 CFR 60.4243(d)]:\n\ti) There is no time limit on the use of emergency stationary ICE in emergency situations [40 CFR 60.4243(d)(1)].\n\tii) The permittee may operate the emergency stationary ICE for maintenance checks and readiness testing for a maximum of 100 hours per calendar year. Any operation for non-emergency situations counts as part of the 100 hours per calendar year [40 CFR 60.4243(d)(2)].\n\tiii) Emergency stationary ICE may be operated for up to 50 hours per calendar year in non-emergency situations. The 50 hours of operation in non-emergency situations are counted as part of the 100 hours per calendar year for maintenance and testing [40 CFR 60.4243(d)(3)].",
        citation: "40 CFR 60.4243(d)"
      },
      {
        requirement: "The permittee shall meet the requirements of 40 CFR 63, Subpart ZZZZ by meeting the requirements of 40 CFR 60, Subpart JJJJ. No further requirements apply under 40 CFR 63 [40 CFR 63.6590(c) and 63.6590(c)(1)].",
        citation: "40 CFR 63.6590(c)"
      }
    ],
    emissionLimitations: [
      {
        requirement: "See Section D - Source Emission Limitations and Testing Requirements.",
        citation: "401 KAR 52:020, Section 26"
      }
    ],
    testingRequirements: [
      {
        requirement: "Testing shall be conducted at such time as may be requested by the Cabinet in accordance with 401 KAR 59:005, Section 2(2) and 401 KAR 50:045, Section 4.",
        citation: "401 KAR 59:005, Section 2(2)"
      }
    ],
    monitoringRequirements: [
      {
        requirement: "The permittee shall use a non-resettable operating hour meter to monitor hours of operation in emergency and nonemergency service [401 KAR 52:020, Section 10].",
        citation: "401 KAR 52:020, Section 10"
      },
      {
        requirement: "The permittee shall monitor the amount of natural gas combusted, in MMscf, and hours of operation on a monthly basis [401 KAR 52:020, Section 10].",
        citation: "401 KAR 52:020, Section 10"
      }
    ],
    recordkeepingRequirements: [
      {
        requirement: "The permittee shall keep records of the operation of the engine in emergency and non-emergency service that are recorded through the non-resettable hour meter, including the time of operation of the engine and the reason the engine was in operation during that time [401 KAR 52:020, Section 10].",
        citation: "401 KAR 52:020, Section 10"
      },
      {
        requirement: "The permittee shall maintain records of the amount of natural gas combusted, in MMscf on a monthly basis [401 KAR 52:020, Section 10].",
        citation: "401 KAR 52:020, Section 10"
      },
      {
        requirement: "All records shall be retained for a period of five (5) years and made available for inspection upon request [401 KAR 52:020, Section 26].",
        citation: "401 KAR 52:020, Section 26"
      }
    ],
    reportingRequirements: [
      {
        requirement: "See Section F Monitoring, Recordkeeping, and Reporting Requirements.",
        citation: "401 KAR 52:020, Section 26"
      }
    ]
  },

  "engine_ci_diesel_emergency": {
    applicableRegs: [
      "401 KAR 60:005, Section 2(2)(cccc) 40 CFR 60.4200 to 60.4218, Tables 1 to 4 (Subpart IIII), Standards of Performance for Stationary Compression Ignition Internal Combustion Engines",
      "401 KAR 63:002, Section 2(4)(eeee) 40 CFR 63.6580 to 63.6675, Tables 1a to 8, and Appendix A (Subpart ZZZZ), National Emission Standards for Hazardous Air Pollutants for Stationary Reciprocating Internal Combustion Engines"
    ],
    stateOriginReqs: "None",
    precludedRegs: "401 KAR 51:017, Prevention of significant deterioration of air quality",
    nonApplicableRegs: "None",
    operatingLimitations: [
      {
        requirement: "The permittee shall operate the emergency stationary CI ICE according to the requirements of 40 CFR 60.4211(f)(1) through (3). In order for the engine to be considered an emergency stationary CI ICE under 40 CFR 60, Subpart IIII, any operation other than emergency operation, maintenance and testing, and non-emergency operation for 50 hours per year is prohibited [40 CFR 60.4211(f)]:\n\ti) There is no time limit on the use of emergency stationary CI ICE in emergency situations [40 CFR 60.4211(f)(1)].\n\tii) The permittee may operate the emergency stationary CI ICE for maintenance checks and readiness testing for a maximum of 100 hours per calendar year [40 CFR 60.4211(f)(2)].\n\tiii) Emergency stationary CI ICE may be operated for up to 50 hours per calendar year in non-emergency situations. The 50 hours are counted as part of the 100 hours per calendar year for maintenance and testing [40 CFR 60.4211(f)(3)].",
        citation: "40 CFR 60.4211(f)"
      },
      {
        requirement: "The permittee shall use diesel fuel with a maximum sulfur content of 15 ppm (ultra-low sulfur diesel) at all times [40 CFR 60.4207(b)].",
        citation: "40 CFR 60.4207(b)"
      },
      {
        requirement: "The permittee shall install a non-resettable hour meter on the engine prior to startup [40 CFR 60.4211(f)(3)].",
        citation: "40 CFR 60.4211(f)(3)"
      }
    ],
    emissionLimitations: [
      {
        requirement: "See Section D - Source Emission Limitations and Testing Requirements.",
        citation: "401 KAR 52:020, Section 26"
      }
    ],
    testingRequirements: [
      {
        requirement: "Testing shall be conducted at such time as may be requested by the Cabinet in accordance with 401 KAR 59:005, Section 2(2) and 401 KAR 50:045, Section 4.",
        citation: "401 KAR 59:005, Section 2(2)"
      }
    ],
    monitoringRequirements: [
      {
        requirement: "The permittee shall use a non-resettable operating hour meter to monitor hours of operation in emergency and nonemergency service [401 KAR 52:020, Section 10].",
        citation: "401 KAR 52:020, Section 10"
      },
      {
        requirement: "The permittee shall monitor fuel usage and hours of operation on a monthly basis [401 KAR 52:020, Section 10].",
        citation: "401 KAR 52:020, Section 10"
      }
    ],
    recordkeepingRequirements: [
      {
        requirement: "The permittee shall keep records of the operation of the engine in emergency and non-emergency service that are recorded through the non-resettable hour meter, including the time of operation of the engine and the reason the engine was in operation during that time [401 KAR 52:020, Section 10].",
        citation: "401 KAR 52:020, Section 10"
      },
      {
        requirement: "The permittee shall maintain records of the amount of diesel fuel combusted, in gallons, on a monthly basis, and retain fuel purchase receipts or delivery records documenting ultra-low sulfur diesel fuel use [401 KAR 52:020, Section 10; 40 CFR 60.4207(b)].",
        citation: "401 KAR 52:020, Section 10"
      },
      {
        requirement: "All records shall be retained for a period of five (5) years and made available for inspection upon request [401 KAR 52:020, Section 26].",
        citation: "401 KAR 52:020, Section 26"
      }
    ],
    reportingRequirements: [
      {
        requirement: "See Section F Monitoring, Recordkeeping, and Reporting Requirements.",
        citation: "401 KAR 52:020, Section 26"
      }
    ]
  }
};

// ── TEMPLATE MATCHING ─────────────────────────────────────────────────────
function getPermitTemplate(unit) {
  const cat = (unit.equipmentCategory || unit.description || '').toLowerCase();
  const fuel = (unit.fuelType || '').toLowerCase();
  const use = (unit.equipmentType || unit.description || '').toLowerCase();
  const capStr = (unit.capacity || '').replace(/[^0-9.]/g, '');
  const cap = parseFloat(capStr) || 0;
  const capUnit = (unit.capacity || '').toLowerCase();
  const isMMBtu = capUnit.includes('mmbtu');
  const capMMBtu = isMMBtu ? cap : 0;

  const isEmergency = use.includes('emergency') || use.includes('standby');
  const isNatGas = fuel.includes('natural gas') || fuel.includes('ng');
  const isDiesel = fuel.includes('diesel') || fuel.includes('no. 2') || fuel.includes('distillate');
  const isCI = cat.includes('ci') || cat.includes('diesel') || cat.includes('compression ignition');
  const isSI = cat.includes('si') || cat.includes('spark ignition') || cat.includes('propane') || cat.includes('lpg') || (cat.includes('engine') && isNatGas);
  const isBoiler = cat.includes('boiler') || cat.includes('indirect heat exchanger') || cat.includes('steam generating');

  if (isBoiler && isNatGas && capMMBtu > 100) return PERMIT_TEMPLATES["boiler_ng_large"];
  if (isSI && isEmergency) return PERMIT_TEMPLATES["engine_si_ng_emergency"];
  if (isCI && isEmergency && isDiesel) return PERMIT_TEMPLATES["engine_ci_diesel_emergency"];

  return null;
}

app.get('/', (req, res) => {
  res.json({ status: 'EEC AI Assistant API running', version: '15.3' });
});

app.get('/stats', async (req, res) => {
  try {
    const count = await dbCount('regulations');
    res.json({ regulations_in_database: count, status: 'healthy', version: '15.3' });
  } catch (err) {
    res.json({ regulations_in_database: 428, status: 'healthy', version: '15.3', note: 'cached' });
  }
});

app.get('/history', async (req, res) => {
  try {
    const data = await dbGet('determinations', {
      select: 'id,created_at,equipment_type,equipment_details,results',
      order: 'created_at.desc',
      limit: 50
    });
    res.json(data || []);
  } catch (err) { res.json([]); }
});

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

async function searchRegulations(body, limit = 35) {
  const seen = new Set();
  const results = [];
  const SELECT = 'id,source,part,subpart,section,title,content,url,equipment_tags';

  const addRows = (rows) => {
    if (!Array.isArray(rows)) return;
    rows.forEach(r => { if (r && !seen.has(r.id)) { seen.add(r.id); results.push(r); } });
  };

  const searchWords = [body.equipmentCategory, body.equipmentType, body.fuelType, body.description]
    .filter(Boolean).join(' ').split(/\s+/).filter(w => w.length > 3).slice(0, 8);

  for (const word of [...new Set(searchWords)]) {
    try {
      const rows = await dbGet('regulations', { select: SELECT, title: `ilike.*${word}*`, limit: 8 });
      addRows(rows);
    } catch (e) {}
  }
  try {
    const kw = searchWords.slice(0, 4).join(' ');
    if (kw) addRows(await dbRpc('keyword_search_regulations', { search_terms: kw, result_limit: 10 }));
  } catch (e) {}
  try {
    const embedText = searchWords.join(' ') + ' air quality regulation Kentucky';
    const embedding = await generateEmbedding(embedText);
    if (embedding) {
      addRows(await dbRpc('search_regulations', { query_embedding: embedding, match_threshold: 0.2, match_count: 15 }));
    }
  } catch (e) {}
  try {
    addRows(await dbGet('regulations', { select: SELECT, source: 'eq.kentucky', limit: 20 }));
  } catch (e) {}

  return results.slice(0, limit);
}

async function fetchApplicableRegTexts(body) {
  const cat = (body.equipmentCategory || '').toLowerCase();
  const fuel = (body.fuelType || '').toLowerCase();
  const use = (body.equipmentType || '').toLowerCase();
  const desc = (body.description || '').toLowerCase();
  const capStr = (body.capacity || '').replace(/[^0-9.]/g, '');
  const cap = parseFloat(capStr) || 0;
  const capUnit = (body.capacity || '').toLowerCase();
  const isMMBtu = capUnit.includes('mmbtu') || capUnit.includes('btu');
  const isHP = capUnit.includes('hp') || capUnit.includes('horsepower');
  const capMMBtu = isMMBtu ? cap : 0;
  const isMajor = (body.sourceClass || '').toLowerCase().includes('major');
  const isArea = (body.sourceClass || '').toLowerCase().includes('area');

  const toFetch = [
    { part: '401 KAR 52', subpart: null },
    { part: '401 KAR 59', subpart: null },
    { part: '401 KAR 63', subpart: null },
  ];

  const isCI = cat.includes('ci') || cat.includes('diesel') || cat.includes('compression ignition');
  const isSI = cat.includes('si') || cat.includes('spark ignition') || cat.includes('natural gas') || cat.includes('gasoline') || cat.includes('landfill gas');
  const isEngine = isCI || isSI || cat.includes('engine');
  const isBoiler = cat.includes('boiler') || cat.includes('steam generating') || cat.includes('process heater') || cat.includes('indirect heat');
  const isTurbine = cat.includes('turbine') || cat.includes('gas turbine') || cat.includes('combustion turbine');
  const isLandfill = cat.includes('landfill');

  if (isCI) { toFetch.push({ part: '60', subpart: 'IIII' }); toFetch.push({ part: '63', subpart: 'ZZZZ' }); }
  if (isSI) { toFetch.push({ part: '60', subpart: 'JJJJ' }); toFetch.push({ part: '63', subpart: 'ZZZZ' }); }
  if (isBoiler) {
    if (capMMBtu > 100 || (!isMMBtu && cap > 100)) { toFetch.push({ part: '60', subpart: 'Db' }); toFetch.push({ part: '60', subpart: 'Da' }); }
    else if (capMMBtu >= 10 || (!isMMBtu && cap >= 10)) { toFetch.push({ part: '60', subpart: 'Dc' }); }
    else { toFetch.push({ part: '60', subpart: 'Dc' }); toFetch.push({ part: '60', subpart: 'Db' }); }
    if (isMajor) toFetch.push({ part: '63', subpart: 'DDDDD' });
    if (isArea) toFetch.push({ part: '63', subpart: 'JJJJJJ' });
    if (!isMajor && !isArea) { toFetch.push({ part: '63', subpart: 'DDDDD' }); toFetch.push({ part: '63', subpart: 'JJJJJJ' }); }
    if (cat.includes('utility') || cat.includes('electric')) toFetch.push({ part: '63', subpart: 'UUUUU' });
    toFetch.push({ part: '401 KAR 61', subpart: null });
  }
  if (isTurbine) { toFetch.push({ part: '60', subpart: 'KKKK' }); toFetch.push({ part: '63', subpart: 'YYYY' }); }
  if (isLandfill) {
    toFetch.push({ part: '60', subpart: 'WWW' });
    toFetch.push({ part: '63', subpart: 'AAAA' });
    toFetch.push({ part: '98', subpart: 'HH' });
    toFetch.push({ part: '62', subpart: 'OOO' });
  }

  const sic = (body.sicCode || '').toString().trim();
  const sicNum = parseInt(sic) || 0;
  if (sicNum === 4953) { toFetch.push({ part: '60', subpart: 'WWW' }); toFetch.push({ part: '63', subpart: 'AAAA' }); toFetch.push({ part: '62', subpart: 'OOO' }); toFetch.push({ part: '98', subpart: 'HH' }); }
  if (isMajor || capMMBtu > 100 || isLandfill) { toFetch.push({ part: '98', subpart: 'C' }); toFetch.push({ part: '98', subpart: 'A' }); }

  const unique = [];
  const seen = new Set();
  for (const t of toFetch) {
    const key = `${t.part}|${t.subpart||'null'}`;
    if (!seen.has(key)) { seen.add(key); unique.push(t); }
  }

  const fetched = [];
  for (const { part, subpart } of unique.slice(0, 8)) {
    try {
      let rows;
      if (subpart) {
        rows = await dbGet('regulations', { select: 'id,source,part,subpart,title,content,url', source: 'eq.federal', part: `eq.${part}`, subpart: `eq.${subpart}`, limit: 1 });
      } else {
        rows = await dbGet('regulations', { select: 'id,source,part,subpart,title,content,url', source: 'eq.kentucky', part: `ilike.*${part}*`, limit: 1 });
      }
      if (rows && rows.length > 0 && rows[0].content) fetched.push(rows[0]);
    } catch (e) {}
  }
  return fetched;
}

function buildControlCtx(devices) {
  if (!devices || devices.length === 0) return 'None installed.';
  return devices.map((d, i) =>
    `Device ${i+1}: ${d.type}${d.efficiency ? ` | ${d.efficiency}` : ''}${d.pollutants ? ` | Controls: ${d.pollutants}` : ''}`
  ).join('\n');
}

const TCEQ_FLOW_CHART_LOGIC = `
=====================================================================
TCEQ-STYLE FLOW CHART DECISION LOGIC
Follow this step-by-step for each regulation. Answer each question
in order. First NO answer determines the outcome.
=====================================================================

1. 40 CFR 60 SUBPART IIII — CI ENGINE NSPS
Q1: Is the engine a stationary compression ignition (CI/diesel) engine? NO→not subject
Q2: Did construction commence AFTER July 11, 2005? NO→not subject
Q3: Is displacement LESS THAN 30 L/cylinder? NO→not subject
EMERGENCY ENGINE:
  §60.4205 emission standards; §60.4207 ULSD <15 ppm; §60.4211(f) 100+50 hrs/yr limits;
  §60.4211(f)(3) non-resettable hour meter; §60.4214(b) no initial notification for emergency

2. 40 CFR 60 SUBPART JJJJ — SI ENGINE NSPS
Q1: Is it a stationary spark ignition (SI) engine? NO→not subject
Q2: Did construction commence AFTER June 12, 2006? NO→not subject
EMERGENCY SI ENGINES >25 HP: 100 hrs/yr maintenance + 50 hrs/yr non-emergency

3. 40 CFR 63 SUBPART ZZZZ — RICE NESHAP
Q1: Is it a reciprocating internal combustion engine? NO→not subject
MAJOR SOURCE: ALL sizes subject
AREA SOURCE: CI ≥300 HP or SI ≥500 HP: work practice standards; smaller: annual inspection only
Emergency ≤500 HP at area source: annual inspection ONLY

4. 40 CFR 60 SUBPART Db — INDUSTRIAL BOILER NSPS (>100 MMBtu/hr)
Q1: Is heat input capacity >100 MMBtu/hr? NO→use Subpart Dc
Q2: Construction commenced after June 19, 1984? NO→not subject
NATURAL GAS: NOx limits 0.20 lb/MMBtu (>300 MMBtu/hr), 0.30 (≤300); exempt from SO2/PM limits
§60.47b NOx CEMS; §60.48b monitoring; §60.49b recordkeeping

5. 40 CFR 60 SUBPART Dc — SMALL BOILER NSPS (10-100 MMBtu/hr)
Q1: Is heat input ≥10 MMBtu/hr AND ≤100 MMBtu/hr? NO→different subpart
Q2: Construction commenced after June 9, 1989? NO→not subject
NATURAL GAS/DISTILLATE OIL: exempt from SO2/PM limits; opacity 20%; notification required

6. LANDFILL (40 CFR 62 Subpart OOO / 40 CFR 63 Subpart AAAA)
Existing MSW landfill with design capacity ≥2.5 million Mg: Title V required
NMOC ≥34 Mg/yr: GCCS installation required

NSR/PSD FLOW CHART
Listed source: PTE ≥100 tpy → PSD; Unlisted: ≥250 tpy → PSD
Major modification: NOx/VOC/SO2 ≥40 tpy, PM10 ≥15 tpy, PM2.5 ≥10 tpy
`;

app.post('/check', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'API key not configured.' });
  const body = req.body;
  if (!body.equipmentCategory && !body.description) {
    return res.status(400).json({ error: 'Provide equipment type or description.' });
  }

  try {
    const regs = await searchRegulations(body, 35);
    const fullTextRegs = await fetchApplicableRegTexts(body);

    const fullTextContext = fullTextRegs.length > 0
      ? fullTextRegs.map(r => `===== FULL REGULATION TEXT: ${r.title} =====\nCFR: 40 CFR Part ${r.part}${r.subpart ? ' Subpart '+r.subpart : ''}\nURL: ${r.url||'N/A'}\n\n${(r.content||'').slice(0, 8000)}\n`).join('\n' + '='.repeat(60) + '\n')
      : '';

    const searchContext = regs.length > 0
      ? regs.filter(r => !fullTextRegs.find(f => f.id === r.id))
           .map(r => `=== ${r.title} ===\nSource: ${r.source === 'federal' ? `40 CFR Part ${r.part}${r.subpart ? ' Subpart '+r.subpart : ''}` : r.part}\nURL: ${r.url||'N/A'}\n${(r.content||'').slice(0,500)}\n`).join('\n---\n')
      : '';

    const regContext = [
      fullTextContext ? `FULL REGULATION TEXTS:\n${fullTextContext}` : '',
      searchContext ? `ADDITIONAL REGULATIONS:\n${searchContext}` : '',
      (!fullTextContext && !searchContext) ? 'No database results — use flow chart logic.' : ''
    ].filter(Boolean).join('\n\n');

    const controlCtx = buildControlCtx(body.controlDevices);
    const hasDevices = body.controlDevices && body.controlDevices.length > 0;
    const isLandfill = (body.equipmentCategory||'').toLowerCase().includes('landfill');
    const landfillCtx = isLandfill ? [
      body.landfillDesignCapacity ? `Landfill design capacity: ${body.landfillDesignCapacity}` : '',
      body.landfillNmocRate ? `NMOC emission rate: ${body.landfillNmocRate} Mg/yr` : '',
      body.landfillGccsInstalled ? `GCCS installed: ${body.landfillGccsInstalled}` : '',
      body.landfillWellCount ? `Number of extraction wells: ${body.landfillWellCount}` : '',
      body.landfillStatus ? `Landfill status: ${body.landfillStatus}` : '',
    ].filter(Boolean).join('\n') : '';

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
      landfillCtx ? `LANDFILL-SPECIFIC DETAILS:\n${landfillCtx}` : '',
      body.description ? `Additional info: ${body.description}` : ''
    ].filter(Boolean).join('\n');

    const prompt = `You are an expert Kentucky air quality permitting engineer at the Kentucky EEC Division for Air Quality.

RELEVANT REGULATIONS FROM DATABASE (${regs.length} retrieved):
${regContext}

SOURCE DETAILS:
${equipDetails}

${TCEQ_FLOW_CHART_LOGIC}

INSTRUCTIONS:
1. Use the flow chart logic to determine applicability for each regulation.
2. PARAGRAPH-LEVEL CITATIONS ARE REQUIRED — cite specific paragraphs, not just subparts.
3. Auto-determine new vs existing from construction date ${body.constructDate||'NOT PROVIDED'}.
4. CAM (40 CFR Part 64): evaluate only if control devices present. ${!hasDevices ? 'No control devices → CAM does not apply.' : ''}

Respond ONLY with valid JSON:
{
  "summary": "3-4 sentences specific to this source",
  "newExistingDetermination": "Per-regulation cutoff date analysis",
  "dataQuality": "complete|partial|insufficient",
  "missingInfo": [],
  "regulations": [
    {
      "id": "unique-id",
      "name": "e.g. 40 CFR 60 Subpart IIII",
      "fullName": "Full descriptive name",
      "category": "Federal NSPS|Federal NESHAP|Federal NSR/PSD|Federal Other|Kentucky State",
      "status": "applies|not-applies|needs-info",
      "badge": "Applies|Does not apply|More info needed",
      "newExisting": "New source|Existing source|N/A",
      "flowChartResult": "Q1: Yes. Q2: Yes. → SUBJECT",
      "reason": "2-3 sentences with specific thresholds",
      "cite": "§60.4200(a) — applicability; §60.4205(a) — emission standards; §60.4207 — ULSD fuel; §60.4211(f)(1)-(3) — hour limits; §60.4211(f)(3) — hour meter",
      "keyRequirements": ["Requirement 1", "Requirement 2"],
      "controlDeviceNotes": "How control devices affect this regulation",
      "url": "https://www.ecfr.gov/current/title-40/..."
    }
  ],
  "nsrPsd": {
    "psdStatus": "applies|not-applies|needs-info",
    "psdReason": "Flow chart result",
    "nonattainmentStatus": "applies|not-applies|needs-info",
    "nonattainmentReason": "Explanation",
    "minorNsrStatus": "applies|not-applies|needs-info",
    "minorNsrReason": "Explanation",
    "cite": "401 KAR 55:005, 401 KAR 55:010, 40 CFR 52.21"
  },
  "permitType": {
    "determination": "Registration (401 KAR 52:070)|Title V (401 KAR 52:020)|No permit required|Needs more info",
    "reason": "Explanation with thresholds"
  },
  "camApplicability": {
    "status": "applies|not-applies|needs-info",
    "devices": [],
    "reason": "Overall CAM conclusion"
  }
}
Order: applies first, needs-info second, not-applies last.`;

    const gemResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`,
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
    parsed.regulationsSearched = regs.length;
    parsed.fullTextRegsUsed = fullTextRegs.length;
    parsed.fullTextRegNames = fullTextRegs.map(r => `40 CFR Part ${r.part}${r.subpart ? ' Subpart '+r.subpart : ''}`);

    try {
      await dbInsert('determinations', {
        equipment_type: body.equipmentCategory || body.description || 'Unknown',
        equipment_details: body,
        results: parsed,
        created_at: new Date().toISOString()
      });
    } catch (e) { console.log('History save:', e.message); }

    res.json(parsed);
  } catch (err) {
    console.error('Check error:', err.message);
    res.status(500).json({ error: 'Server error: ' + err.message });
  }
});

app.post('/draft', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'API key not configured.' });
  const { determination, equipmentDetails } = req.body;
  if (!determination) return res.status(400).json({ error: 'Provide determination.' });

  try {
    const applicable = (determination.regulations || [])
      .filter(r => r.status === 'applies')
      .map(r => `REG: ${r.name}\nFULL NAME: ${r.fullName}\nCITATIONS: ${r.cite}\nREQUIREMENTS: ${(r.keyRequirements||[]).join(' | ')}`)
      .join('\n---\n');

    const equip = `Equipment: ${(equipmentDetails||{}).equipmentCategory||''} ${(equipmentDetails||{}).equipmentType||''}
Fuel: ${(equipmentDetails||{}).fuelType||''}, Capacity: ${(equipmentDetails||{}).capacity||''}
Construction: ${(equipmentDetails||{}).constructDate||''}, Source class: ${(equipmentDetails||{}).sourceClass||''}`;

    const prompt = `You are an expert Kentucky EEC permit engineer. Generate draft Section B permit language in DEP7007V format. Use "the owner/operator shall" language. Include exact paragraph citations.

EMISSION UNIT: ${equip}
APPLICABLE REGULATIONS: ${applicable}

Respond ONLY with valid JSON:
{
  "emissionUnit": "Description",
  "sections": {
    "V1": { "title": "Emission and Operating Limitations", "requirements": [{"id":"V.1.1","requirement":"The owner/operator shall...","citation":"40 CFR xx.xxx(x)","regulation":"Reg name"}] },
    "V2": { "title": "Monitoring Requirements", "requirements": [] },
    "V3": { "title": "Recordkeeping Requirements", "requirements": [] },
    "V4": { "title": "Reporting Requirements", "requirements": [] }
  },
  "notes": "Special conditions"
}`;

    const gemResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`,
      { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.1,maxOutputTokens:8192,responseMimeType:'application/json'} }) }
    );
    const gd = await gemResp.json();
    if (!gemResp.ok) return res.status(500).json({ error: 'Gemini error: '+(gd?.error?.message||'Unknown') });
    const raw = gd?.candidates?.[0]?.content?.parts?.[0]?.text||'';
    const clean = raw.replace(/```json/g,'').replace(/```/g,'').trim();
    const s=clean.indexOf('{'), e=clean.lastIndexOf('}');
    if (s===-1) return res.status(500).json({ error: 'No JSON' });
    res.json(JSON.parse(clean.slice(s,e+1)));
  } catch(err) {
    res.status(500).json({ error: 'Server error: '+err.message });
  }
});

app.post('/chat', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'API key not configured.' });
  const { messages, extractedInfo } = req.body;
  if (!messages||!messages.length) return res.status(400).json({ error: 'Provide messages.' });

  try {
    const history = messages.map(m => `${m.role==='user'?'Engineer':'Assistant'}: ${m.content}`).join('\n');
    const prompt = `You are an expert Kentucky EEC Division for Air Quality permit engineer.
Current extracted info: ${JSON.stringify(extractedInfo||{})}
CONVERSATION: ${history}

Extract equipment info, ask follow-up questions one at a time, and determine applicable regulations when ready.

Respond ONLY with JSON:
{
  "message": "Your response",
  "extractedInfo": { "equipmentCategory": "", "equipmentType": "", "fuelType": "", "capacity": "", "constructDate": "", "sourceClass": "", "pollutantClass": "", "sicCode": "", "controlDevices": [] },
  "readyForDetermination": false,
  "missingInfo": []
}`;

    const gemResp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`,
      { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.3,maxOutputTokens:4096,responseMimeType:'application/json'} }) }
    );
    const gd = await gemResp.json();
    if (!gemResp.ok) return res.status(500).json({ error: 'Gemini error: '+(gd?.error?.message||'Unknown') });
    const raw = gd?.candidates?.[0]?.content?.parts?.[0]?.text||'';
    const clean = raw.replace(/```json/g,'').replace(/```/g,'').trim();
    const s=clean.indexOf('{'), e=clean.lastIndexOf('}');
    if (s===-1) return res.json({ message: raw, extractedInfo: extractedInfo||{}, readyForDetermination:false, missingInfo:[] });
    res.json(JSON.parse(clean.slice(s,e+1)));
  } catch(err) {
    res.status(500).json({ error: 'Server error: '+err.message });
  }
});

// ── PERMIT DRAFT GENERATOR ────────────────────────────────────────────────
app.post('/permit', async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'API key not configured.' });
  const { facility, units } = req.body;
  if (!facility || !units || !units.length) {
    return res.status(400).json({ error: 'Provide facility info and at least one emission unit.' });
  }

  try {
    const processedUnits = [];

    for (const unit of units) {
      // ── STEP 1: Try template first (real EEC language, no Gemini needed) ──
      const template = getPermitTemplate(unit);

      if (template) {
        console.log(`Template match found for unit: ${unit.description || unit.equipmentCategory}`);
        processedUnits.push({
          ...unit,
          applicableRegs: template.applicableRegs,
          stateOriginReqs: template.stateOriginReqs || 'None',
          precludedRegs: template.precludedRegs || 'None',
          nonApplicableRegs: template.nonApplicableRegs || 'None',
          operatingLimitations: template.operatingLimitations,
          emissionLimitations: template.emissionLimitations,
          testingRequirements: template.testingRequirements,
          monitoringRequirements: template.monitoringRequirements,
          recordkeepingRequirements: template.recordkeepingRequirements,
          reportingRequirements: template.reportingRequirements,
          controlDevices: unit.controlDevices || [],
          epNumber: unit.epNumber || String(processedUnits.length+1).padStart(2,'0'),
          templateUsed: true
        });
        continue;
      }

      // ── STEP 2: Fall back to Gemini for equipment types not yet templated ──
      if (!unit.determination) {
        processedUnits.push({ ...unit, epNumber: unit.epNumber || String(processedUnits.length+1).padStart(2,'0') });
        continue;
      }

      console.log(`No template for unit: ${unit.description} — using Gemini`);

      const applicable = (unit.determination.regulations || [])
        .filter(r => r.status === 'applies')
        .map(r => `REG: ${r.name}\nCITATIONS: ${r.cite}\nREQS: ${(r.keyRequirements||[]).join(' | ')}`)
        .join('\n---\n');

      const equip = `Equipment: ${unit.equipmentCategory||''} ${unit.equipmentType||''}
Fuel: ${unit.fuelType||''}, Capacity: ${unit.capacity||''}
Construction: ${unit.constructDate||''}, Source class: ${unit.sourceClass||''}
Control devices: ${(unit.controlDevices||[]).map(d=>d.type).join(', ')||'None'}`;

      const prompt = `You are an expert Kentucky EEC Division for Air Quality permit engineer.
Generate Section B permit language matching actual EEC issued permits.

EMISSION UNIT: ${unit.description || unit.equipmentCategory}
${equip}

APPLICABLE REGULATIONS:
${applicable}

Use "The owner/operator shall" for every condition.
End each condition with citation in brackets: [40 CFR 60.4205(a)]
Include specific numeric limits, hour limits, fuel specs, monitoring frequencies, recordkeeping periods, and reporting deadlines.

Respond ONLY with valid JSON:
{
  "applicableRegs": ["Full regulation names"],
  "stateOriginReqs": "401 KAR citations or None",
  "precludedRegs": "Precluded regulations or None",
  "nonApplicableRegs": "Non-applicable regulations or None",
  "operatingLimitations": [{"requirement": "full text with citation", "citation": "40 CFR x.xxxx(x)"}],
  "emissionLimitations": [{"requirement": "full text", "citation": "cite"}],
  "testingRequirements": [{"requirement": "full text", "citation": "cite"}],
  "monitoringRequirements": [{"requirement": "full text", "citation": "cite"}],
  "recordkeepingRequirements": [{"requirement": "full text", "citation": "cite"}],
  "reportingRequirements": [{"requirement": "full text", "citation": "cite"}],
  "camApplies": false,
  "camPollutant": "",
  "camParameter": ""
}`;

      try {
        const gemResp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${GEMINI_API_KEY}`,
          { method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.1,maxOutputTokens:4096,responseMimeType:'application/json'} }) }
        );
        const gd = await gemResp.json();
        const raw = gd?.candidates?.[0]?.content?.parts?.[0]?.text||'{}';
        const clean = raw.replace(/```json/g,'').replace(/```/g,'').trim();
        const s=clean.indexOf('{'), e=clean.lastIndexOf('}');
        const parsed = s>=0 ? JSON.parse(clean.slice(s,e+1)) : {};
        processedUnits.push({
          ...unit,
          ...parsed,
          controlDevices: unit.controlDevices || [],
          epNumber: unit.epNumber || String(processedUnits.length+1).padStart(2,'0')
        });
      } catch(e) {
        console.log('Gemini permit error:', e.message);
        processedUnits.push({ ...unit, epNumber: unit.epNumber || String(processedUnits.length+1).padStart(2,'0') });
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    res.json({
      success: true,
      facility,
      units: processedUnits,
      message: `Permit data ready for ${processedUnits.length} emission unit(s). Download the Word document.`
    });

  } catch(err) {
    console.error('Permit error:', err.message);
    res.status(500).json({ error: 'Server error: '+err.message });
  }
});

// ── PERMIT DOCX DOWNLOAD ──────────────────────────────────────────────────
app.post('/permit-docx', async (req, res) => {
  const { facility, units } = req.body;
  if (!facility || !units) return res.status(400).json({ error: 'Provide facility and units.' });

  try {
    const {
      Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
      AlignmentType, WidthType, ShadingType, BorderStyle, UnderlineType
    } = require('docx');

    function bold(text, size=20) { return new TextRun({ text, bold:true, size }); }
    function run(text, size=20, opts={}) { return new TextRun({ text, size, ...opts }); }
    function spacer() { return new Paragraph({ text:'', spacing:{ after:120 } }); }
    function hr() { return new Paragraph({ text:'', border:{ bottom:{ color:'000000', size:6, style:BorderStyle.SINGLE } }, spacing:{ after:120 } }); }
    function h1(text) { return new Paragraph({ children:[new TextRun({ text, bold:true, size:22, underline:{ type:UnderlineType.SINGLE } })], spacing:{ before:240, after:120 } }); }
    function h2(text) { return new Paragraph({ children:[new TextRun({ text, bold:true, size:20 })], spacing:{ before:200, after:100 } }); }
    function np(text, indent=0) { return new Paragraph({ children:[run(text)], spacing:{ after:100 }, indent: indent ? { left:indent } : undefined }); }
    function li(letter, text, indent=1080) { return new Paragraph({ children:[run(`${letter}.\t${text}`)], indent:{ left:indent, hanging:360 }, spacing:{ after:80 } }); }
    function num(n, text, indent=720) { return new Paragraph({ children:[run(`${n}.\t${text}`)], indent:{ left:indent, hanging:360 }, spacing:{ after:100 } }); }

    function cell(text, opts={}) {
      const { b=false, bg='FFFFFF', width=2000, center=false, size=18 } = opts;
      return new TableCell({
        children:[new Paragraph({ children:[new TextRun({ text:String(text||''), bold:b, size, color:'000000' })], alignment: center ? AlignmentType.CENTER : AlignmentType.LEFT, spacing:{ before:60, after:60 } })],
        shading:{ type:ShadingType.CLEAR, fill:bg },
        margins:{ top:60, bottom:60, left:100, right:100 },
        width:{ size:width, type:WidthType.DXA }
      });
    }
    function hcell(text, width=2000) { return cell(text, { b:true, bg:'1F3864', width }); }

    const children = [];

    // Cover page
    children.push(new Paragraph({ children:[bold('KENTUCKY ENERGY AND ENVIRONMENT CABINET', 22)], alignment:AlignmentType.CENTER, spacing:{ after:80 } }));
    children.push(new Paragraph({ children:[bold('Department for Environmental Protection', 20)], alignment:AlignmentType.CENTER, spacing:{ after:80 } }));
    children.push(new Paragraph({ children:[bold('Division for Air Quality', 20)], alignment:AlignmentType.CENTER, spacing:{ after:240 } }));
    children.push(hr());
    children.push(new Paragraph({ children:[bold('TITLE V OPERATING PERMIT', 28)], alignment:AlignmentType.CENTER, spacing:{ before:240, after:80 } }));
    children.push(new Paragraph({ children:[bold('401 KAR 52:020', 22)], alignment:AlignmentType.CENTER, spacing:{ after:240 } }));
    children.push(hr());
    children.push(spacer());

    const fields = [
      ['PERMIT NUMBER:', facility.permitNumber||'V-XX-XXX'],
      ['PERMITTEE:', facility.permitteeName||''],
      ['SOURCE NAME:', facility.sourceName||''],
      ['ADDRESS:', facility.address||''],
      ['COUNTY:', facility.county||''],
      ['SIC CODE:', facility.sicCode||''],
      ['SOURCE ID:', facility.sourceId||''],
      ['AGENCY INTEREST:', facility.agencyInterest||''],
      ['ACTIVITY:', facility.activityNumber||''],
      ['RESPONSIBLE OFFICIAL:', facility.responsibleOfficial||''],
      ['REGIONAL OFFICE:', facility.regionalOffice||''],
      ['EFFECTIVE DATE:', facility.effectiveDate||'___/___/______'],
      ['EXPIRATION DATE:', facility.expirationDate||'___/___/______'],
    ];

    children.push(new Table({
      width:{ size:9360, type:WidthType.DXA },
      borders:{ top:{ style:BorderStyle.NONE }, bottom:{ style:BorderStyle.NONE }, left:{ style:BorderStyle.NONE }, right:{ style:BorderStyle.NONE }, insideH:{ style:BorderStyle.NONE }, insideV:{ style:BorderStyle.NONE } },
      rows: fields.map(([label, val]) => new TableRow({ children:[
        new TableCell({ children:[new Paragraph({ children:[bold(label)], spacing:{ before:60, after:60 } })], width:{ size:2880, type:WidthType.DXA }, borders:{ top:{ style:BorderStyle.NONE }, bottom:{ style:BorderStyle.NONE }, left:{ style:BorderStyle.NONE }, right:{ style:BorderStyle.NONE } } }),
        new TableCell({ children:[new Paragraph({ children:[run(val)], spacing:{ before:60, after:60 } })], width:{ size:6480, type:WidthType.DXA }, borders:{ top:{ style:BorderStyle.NONE }, bottom:{ style:BorderStyle.NONE }, left:{ style:BorderStyle.NONE }, right:{ style:BorderStyle.NONE } } })
      ]}))
    }));

    children.push(spacer()); children.push(hr()); children.push(spacer());
    children.push(new Paragraph({ children:[bold('SIGNATURE:', 20)], spacing:{ after:480 } }));
    children.push(np('__________________________________________________ \t\t Date: _______________'));
    children.push(np(facility.reviewerName||'Reviewer Name'));
    children.push(np('Permit Review Branch, Division for Air Quality'));
    children.push(spacer());
    children.push(np('__________________________________________________ \t\t Date: _______________'));
    children.push(np(facility.supervisorName||'Section Supervisor'));
    children.push(np('Permit Review Branch, Division for Air Quality'));
    children.push(spacer());

    // TOC
    children.push(h1('TABLE OF CONTENTS'));
    const toc = [['A','Permit Authorization'],['B','Emission Points, Emission Units, Applicable Regulations, and Operating Conditions'],['C','Insignificant Activities'],['D','Source Emission Limitations and Testing Requirements'],['E','Source Control Equipment Requirements'],['F','Monitoring, Recordkeeping, and Reporting Requirements'],['G','General Provisions']];
    children.push(new Table({ width:{ size:9360, type:WidthType.DXA }, rows:[
      new TableRow({ children:[hcell('SECTION',1080),hcell('DESCRIPTION',7200),hcell('PAGE',1080)] }),
      ...toc.map(([s,d]) => new TableRow({ children:[cell(s,{width:1080,center:true}),cell(d,{width:7200}),cell('—',{width:1080,center:true})] }))
    ]}));
    children.push(spacer());

    // Section A
    children.push(hr());
    children.push(h1('SECTION A - PERMIT AUTHORIZATION'));
    children.push(np('Pursuant to a duly submitted application the Kentucky Energy and Environment Cabinet (Cabinet) hereby authorizes the operation of the equipment described herein in accordance with the terms and conditions of this permit. This permit was issued under the provisions of Kentucky Revised Statutes (KRS) Chapter 224 and regulations promulgated pursuant thereto.'));
    children.push(spacer());
    children.push(np('The permittee shall not construct, reconstruct, or modify any affected facilities without first submitting a complete application and receiving a permit for the planned activity from the permitting authority, except as provided in this permit or in 401 KAR 52:020, Title V Permits.'));
    children.push(spacer());
    children.push(np('Issuance of this permit does not relieve the permittee from the responsibility of obtaining any other permits, licenses, or approvals required by the Cabinet or any other federal, state, or local agency.'));

    // Section B
    children.push(hr());
    children.push(h1('SECTION B - EMISSION POINTS, EMISSION UNITS, APPLICABLE REGULATIONS, AND OPERATING CONDITIONS'));
    children.push(spacer());

    units.forEach((unit, idx) => {
      const unum = String(idx+1).padStart(2,'0');
      const ep = unit.epNumber || unum;
      children.push(new Paragraph({ children:[bold(`Emission Unit ${unum} (${ep})  `,20),run(unit.description||'',20)], spacing:{ before:240, after:100 } }));
      children.push(np(`Description:\n${unit.description||''}\nMaximum continuous rating: ${unit.capacity||''}\nConstruction commenced: ${unit.constructDate||''}`));
      children.push(spacer());
      children.push(new Paragraph({ children:[bold('APPLICABLE REGULATIONS: ',20),run((unit.applicableRegs||[]).join(';\n'),20)], spacing:{ after:80 } }));
      children.push(new Paragraph({ children:[bold('STATE-ORIGIN REQUIREMENTS: ',20),run(unit.stateOriginReqs||'None',20)], spacing:{ after:80 } }));
      children.push(new Paragraph({ children:[bold('PRECLUDED REGULATIONS: ',20),run(unit.precludedRegs||'None',20)], spacing:{ after:80 } }));
      children.push(new Paragraph({ children:[bold('NON-APPLICABLE REGULATIONS: ',20),run(unit.nonApplicableRegs||'None',20)], spacing:{ after:80 } }));
      children.push(spacer());

      const sections = [
        ['1.\tOperating Limitations:', unit.operatingLimitations],
        ['2.\tEmission Limitations:', unit.emissionLimitations],
        ['3.\tTesting Requirements:', unit.testingRequirements],
        ['4.\tSpecific Monitoring Requirements:', unit.monitoringRequirements],
        ['5.\tSpecific Recordkeeping Requirements:', unit.recordkeepingRequirements],
        ['6.\tSpecific Reporting Requirements:', unit.reportingRequirements],
      ];

      sections.forEach(([title, reqs]) => {
        children.push(h2(title));
        if (reqs && reqs.length) {
          reqs.forEach((req, i) => {
            const reqText = req.requirement || req;
            // Split on \n\t for sub-items
            const lines = reqText.split('\n');
            lines.forEach((line, lineIdx) => {
              if (lineIdx === 0) {
                children.push(new Paragraph({ children:[run(`${String.fromCharCode(97+i)}.\t${line}`,20)], indent:{ left:720, hanging:360 }, spacing:{ after:40 } }));
              } else if (line.trim()) {
                children.push(new Paragraph({ children:[run(line,20)], indent:{ left:1080 }, spacing:{ after:40 } }));
              }
            });
            if (req.citation) {
              children.push(new Paragraph({ children:[run(`[${req.citation}]`,18,{ italics:true, color:'444444' })], indent:{ left:1080 }, spacing:{ after:80 } }));
            }
          });
        } else {
          children.push(np('None.', 720));
        }
      });

      children.push(h2('7.\tSpecific Control Equipment Operating Conditions:'));
      if (unit.controlDevices && unit.controlDevices.length) {
        unit.controlDevices.forEach((d,i) => {
          children.push(new Paragraph({ children:[run(`${String.fromCharCode(97+i)}.\t${d.type||d} shall be operated and maintained per manufacturer specifications at all times when the associated emission unit is in operation.`,20)], indent:{ left:720, hanging:360 }, spacing:{ after:80 } }));
        });
      } else {
        children.push(np('N/A — No add-on control devices installed.', 720));
      }
      children.push(hr());
    });

    // Section C
    children.push(h1('SECTION C - INSIGNIFICANT ACTIVITIES'));
    children.push(np('The following listed activities have been determined to be insignificant activities for this source pursuant to 401 KAR 52:020, Section 6.'));
    children.push(np('(None identified — permittee to provide list with application)', 360));

    // Section D
    children.push(hr());
    children.push(h1('SECTION D - SOURCE EMISSION LIMITATIONS AND TESTING REQUIREMENTS'));
    children.push(num(1,'As required by 401 KAR 52:020, Section 26; compliance with annual emissions limitations shall be based on emissions for any twelve (12) consecutive months.'));
    children.push(num(2,'Facility-wide potential to emit shall comply with applicable major source thresholds as specified in Section B applicable requirements.'));

    // Section E
    children.push(hr());
    children.push(h1('SECTION E - SOURCE CONTROL EQUIPMENT REQUIREMENTS'));
    children.push(np('Pursuant to 401 KAR 50:055, Section 2(5), at all times, including periods of startup, shutdown and malfunction, owners and operators shall, to the extent practicable, maintain and operate any affected facility including associated air pollution control equipment in a manner consistent with good air pollution control practice for minimizing emissions.'));

    // Section F
    children.push(hr());
    children.push(h1('SECTION F - MONITORING, RECORDKEEPING, AND REPORTING REQUIREMENTS'));
    children.push(num(1,'The permittee shall compile records of required monitoring information including: date, time, and place of sampling; analyses performance dates; company performing analyses; analytical techniques; analyses results; and operating conditions during sampling. [401 KAR 52:020, Section 26]'));
    children.push(num(2,'Records of all required monitoring data shall be retained for a period of five (5) years and made available for inspection upon request. [401 KAR 52:020, Section 26]'));
    children.push(num(3,'The permittee shall allow authorized representatives of the Cabinet to enter premises, access and copy records, and sample or monitor substances during reasonable times. [401 KAR 52:020, Section 3(1)h]'));
    children.push(num(4,'Semi-annual summary reports are due by January 30th and July 30th of each year. All reports shall be certified by a responsible official pursuant to 401 KAR 52:020, Section 23. All deviations from permit requirements shall be clearly identified. [401 KAR 52:020, Section 26]'));
    children.push(num(5,'The permittee shall promptly report deviations from permit requirements. HAP/toxic emissions exceeding limits for more than one hour shall be reported within 24 hours. Other regulated pollutant emissions exceeding limits for more than two hours shall be reported within 48 hours.'));
    children.push(num(6,'Annual compliance certification (DEP 7007CC) shall be submitted by January 30th each year to the Division for Air Quality Regional Office and U.S. EPA Region 4. [401 KAR 52:020, Section 21]'));

    // Section G
    children.push(hr());
    children.push(h1('SECTION G - GENERAL PROVISIONS'));
    children.push(num(1,'General Compliance Requirements'));
    children.push(li('a','The permittee shall comply with all conditions of this permit. Noncompliance is grounds for enforcement action including permit termination, revocation, or denial. [401 KAR 52:020, Section 3(1)(b)]'));
    children.push(li('b','This permit is not transferable. Future owners shall obtain a new permit. [401 KAR 52:020, Section 12]'));
    children.push(li('c','This permit shall remain in effect for five (5) years. A renewal application must be submitted at least six (6) months prior to expiration. [401 KAR 52:020, Section 12]'));
    children.push(li('d','This permit does not convey property rights or exclusive privileges. [401 KAR 52:020, Section 1a-9]'));
    children.push(num(2,'Emergency Provisions'));
    children.push(li('a','An emergency constitutes an affirmative defense to noncompliance if the permittee demonstrates: (1) an emergency occurred and the cause is identified; (2) the facility was properly operated; (3) reasonable steps were taken to minimize excess emissions; and (4) the Division was notified promptly. [401 KAR 52:020, Section 24(1)]'));
    children.push(num(3,'Ozone Depleting Substances'));
    children.push(li('a','The permittee shall comply with 40 CFR 82, Subpart F standards for refrigerant recycling and emissions reduction. Persons opening appliances shall comply with 40 CFR 82.156. Equipment shall meet 40 CFR 82.158. Technicians shall be certified per 40 CFR 82.161.'));
    children.push(num(4,'Risk Management Provisions'));
    children.push(li('a','The permittee shall comply with all applicable requirements of 401 KAR Chapter 68, Chemical Accident Prevention (40 CFR Part 68). If required, a Risk Management Plan shall be submitted to U.S. EPA.'));

    const doc = new Document({
      sections:[{
        properties:{ page:{ size:{ width:12240, height:15840 }, margin:{ top:1080, bottom:1080, left:1260, right:1260 } } },
        children
      }]
    });

    const buf = await Packer.toBuffer(doc);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${(facility.permitNumber||'draft').replace(/[^a-zA-Z0-9-]/g,'_')}_Draft_Permit.docx"`,
      'Content-Length': buf.length
    });
    res.end(buf);

  } catch(err) {
    console.error('DOCX error:', err.message);
    res.status(500).json({ error: 'DOCX error: '+err.message });
  }
});

app.listen(PORT, () => {
  console.log(`EEC AI Assistant API v15.3 running on port ${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL ? 'SET' : 'MISSING'} | Gemini: ${GEMINI_API_KEY ? 'SET' : 'MISSING'}`);
});
