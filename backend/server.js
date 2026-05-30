const express = require('express');
const cors = require('cors');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(cors());

const SUMBLE_API_KEY = process.env.SUMBLE_API_KEY;
const HUBSPOT_SERVICE_KEY = process.env.HUBSPOT_SERVICE_KEY;

const SUMBLE_BASE = 'https://api.sumble.com';

// --- endpoint paths (verified against the live Sumble API) ---
const SUMBLE_PEOPLE_FIND_PATH = '/v6/people/find';        // POST, organization.domain + filters
const SUMBLE_ORG_MATCH_PATH = '/v6/organizations/match';  // POST, resolve domain -> org id
// Brief is GET /v6/organizations/{orgId}/intelligence-brief (templated in fetchBrief)

// SDR people filter (the hero query). Mirrors the rep's Sumble web filter.
const SDR_JOB_FUNCTIONS = ['Sales Development Representative'];
const SDR_JOB_LEVELS = ['Individual Contributor', 'Senior', 'Lead', 'Principal'];

// Cache TTLs
const PEOPLE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d — matches Sumble's ~monthly refresh
const BRIEF_TTL_MS = Infinity;                  // brief never auto-expires; refresh is manual
const ORG_TTL_MS = 30 * 24 * 60 * 60 * 1000;    // 30d (org id rarely changes)

console.log(`[STARTUP] Sumble backend at ${new Date().toISOString()}`);
console.log(`[STARTUP] Sumble key: ${!!SUMBLE_API_KEY} | HubSpot key: ${!!HUBSPOT_SERVICE_KEY}`);

const sumbleHeaders = () => ({
  Authorization: `Bearer ${SUMBLE_API_KEY}`,
  'Content-Type': 'application/json',
});
const hubspotHeaders = () => ({
  Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}`,
  'Content-Type': 'application/json',
});

// ---- HubSpot: read the Sumble identity + synced count off the company ----
async function getCompany(companyId) {
  const props = [
    'name', 'domain', 'website',
    'sumble_profile_url', 'sumble_organization_slug', 'sumble_organization_name',
    'sumble_sdr_ic_people_count', 'sumble_sdr_ic_people_url',
  ].join(',');
  const resp = await fetch(
    `https://api.hubapi.com/crm/v3/objects/companies/${companyId}?properties=${props}`,
    { headers: hubspotHeaders() }
  );
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    const err = new Error(e.message || `Failed to read company ${companyId}`);
    err.status = resp.status;
    throw err;
  }
  return (await resp.json()).properties || {};
}

// Derive a clean domain from a company's domain/website property.
function cleanDomain(company) {
  let d = company.domain || company.website || '';
  d = d.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim().toLowerCase();
  return d || null;
}

// org cache key: prefer the slug, else domain.
function orgKeyFor(company) {
  return company.sumble_organization_slug || cleanDomain(company) || null;
}

// ---- Sumble: SDR people query ----
async function fetchSdrPeople(domain) {
  const resp = await fetch(`${SUMBLE_BASE}${SUMBLE_PEOPLE_FIND_PATH}`, {
    method: 'POST',
    headers: sumbleHeaders(),
    body: JSON.stringify({
      organization: { domain },
      filters: { job_functions: SDR_JOB_FUNCTIONS, job_levels: SDR_JOB_LEVELS },
      limit: 10,
    }),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    const err = new Error(e.message || `Sumble people/find failed (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  // Defensive parsing — exact field names to be confirmed against live API.
  const people = (data.people || data.results || data.data || []).map((person) => ({
    id: person.id,
    name: person.name || person.full_name || null,
    title: person.job_title || person.title || null,
    jobLevel: person.job_level || null,
    jobFunction: person.job_function || null,
    location: person.location || person.country || null,
    linkedinUrl: person.linkedin_url || null,
    url: person.url || null,
    startDate: person.start_date || null, // for tenure in role
    leadScore: person.sumble_lead_score ?? person.lead_score ?? null, // absent in practice
  }));
  const totalCount =
    data.people_count ?? data.total ?? data.total_count ?? people.length;
  return { people, totalCount };
}

// ---- Sumble: resolve org id (needed for the brief). 1 credit, cached 30d. ----
// Match takes `url` (not `domain`); the id lives at results[0].match.id.
async function resolveOrgId(domain) {
  const resp = await fetch(`${SUMBLE_BASE}${SUMBLE_ORG_MATCH_PATH}`, {
    method: 'POST',
    headers: sumbleHeaders(),
    body: JSON.stringify({ organizations: [{ url: domain }] }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const first = (data.results || [])[0];
  return first?.match?.id ?? first?.id ?? null;
}

// ---- Sumble: intelligence brief — single, NON-blocking attempt ----
// Sumble returns 202 while generating (free); we surface that as `pending` and
// let the card poll, rather than holding the HTTP request open (which would
// risk HubSpot's fetch timeout). Pending briefs are NOT cached.
async function fetchBrief(orgId) {
  const resp = await fetch(`${SUMBLE_BASE}/v6/organizations/${orgId}/intelligence-brief`, {
    method: 'GET',
    headers: sumbleHeaders(),
  });
  if (resp.status === 202) {
    const retryAfter = parseInt(resp.headers.get('retry-after') || '20', 10);
    return { status: 'pending', retryAfter: Number.isNaN(retryAfter) ? 20 : retryAfter, markdown: '', sumbleUrl: null };
  }
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    const err = new Error(e.message || `Sumble brief failed (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  return {
    status: 'ready',
    markdown: data.body || '',
    sumbleUrl: data.sumble_url || null,
  };
}

// Build the filtered+sorted Sumble web deep-link for SDR people.
function sdrDeepLink(company) {
  if (company.sumble_sdr_ic_people_url) return company.sumble_sdr_ic_people_url;
  const base = company.sumble_profile_url;
  if (!base) return null;
  const filter = {
    operator: 'AND',
    children: [
      { operator: 'OR', fields: { job_function: { include: SDR_JOB_FUNCTIONS } }, children: [] },
      { operator: 'OR', fields: { job_level: { include: SDR_JOB_LEVELS } }, children: [] },
    ],
  };
  const as = encodeURIComponent(JSON.stringify(filter));
  return `${base.replace(/\/$/, '')}/people?as=${as}&sort=Sumble+Lead+Score&desc=1`;
}

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// Core: assemble the enrichment payload (cached). section=people|brief|all.
// cachedOnly=true (the default for auto-load) NEVER makes a paid Sumble call:
// it returns cached data or a `*_not_loaded` status. A paid call happens only
// when the card explicitly passes cachedOnly=false (a deliberate button click)
// or force=true (Refresh). This is the credit safeguard.
async function buildEnrichment(companyId, { force = false, want = 'all', cachedOnly = true } = {}) {
  const company = await getCompany(companyId);
  const domain = cleanDomain(company);
  const orgKey = orgKeyFor(company);
  const result = {
    companyId,
    domain,
    sumbleProfileUrl: company.sumble_profile_url || null,
    sumbleOrgName: company.sumble_organization_name || company.name || null,
    syncedSdrIcCount: company.sumble_sdr_ic_people_count
      ? parseInt(company.sumble_sdr_ic_people_count, 10)
      : null,
    sdrDeepLinkUrl: sdrDeepLink(company),
  };

  if (!domain && !orgKey) {
    result.error = 'No domain or Sumble slug on this company to look up.';
    return result;
  }

  // ----- People -----
  if (want === 'all' || want === 'people') {
    let people = force ? null : await db.getCached(orgKey, 'people', PEOPLE_TTL_MS);
    if (people) {
      result.peopleStatus = 'cached';
    } else if (cachedOnly && !force) {
      result.peopleStatus = 'not_loaded'; // gated — no paid call
    } else if (!SUMBLE_API_KEY) {
      result.peopleError = 'SUMBLE_API_KEY not configured on backend.';
    } else if (!domain) {
      result.peopleError = 'No domain to query Sumble people.';
    } else {
      try {
        people = await fetchSdrPeople(domain);
        await db.setCached(orgKey, 'people', people);
        result.peopleStatus = 'loaded';
      } catch (err) {
        result.peopleError = err.message;
      }
    }
    if (people) {
      result.sdrPeople = people.people;
      result.sdrLiveCount = people.totalCount;
    }
  }

  // ----- Brief -----
  if (want === 'all' || want === 'brief') {
    let brief = force ? null : await db.getCached(orgKey, 'brief', BRIEF_TTL_MS);
    if (brief) {
      result.briefStatus = 'ready';
    } else if (cachedOnly && !force) {
      result.briefStatus = 'not_loaded'; // gated — no paid call (incl. org match)
    } else if (!SUMBLE_API_KEY) {
      result.briefError = 'SUMBLE_API_KEY not configured on backend.';
    } else if (!domain) {
      result.briefError = 'No domain to resolve Sumble org for the brief.';
    } else {
      try {
        let orgId = await db.getCached(orgKey, 'orgId', ORG_TTL_MS);
        if (!orgId) {
          orgId = await resolveOrgId(domain);
          if (orgId) await db.setCached(orgKey, 'orgId', orgId);
        }
        if (!orgId) {
          result.briefError = 'Could not resolve a Sumble organization id.';
        } else {
          brief = await fetchBrief(orgId);
          if (brief.status === 'ready') {
            brief.cachedAt = new Date().toISOString(); // for "generated X ago" display
            await db.setCached(orgKey, 'brief', brief);
          }
          result.briefStatus = brief.status;
          result.briefRetryAfter = brief.retryAfter || null;
        }
      } catch (err) {
        result.briefError = err.message;
      }
    }
    if (brief) {
      result.brief = brief.markdown;
      result.briefSumbleUrl = brief.sumbleUrl || company.sumble_profile_url || null;
      result.briefCachedAt = brief.cachedAt || null;
    }
  }

  return result;
}

app.post('/api/enrichment', async (req, res) => {
  try {
    const { companyId, want, cachedOnly } = req.body;
    if (!companyId) return res.status(400).json({ status: 'error', message: 'Missing companyId' });
    // Default cachedOnly=true so auto-load never spends credits; a deliberate
    // button click sends cachedOnly:false to make the paid call.
    const data = await buildEnrichment(companyId, {
      force: false,
      want: want || 'all',
      cachedOnly: cachedOnly !== false,
    });
    res.json({ status: 'success', ...data });
  } catch (err) {
    console.error('[ENRICHMENT] error:', err.message);
    res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const { companyId, want } = req.body;
    if (!companyId) return res.status(400).json({ status: 'error', message: 'Missing companyId' });
    const data = await buildEnrichment(companyId, { force: true, want: want || 'all' });
    res.json({ status: 'success', ...data });
  } catch (err) {
    console.error('[REFRESH] error:', err.message);
    res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
});

const PORT = process.env.PORT || 3001;
db.init()
  .catch((err) => console.error('[STARTUP] db.init failed (continuing):', err.message))
  .finally(() => {
    app.listen(PORT, () => console.log(`Sumble backend listening on ${PORT}`));
  });
