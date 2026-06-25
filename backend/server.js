const express = require('express');
const cors = require('cors');
const zlib = require('zlib');
const readline = require('readline');
const { Readable } = require('stream');
const db = require('./db');

const app = express();
app.use(express.json());
app.use(cors());

const ENV_SUMBLE_KEY = process.env.SUMBLE_API_KEY; // fallback when no key is stored
const HUBSPOT_SERVICE_KEY = process.env.HUBSPOT_SERVICE_KEY;
// Single-tenant guard: if set, only this HubSpot portal may connect/use Sumble.
// (For multi-tenant/marketplace, replace with HubSpot request-signature verification.)
const ALLOWED_PORTAL_ID = process.env.ALLOWED_PORTAL_ID || null;

const SUMBLE_BASE = 'https://api.sumble.com';

// Score-decomposition export (read-only machine-to-machine endpoint on the
// scoring service). We pull the full NDJSON snapshot once daily and cache it.
const SCORING_BREAKDOWNS_URL = (process.env.SCORING_BREAKDOWNS_URL || 'https://sumble-account-scoring.onrender.com').replace(/\/$/, '');
const SERVICE_API_KEY = process.env.SERVICE_API_KEY || null;

// --- endpoint paths (verified against the live Sumble API) ---
const SUMBLE_PEOPLE_FIND_PATH = '/v6/people/find';        // POST, organization.domain + filters
const SUMBLE_ORG_MATCH_PATH = '/v6/organizations/match';  // POST, resolve domain -> org id
// Brief is GET /v6/organizations/{orgId}/intelligence-brief (templated in fetchBrief)

// People filters. "IC" per Nooks = these four non-manager levels.
const SDR_JOB_FUNCTIONS = ['Sales Development Representative'];
const AE_JOB_FUNCTIONS = ['Account Executive'];
const IC_JOB_LEVELS = ['Individual Contributor', 'Senior', 'Lead', 'Principal'];
const PEOPLE_TARGET = 10; // fill up to this many rows: SDRs first, then AEs
const JOBS_LIMIT = 10;     // job-posting fallback when no SDR/AE people exist

// "Sellable" = IC reps in sellable regions, excluding offshore-heavy locations
// (India/Pakistan/Brazil/etc.) where SDR work is typically outsourced. Allow-lists
// lifted verbatim from the Sumble sellable people queries.
const SELLABLE_HQ_LOCATIONS = ['Europe', 'NAMER', 'IL', 'AU', 'JP', 'ID', 'SG', 'MY', 'VN', 'NZ', 'KR', 'HK', 'TW', 'CN', 'TH', 'BD', 'LK', 'NP', 'KH', 'MM', 'UZ', 'MN', 'MH', 'PG', 'TV', 'MV', 'VU', 'KG', 'FJ', 'AF', 'FM', 'BT', 'TJ', 'KI', 'TM', 'WF', 'PW', 'WS', 'SB', 'NR', 'TL', 'TO', 'AR', 'PE', 'CL', 'EC', 'UY', 'GT', 'CR', 'PA', 'BO', 'DO', 'VE', 'SV', 'PY', 'JM', 'HN', 'BS', 'GD', 'NI', 'CU', 'BZ', 'TT', 'LC', 'SR', 'AG', 'HT', 'BB', 'VC', 'GY', 'MQ', 'KN', 'DM', 'AW', 'BQ', 'ZA', 'Africa', 'SA', 'IR', 'BH', 'JO', 'QA', 'LB', 'IQ', 'KW', 'OM', 'YE'];
const SELLABLE_COUNTRIES = ['US', 'CA', 'MX', 'AT', 'BE', 'HR', 'CZ', 'DK', 'FI', 'FR', 'DE', 'GR', 'IS', 'IE', 'IT', 'LI', 'LU', 'MC', 'NL', 'NO', 'PL', 'PT', 'RO', 'ES', 'SE', 'CH', 'TR', 'UK', 'IL', 'AU', 'JP', 'SG', 'NZ', 'HK', 'CL', 'ZA', 'BO', 'RS', 'HU', 'BG', 'LT'];
const sqlList = (arr) => arr.map((v) => `'${v}'`).join(', ');
const sellablePeopleQuery = (jobFunction) =>
  `job_function EQ '${jobFunction}' AND job_level IN (${sqlList(IC_JOB_LEVELS)}) AND hq_location IN (${sqlList(SELLABLE_HQ_LOCATIONS)}) AND country IN (${sqlList(SELLABLE_COUNTRIES)})`;

// Cache TTLs
const PEOPLE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30d — matches Sumble's ~monthly refresh
const BRIEF_TTL_MS = Infinity;                  // brief never auto-expires; refresh is manual
const ORG_TTL_MS = 30 * 24 * 60 * 60 * 1000;    // 30d (org id rarely changes)

console.log(`[STARTUP] Sumble backend at ${new Date().toISOString()}`);
console.log(`[STARTUP] env Sumble key: ${!!ENV_SUMBLE_KEY} | HubSpot key: ${!!HUBSPOT_SERVICE_KEY} | portal guard: ${ALLOWED_PORTAL_ID || 'off'}`);
console.log(`[STARTUP] score breakdowns: ${SERVICE_API_KEY ? 'on' : 'OFF (set SERVICE_API_KEY)'} | source: ${SCORING_BREAKDOWNS_URL}`);

const sumbleHeaders = (apiKey) => ({
  Authorization: `Bearer ${apiKey}`,
  'Content-Type': 'application/json',
});
const hubspotHeaders = () => ({
  Authorization: `Bearer ${HUBSPOT_SERVICE_KEY}`,
  'Content-Type': 'application/json',
});

// Resolve the Sumble key for a request: the admin-connected key stored for this
// portal (encrypted in Postgres), else the ENV_SUMBLE_KEY fallback.
async function resolveSumbleKey(portalId) {
  if (portalId) {
    try {
      const s = await db.getSecret(portalId);
      if (s && s.value) return s.value;
    } catch (err) {
      console.error('[KEY] getSecret failed:', err.message);
    }
  }
  return ENV_SUMBLE_KEY || null;
}

// Test a Sumble key with a cheap call (list org-lists). Returns true if accepted.
async function testSumbleKey(apiKey) {
  try {
    const resp = await fetch(`${SUMBLE_BASE}/v6/organization-lists`, { headers: sumbleHeaders(apiKey) });
    return resp.ok;
  } catch {
    return false;
  }
}

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

// ---- Sumble: people for a given function set (IC levels) ----
async function fetchPeople(domain, jobFunctions, limit, apiKey, sellable = false) {
  if (limit <= 0) return { people: [], totalCount: 0 };
  // Sellable adds the hq_location/country allow-lists via the query form; the
  // default keeps the existing job_functions/job_levels object form.
  const filters = sellable
    ? { query: sellablePeopleQuery(jobFunctions[0]) }
    : { job_functions: jobFunctions, job_levels: IC_JOB_LEVELS };
  const resp = await fetch(`${SUMBLE_BASE}${SUMBLE_PEOPLE_FIND_PATH}`, {
    method: 'POST',
    headers: sumbleHeaders(apiKey),
    body: JSON.stringify({ organization: { domain }, filters, limit }),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    const err = new Error(e.message || `Sumble people/find failed (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  const people = (data.people || data.results || data.data || []).map((person) => ({
    id: person.id,
    name: person.name || person.full_name || null,
    title: person.job_title || person.title || null,
    jobLevel: person.job_level || null,
    jobFunction: person.job_function || null,
    location: person.location || person.country || null,
    linkedinUrl: person.linkedin_url || null,
    url: person.url || null,
    startDate: person.start_date || null,
    leadScore: person.sumble_lead_score ?? person.lead_score ?? null, // absent in practice
  }));
  const totalCount = data.people_count ?? data.total ?? data.total_count ?? people.length;
  return { people, totalCount };
}

// ---- Sumble: job postings for a function in the last 12 months ----
// Mirrors the Sumble web filter: job_function + hiring_period '1yr'.
async function fetchJobs(domain, jobFunction, limit, apiKey) {
  const resp = await fetch(`${SUMBLE_BASE}/v6/jobs/find`, {
    method: 'POST',
    headers: sumbleHeaders(apiKey),
    body: JSON.stringify({
      organization: { domain },
      filters: { query: `job_function EQ '${jobFunction}' AND hiring_period EQ '1yr'` },
      limit,
    }),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    const err = new Error(e.message || `Sumble jobs/find failed (${resp.status})`);
    err.status = resp.status;
    throw err;
  }
  const data = await resp.json();
  const jobs = (data.jobs || data.results || data.data || []).map((j) => ({
    id: j.id,
    title: j.job_title || null,
    location: j.location || null,
    jobFunction: j.primary_job_function || jobFunction,
    postedAt: j.datetime_pulled || null,
    url: j.url || null,
  }));
  const total = data.total ?? data.jobs_count ?? jobs.length;
  return { jobs, total };
}

// ---- Cascade: top-10 SDRs, top up with AEs, fall back to SDR job postings ----
async function buildSdrPeopleData(domain, apiKey, sellable = false) {
  const sdr = await fetchPeople(domain, SDR_JOB_FUNCTIONS, PEOPLE_TARGET, apiKey, sellable);
  let people = sdr.people.map((p) => ({ ...p, type: 'SDR' }));
  let aeLiveCount = null;

  if (people.length < PEOPLE_TARGET) {
    const ae = await fetchPeople(domain, AE_JOB_FUNCTIONS, PEOPLE_TARGET - people.length, apiKey, sellable);
    aeLiveCount = ae.totalCount;
    people = people.concat(ae.people.map((p) => ({ ...p, type: 'AE' })));
  }

  const out = { people, sdrLiveCount: sdr.totalCount, aeLiveCount, mode: 'people' };

  // Only look at postings if there are NO SDR and NO AE people.
  if (people.length === 0) {
    const sdrJobs = await fetchJobs(domain, 'Sales Development Representative', JOBS_LIMIT, apiKey);
    out.mode = 'jobs';
    out.jobs = sdrJobs.jobs.map((j) => ({ ...j, type: 'SDR' }));
    out.jobsTotal = sdrJobs.total;
  }
  return out;
}

// ---- Sumble: resolve org id (needed for the brief). 1 credit, cached 30d. ----
// Match takes `url` (not `domain`); the id lives at results[0].match.id.
async function resolveOrgId(domain, apiKey) {
  const resp = await fetch(`${SUMBLE_BASE}${SUMBLE_ORG_MATCH_PATH}`, {
    method: 'POST',
    headers: sumbleHeaders(apiKey),
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
async function fetchBrief(orgId, apiKey) {
  const resp = await fetch(`${SUMBLE_BASE}/v6/organizations/${orgId}/intelligence-brief`, {
    method: 'GET',
    headers: sumbleHeaders(apiKey),
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
async function buildEnrichment(companyId, { force = false, want = 'all', cachedOnly = true, sumbleKey = null, sellable = false } = {}) {
  const NOT_CONNECTED = 'Sumble isn\'t connected. An admin can connect it in the app\'s Settings.';
  const company = await getCompany(companyId);
  const domain = cleanDomain(company);
  const orgKey = orgKeyFor(company);
  // Sellable people are a different result set → cache them separately.
  const peopleSection = sellable ? 'people_sellable' : 'people';
  const result = {
    companyId,
    domain,
    sumbleProfileUrl: company.sumble_profile_url || null,
    sumbleOrgName: company.sumble_organization_name || company.name || null,
    syncedSdrIcCount: company.sumble_sdr_ic_people_count
      ? parseInt(company.sumble_sdr_ic_people_count, 10)
      : null,
    sdrDeepLinkUrl: sdrDeepLink(company),
    sellable,
  };

  if (!domain && !orgKey) {
    result.error = 'No domain or Sumble slug on this company to look up.';
    return result;
  }

  // ----- People (with AE top-up + job-posting fallback) -----
  if (want === 'all' || want === 'people') {
    let pdata = force ? null : await db.getCached(orgKey, peopleSection, PEOPLE_TTL_MS);
    if (pdata) {
      result.peopleStatus = 'cached';
    } else if (cachedOnly && !force) {
      result.peopleStatus = 'not_loaded'; // gated — no paid call
    } else if (!sumbleKey) {
      result.peopleError = NOT_CONNECTED;
    } else if (!domain) {
      result.peopleError = 'No domain to query Sumble people.';
    } else {
      try {
        pdata = await buildSdrPeopleData(domain, sumbleKey, sellable);
        await db.setCached(orgKey, peopleSection, pdata);
        result.peopleStatus = 'loaded';
      } catch (err) {
        result.peopleError = err.message;
      }
    }
    if (pdata) {
      result.sdrPeople = pdata.people;
      result.sdrLiveCount = pdata.sdrLiveCount;
      result.aeLiveCount = pdata.aeLiveCount;
      result.peopleMode = pdata.mode;
      result.jobs = pdata.jobs || null;
      result.jobsTotal = pdata.jobsTotal ?? null;
    }
  }

  // ----- Brief -----
  if (want === 'all' || want === 'brief') {
    let brief = force ? null : await db.getCached(orgKey, 'brief', BRIEF_TTL_MS);
    if (brief) {
      result.briefStatus = 'ready';
    } else if (cachedOnly && !force) {
      result.briefStatus = 'not_loaded'; // gated — no paid call (incl. org match)
    } else if (!sumbleKey) {
      result.briefError = NOT_CONNECTED;
    } else if (!domain) {
      result.briefError = 'No domain to resolve Sumble org for the brief.';
    } else {
      try {
        let orgId = await db.getCached(orgKey, 'orgId', ORG_TTL_MS);
        if (!orgId) {
          orgId = await resolveOrgId(domain, sumbleKey);
          if (orgId) await db.setCached(orgKey, 'orgId', orgId);
        }
        if (!orgId) {
          result.briefError = 'Could not resolve a Sumble organization id.';
        } else {
          brief = await fetchBrief(orgId, sumbleKey);
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
    const { companyId, want, cachedOnly, portalId, sellable } = req.body;
    if (!companyId) return res.status(400).json({ status: 'error', message: 'Missing companyId' });
    const sumbleKey = await resolveSumbleKey(portalId);
    // Default cachedOnly=true so auto-load never spends credits; a deliberate
    // button click sends cachedOnly:false to make the paid call.
    const data = await buildEnrichment(companyId, {
      force: false,
      want: want || 'all',
      cachedOnly: cachedOnly !== false,
      sumbleKey,
      sellable: sellable === true,
    });
    res.json({ status: 'success', ...data });
  } catch (err) {
    console.error('[ENRICHMENT] error:', err.message);
    res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/refresh', async (req, res) => {
  try {
    const { companyId, want, portalId, sellable } = req.body;
    if (!companyId) return res.status(400).json({ status: 'error', message: 'Missing companyId' });
    const sumbleKey = await resolveSumbleKey(portalId);
    const data = await buildEnrichment(companyId, { force: true, want: want || 'all', sumbleKey, sellable: sellable === true });
    res.json({ status: 'success', ...data });
  } catch (err) {
    console.error('[REFRESH] error:', err.message);
    res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
});

// ============================================================
// Phase 2: push a HubSpot company list into a Sumble org list
// ============================================================
const MAX_LIST_COMPANIES = 1000; // safety cap per push
const SUMBLE_LISTS_TTL_MS = 5 * 60 * 1000; // cache the dropdown to limit 1cr/list

// Source dropdown: the account's COMPANY lists (objectTypeId 0-2).
app.get('/api/hubspot-company-lists', async (_req, res) => {
  try {
    const resp = await fetch('https://api.hubapi.com/crm/v3/lists/search', {
      method: 'POST',
      headers: hubspotHeaders(),
      body: JSON.stringify({ query: '', count: 250, offset: 0 }),
    });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      return res.status(resp.status).json({ status: 'error', message: e.message || 'Failed to read HubSpot lists (is crm.lists.read on the Service Key?)' });
    }
    const data = await resp.json();
    const lists = (data.lists || [])
      .filter((l) => l.objectTypeId === '0-2')
      .map((l) => ({
        id: l.listId,
        name: l.name,
        size: l.additionalProperties?.hs_list_size ?? null,
        type: l.processingType,
      }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    res.json({ status: 'success', lists });
  } catch (err) {
    console.error('[HS LISTS] error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Target dropdown: existing Sumble org lists (1 credit/list; cached 5 min).
app.get('/api/sumble-lists', async (req, res) => {
  try {
    const sumbleKey = await resolveSumbleKey(req.query.portalId);
    if (!sumbleKey) return res.status(409).json({ status: 'error', message: 'Sumble isn\'t connected. Connect it in the app Settings.' });
    let cached = await db.getCached('global', 'sumble_lists', SUMBLE_LISTS_TTL_MS);
    let lists, creditsRemaining;
    if (cached) {
      lists = cached.lists;
      creditsRemaining = cached.creditsRemaining ?? null;
    } else {
      const resp = await fetch(`${SUMBLE_BASE}/v6/organization-lists`, { headers: sumbleHeaders(sumbleKey) });
      if (!resp.ok) {
        const e = await resp.json().catch(() => ({}));
        return res.status(resp.status).json({ status: 'error', message: e.message || 'Failed to read Sumble lists' });
      }
      const data = await resp.json();
      lists = (data.organization_lists || data.lists || data.results || []).map((l) => ({
        id: l.id,
        name: l.name,
        url: l.url || null,
        count: l.organizations_count ?? null,
      }));
      creditsRemaining = data.credits_remaining ?? null; // captured free from the same call
      await db.setCached('global', 'sumble_lists', { lists, creditsRemaining });
    }
    res.json({ status: 'success', lists, creditsRemaining });
  } catch (err) {
    console.error('[SUMBLE LISTS] error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Read up to MAX_LIST_COMPANIES record ids from a HubSpot list.
async function getHubspotListMemberIds(listId) {
  const ids = [];
  let after = null;
  do {
    const url = `https://api.hubapi.com/crm/v3/lists/${listId}/memberships?limit=100${after ? `&after=${after}` : ''}`;
    const resp = await fetch(url, { headers: hubspotHeaders() });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      const err = new Error(e.message || `Failed to read list ${listId} memberships`);
      err.status = resp.status;
      throw err;
    }
    const data = await resp.json();
    for (const r of data.results || []) ids.push(r.recordId);
    after = data.paging?.next?.after || null;
  } while (after && ids.length < MAX_LIST_COMPANIES);
  return ids.slice(0, MAX_LIST_COMPANIES);
}

// Batch-read sumble_organization_slug for company ids (100 per batch).
async function getCompanySlugs(companyIds) {
  const slugs = [];
  for (let i = 0; i < companyIds.length; i += 100) {
    const chunk = companyIds.slice(i, i + 100);
    const resp = await fetch('https://api.hubapi.com/crm/v3/objects/companies/batch/read', {
      method: 'POST',
      headers: hubspotHeaders(),
      body: JSON.stringify({ properties: ['sumble_organization_slug'], inputs: chunk.map((id) => ({ id })) }),
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const c of data.results || []) {
      const slug = c.properties?.sumble_organization_slug;
      if (slug) slugs.push(slug.trim());
    }
  }
  return slugs;
}

// Batch-read arbitrary company properties (100 per batch).
async function batchReadCompanyProps(companyIds, props) {
  const out = [];
  for (let i = 0; i < companyIds.length; i += 100) {
    const chunk = companyIds.slice(i, i + 100);
    const resp = await fetch('https://api.hubapi.com/crm/v3/objects/companies/batch/read', {
      method: 'POST',
      headers: hubspotHeaders(),
      body: JSON.stringify({ properties: props, inputs: chunk.map((id) => ({ id })) }),
    });
    if (!resp.ok) continue;
    const data = await resp.json();
    for (const c of data.results || []) out.push(c.properties || {});
  }
  return out;
}

const numv = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
};

// The synced HubSpot properties the reports aggregate. All Sumble-synced, so
// reading them costs no Sumble credits.
const SEGMENT_PROPS = [
  'sumble_organization_slug',
  'sumble_sdr_ic_people_count',
  'sumble_ae_ic_people_count_people_count',
  'estimated__ic_sales_team_sumble',
  'account_score__nooks_',
  'current_sales_segment_sumble',
  'sumble_sdr_job_post_1mo_count',
];

// Aggregate a set of company property rows into the report shape. Shared by the
// per-list segment report and the portal-wide overview.
function aggregateCompanyRows(rows) {
  let matched = 0, icSdr = 0, icAe = 0, icSales = 0, fitSum = 0, fitCount = 0, hiring = 0;
  const segments = { COMM: 0, 'Mid-Market': 0, Enterprise: 0, Unknown: 0 };
  for (const p of rows) {
    if (p.sumble_organization_slug) matched += 1;
    icSdr += numv(p.sumble_sdr_ic_people_count) || 0;
    icAe += numv(p.sumble_ae_ic_people_count_people_count) || 0;
    icSales += numv(p.estimated__ic_sales_team_sumble) || 0;
    const fit = numv(p.account_score__nooks_);
    if (fit !== null) { fitSum += fit; fitCount += 1; }
    const seg = p.current_sales_segment_sumble;
    if (seg && segments[seg] !== undefined) segments[seg] += 1; else segments.Unknown += 1;
    if ((numv(p.sumble_sdr_job_post_1mo_count) || 0) > 0) hiring += 1;
  }
  const total = rows.length;
  return {
    totalCompanies: total,
    matched,
    matchRate: total ? Math.round((matched / total) * 100) : 0,
    icSdrTotal: Math.round(icSdr),
    icAeTotal: Math.round(icAe),
    icSalesTotal: Math.round(icSales),
    avgFit: fitCount ? Math.round((fitSum / fitCount) * 10) / 10 : null,
    segments,
    hiringSdrCompanies: hiring,
  };
}

// Page EVERY company in the portal, reading `props`. Used by the portal-wide
// overview (which needs true seat sums, not just counts). Bounded by a safety
// cap so a huge portal can't run unbounded.
const MAX_PORTAL_COMPANIES = 100000; // 1000 pages of 100 — safety bound
async function readAllCompanyProps(props, cap = MAX_PORTAL_COMPANIES) {
  const out = [];
  let after = null;
  do {
    const url = `https://api.hubapi.com/crm/v3/objects/companies?limit=100&properties=${encodeURIComponent(props.join(','))}${after ? `&after=${after}` : ''}`;
    const resp = await fetch(url, { headers: hubspotHeaders() });
    if (!resp.ok) {
      const e = await resp.json().catch(() => ({}));
      const err = new Error(e.message || 'Failed to page companies');
      err.status = resp.status;
      throw err;
    }
    const data = await resp.json();
    for (const c of data.results || []) out.push(c.properties || {});
    after = data.paging?.next?.after || null;
  } while (after && out.length < cap);
  return out;
}

// Feature 1+2: segment SDR-seat report + Sumble coverage, aggregated from the
// SYNCED HubSpot properties across a list's members. No Sumble API calls — free.
app.post('/api/segment-report', async (req, res) => {
  try {
    const { hubspotListId } = req.body;
    if (!hubspotListId) return res.status(400).json({ status: 'error', message: 'Missing hubspotListId' });
    const memberIds = await getHubspotListMemberIds(hubspotListId);
    const rows = await batchReadCompanyProps(memberIds, SEGMENT_PROPS);
    res.json({
      status: 'success',
      ...aggregateCompanyRows(rows),
      capped: memberIds.length >= MAX_LIST_COMPANIES,
    });
  } catch (err) {
    console.error('[SEGMENT REPORT] error:', err.message);
    res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
});

// Company COUNT for a search filter, read from the `total` the search API
// returns (no record paging). Used for instant portal-wide counts.
async function searchCompanyTotal(filterGroups) {
  const resp = await fetch('https://api.hubapi.com/crm/v3/objects/companies/search', {
    method: 'POST',
    headers: hubspotHeaders(),
    body: JSON.stringify({ filterGroups: filterGroups || [], limit: 1, properties: ['hs_object_id'] }),
  });
  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    const err = new Error(e.message || 'Company search failed');
    err.status = resp.status;
    throw err;
  }
  return (await resp.json()).total ?? 0;
}

// Page EVERY company and cache the portal-wide seat SUMS. HubSpot has no
// server-side SUM, so this is the only way to total seats across all 77k+
// companies — too slow for a request, so it runs on a nightly in-process timer
// (the web service is always-on) and a one-time bootstrap on first deploy.
async function computeAndCachePortalSeatSums() {
  const startedAt = Date.now();
  const rows = await readAllCompanyProps(SEGMENT_PROPS);
  const agg = aggregateCompanyRows(rows);
  const payload = {
    icSdrTotal: agg.icSdrTotal,
    icAeTotal: agg.icAeTotal,
    icSalesTotal: agg.icSalesTotal,
    avgFit: agg.avgFit,
    totalScanned: agg.totalCompanies,
    capped: rows.length >= MAX_PORTAL_COMPANIES,
    generatedAt: new Date().toISOString(),
  };
  await db.setCached('global', 'portal_seat_sums', payload);
  console.log(`[SEAT SUMS] cached ${payload.totalScanned} companies in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  return payload;
}

// Portal-wide overview: live counts (instant, via search totals) merged with the
// nightly-cached seat sums. No Sumble credits — synced HubSpot props only.
app.get('/api/portal-overview', async (_req, res) => {
  try {
    // Sequential to stay under the search API's per-second limit.
    const total = await searchCompanyTotal([]);
    const matched = await searchCompanyTotal([{ filters: [{ propertyName: 'sumble_organization_slug', operator: 'HAS_PROPERTY' }] }]);
    const comm = await searchCompanyTotal([{ filters: [{ propertyName: 'current_sales_segment_sumble', operator: 'EQ', value: 'COMM' }] }]);
    const mm = await searchCompanyTotal([{ filters: [{ propertyName: 'current_sales_segment_sumble', operator: 'EQ', value: 'Mid-Market' }] }]);
    const ent = await searchCompanyTotal([{ filters: [{ propertyName: 'current_sales_segment_sumble', operator: 'EQ', value: 'Enterprise' }] }]);
    const hiring = await searchCompanyTotal([{ filters: [{ propertyName: 'sumble_sdr_job_post_1mo_count', operator: 'GT', value: '0' }] }]);

    const seat = await db.getCached('global', 'portal_seat_sums', Infinity);
    res.json({
      status: 'success',
      totalCompanies: total,
      matched,
      matchRate: total ? Math.round((matched / total) * 100) : 0,
      segments: { COMM: comm, 'Mid-Market': mm, Enterprise: ent, Unknown: Math.max(0, total - comm - mm - ent) },
      hiringSdrCompanies: hiring,
      seatSums: seat
        ? {
            icSdrTotal: seat.icSdrTotal,
            icAeTotal: seat.icAeTotal,
            icSalesTotal: seat.icSalesTotal,
            avgFit: seat.avgFit,
            scanned: seat.totalScanned,
            generatedAt: seat.generatedAt,
          }
        : null,
    });
  } catch (err) {
    console.error('[PORTAL OVERVIEW] error:', err.message);
    res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
});

// Nightly seat-sums refresh, in-process (starter plan is always-on, so no
// external cron is needed). Fires at ~2am Pacific, then every 24h.
const SEAT_SUMS_HOUR_UTC = 9; // ~02:00 America/Los_Angeles
function msUntilNextSeatSumsRun() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(SEAT_SUMS_HOUR_UTC, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}
function scheduleNightlySeatSums() {
  const runNightly = () =>
    computeAndCachePortalSeatSums().catch((e) => console.error('[SEAT SUMS] nightly failed:', e.message));
  setTimeout(() => {
    runNightly();
    setInterval(runNightly, 24 * 60 * 60 * 1000);
  }, msUntilNextSeatSumsRun());
}
// First deploy: if there's no cached value yet, build it once in the background
// so the overview isn't empty until the first nightly run.
async function bootstrapSeatSums() {
  try {
    const existing = await db.getCached('global', 'portal_seat_sums', Infinity);
    if (!existing) {
      console.log('[SEAT SUMS] no cache yet — bootstrapping in background');
      computeAndCachePortalSeatSums().catch((e) => console.error('[SEAT SUMS] bootstrap failed:', e.message));
    }
  } catch (e) {
    console.error('[SEAT SUMS] bootstrap check failed:', e.message);
  }
}

// ---- Score-decomposition: daily pull of the scoring export → Postgres cache ----
// The export is a gzip-compressed NDJSON file served WITHOUT Content-Encoding,
// so we must gunzip the body ourselves (fetch won't). Full snapshot → upsert all.
async function pullAndCacheBreakdowns() {
  if (!SERVICE_API_KEY) {
    console.warn('[BREAKDOWNS] SERVICE_API_KEY not set — skipping pull.');
    return { skipped: true };
  }
  const startedAt = Date.now();
  const res = await fetch(`${SCORING_BREAKDOWNS_URL}/service/breakdowns`, {
    headers: { 'X-Service-Key': SERVICE_API_KEY },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`breakdowns pull failed: ${res.status} ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err; // caller keeps the existing cache and retries next cycle
  }
  // STREAM the ~60MB-decompressed NDJSON: gunzip incrementally, parse line by
  // line, and flush to Postgres in batches. Never hold the whole file (or the
  // full record array) in memory at once — that OOM-kills a small instance.
  const source = Readable.fromWeb(res.body).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: source, crlfDelay: Infinity });

  const FLUSH_AT = 1000;
  let batch = [];
  let cached = 0;
  let bad = 0;
  const flush = async () => {
    if (!batch.length) return;
    const toWrite = batch;
    batch = [];
    cached += await db.upsertBreakdowns(toWrite); // backpressure: readline pauses while we await
  };

  try {
    for await (const line of rl) {
      const t = line.trim();
      if (!t) continue;
      try { batch.push(JSON.parse(t)); } catch { bad++; }
      if (batch.length >= FLUSH_AT) await flush();
    }
    await flush();
  } finally {
    rl.close();
  }

  console.log(`[BREAKDOWNS] cached ${cached} accounts (${bad} unparseable lines) in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  return { cached, badLines: bad, generatedAt: new Date().toISOString() };
}

// Daily refresh, in-process. Fires ~10:00 Pacific (after the Mon 08:00 PT
// re-score), then every 24h. The export itself is never > ~24h old.
const BREAKDOWNS_HOUR_UTC = 17; // ~10:00 America/Los_Angeles
function msUntilNextBreakdownsRun() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(BREAKDOWNS_HOUR_UTC, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}
function scheduleDailyBreakdowns() {
  const run = () => pullAndCacheBreakdowns().catch((e) => console.error('[BREAKDOWNS] daily failed:', e.message));
  setTimeout(() => {
    run();
    setInterval(run, 24 * 60 * 60 * 1000);
  }, msUntilNextBreakdownsRun());
}
// First deploy: pull once in the background if the cache is empty.
async function bootstrapBreakdowns() {
  try {
    if (!SERVICE_API_KEY) return;
    const n = await db.breakdownCount();
    if (!n) {
      // Delay the first heavy pull so the health check marks the deploy live
      // before the background work starts (belt-and-suspenders with streaming).
      console.log('[BREAKDOWNS] no cache yet — bootstrapping in background in 15s');
      setTimeout(() => {
        pullAndCacheBreakdowns().catch((e) => console.error('[BREAKDOWNS] bootstrap failed:', e.message));
      }, 15000);
    }
  } catch (e) {
    console.error('[BREAKDOWNS] bootstrap check failed:', e.message);
  }
}

// Per-company serve: the card reads one cached row. No Sumble credits, no live
// dependency on the scoring service at view-time.
app.post('/api/score-breakdown', async (req, res) => {
  try {
    const { companyId, portalId } = req.body || {};
    if (!portalAllowed(portalId)) {
      return res.status(403).json({ status: 'error', message: 'This portal is not allowed to use the app.' });
    }
    if (!companyId) return res.status(400).json({ status: 'error', message: 'Missing companyId' });
    const breakdown = await db.getBreakdown(companyId);
    res.json({ status: 'success', breakdown: breakdown || null });
  } catch (err) {
    console.error('[BREAKDOWN] serve error:', err.message);
    res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
});

// Admin: force a fresh pull now (fire-and-forget; the pull can take ~30s+).
app.post('/api/score-breakdowns/refresh', async (req, res) => {
  try {
    const { portalId } = req.body || {};
    if (!portalAllowed(portalId)) {
      return res.status(403).json({ status: 'error', message: 'Not allowed.' });
    }
    pullAndCacheBreakdowns()
      .then((r) => console.log('[BREAKDOWNS] manual refresh done:', JSON.stringify(r)))
      .catch((e) => console.error('[BREAKDOWNS] manual refresh failed:', e.message));
    res.json({ status: 'success', message: 'Breakdown refresh started.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Feature 3: recent push activity log.
app.get('/api/push-log', async (req, res) => {
  try {
    const rows = await db.getPushLog(req.query.portalId, 20);
    res.json({ status: 'success', entries: rows });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/push-to-sumble-list', async (req, res) => {
  try {
    const { hubspotListId, hubspotListName, sumbleListName, sumbleListId, newListName, portalId } = req.body;
    if (!hubspotListId) return res.status(400).json({ status: 'error', message: 'Missing hubspotListId' });
    if (!sumbleListId && !newListName) {
      return res.status(400).json({ status: 'error', message: 'Pick a Sumble list or provide a new list name' });
    }
    const sumbleKey = await resolveSumbleKey(portalId);
    if (!sumbleKey) return res.status(409).json({ status: 'error', message: 'Sumble isn\'t connected. Connect it in the app Settings.' });

    // Resolve target list (create if new).
    let listId = sumbleListId;
    let listUrl = null;
    let listName = null;
    if (newListName) {
      const cr = await fetch(`${SUMBLE_BASE}/v6/organization-lists`, {
        method: 'POST',
        headers: sumbleHeaders(sumbleKey),
        body: JSON.stringify({ name: newListName }),
      });
      if (!cr.ok) {
        const e = await cr.json().catch(() => ({}));
        return res.status(cr.status).json({ status: 'error', message: e.message || 'Failed to create Sumble list' });
      }
      const created = await cr.json();
      listId = created.id;
      listUrl = created.url || null;
      listName = created.name || newListName;
      await db.setCached('global', 'sumble_lists', null); // bust dropdown cache
    }

    // Read HubSpot list members -> slugs.
    const memberIds = await getHubspotListMemberIds(hubspotListId);
    const slugs = await getCompanySlugs(memberIds);
    const uniqueSlugs = [...new Set(slugs)];

    let added = 0;
    let failed = 0;
    if (uniqueSlugs.length > 0) {
      const ar = await fetch(`${SUMBLE_BASE}/v6/organization-lists/${listId}/organizations`, {
        method: 'POST',
        headers: sumbleHeaders(sumbleKey),
        body: JSON.stringify({ organization_slugs: uniqueSlugs }),
      });
      if (!ar.ok) {
        const e = await ar.json().catch(() => ({}));
        return res.status(ar.status).json({ status: 'error', message: e.message || 'Failed to add organizations to Sumble list' });
      }
      const ad = await ar.json();
      added = (ad.added || []).length || uniqueSlugs.length;
      failed = (ad.failed_slugs || []).length;
    }

    const resolvedListName = listName || sumbleListName || 'Sumble list';
    await db.logPush({
      portalId,
      hubspotList: hubspotListName || `List ${hubspotListId}`,
      sumbleList: resolvedListName,
      total: memberIds.length,
      added: uniqueSlugs.length,
      skipped: memberIds.length - uniqueSlugs.length,
    }).catch((e) => console.error('[PUSH LIST] log failed:', e.message));

    res.json({
      status: 'success',
      listId,
      listName: resolvedListName,
      listUrl,
      totalCompanies: memberIds.length,
      withSlug: uniqueSlugs.length,
      skippedNoSlug: memberIds.length - uniqueSlugs.length,
      added,
      failed,
    });
  } catch (err) {
    console.error('[PUSH LIST] error:', err.message);
    res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
});

// Add specific org slugs to a Sumble list (create if newListName). Used by the
// per-company "Add to Sumble list" card (slug known client-side) — free.
app.post('/api/add-to-sumble-list', async (req, res) => {
  try {
    const { slugs, sumbleListId, newListName, portalId } = req.body;
    if (!Array.isArray(slugs) || slugs.length === 0) {
      return res.status(400).json({ status: 'error', message: 'No company slugs provided' });
    }
    if (!sumbleListId && !newListName) {
      return res.status(400).json({ status: 'error', message: 'Pick a Sumble list or provide a new list name' });
    }
    const sumbleKey = await resolveSumbleKey(portalId);
    if (!sumbleKey) return res.status(409).json({ status: 'error', message: 'Sumble isn\'t connected. Connect it in the app Settings.' });

    let listId = sumbleListId;
    let listUrl = null;
    let listName = null;
    if (newListName) {
      const cr = await fetch(`${SUMBLE_BASE}/v6/organization-lists`, {
        method: 'POST', headers: sumbleHeaders(sumbleKey), body: JSON.stringify({ name: newListName }),
      });
      if (!cr.ok) {
        const e = await cr.json().catch(() => ({}));
        return res.status(cr.status).json({ status: 'error', message: e.message || 'Failed to create Sumble list' });
      }
      const created = await cr.json();
      listId = created.id; listUrl = created.url || null; listName = created.name || newListName;
      await db.setCached('global', 'sumble_lists', null); // bust dropdown cache
    }

    const uniqueSlugs = [...new Set(slugs.map((s) => String(s).trim()).filter(Boolean))];
    const ar = await fetch(`${SUMBLE_BASE}/v6/organization-lists/${listId}/organizations`, {
      method: 'POST', headers: sumbleHeaders(sumbleKey), body: JSON.stringify({ organization_slugs: uniqueSlugs }),
    });
    if (!ar.ok) {
      const e = await ar.json().catch(() => ({}));
      return res.status(ar.status).json({ status: 'error', message: e.message || 'Failed to add to Sumble list' });
    }
    const ad = await ar.json();
    res.json({
      status: 'success',
      listId, listName, listUrl,
      added: (ad.added || []).length || uniqueSlugs.length,
      failed: (ad.failed_slugs || []).length,
    });
  } catch (err) {
    console.error('[ADD TO LIST] error:', err.message);
    res.status(err.status || 500).json({ status: 'error', message: err.message });
  }
});

// ============================================================
// Admin settings: connect Sumble (per-portal, encrypted at rest)
// ============================================================
const portalAllowed = (portalId) => !ALLOWED_PORTAL_ID || String(portalId) === String(ALLOWED_PORTAL_ID);
const mask = (key) => (key && key.length >= 4 ? `••••${key.slice(-4)}` : '••••');

// Connection status — never returns the key.
app.get('/api/sumble-connection', async (req, res) => {
  try {
    const portalId = req.query.portalId;
    let connected = false, masked = null, updatedAt = null, source = 'none';
    if (portalId) {
      const s = await db.getSecret(portalId).catch(() => null);
      if (s && s.value) { connected = true; masked = mask(s.value); updatedAt = s.updatedAt; source = 'stored'; }
    }
    if (!connected && ENV_SUMBLE_KEY) { connected = true; masked = mask(ENV_SUMBLE_KEY); source = 'env'; }
    res.json({ status: 'success', connected, masked, updatedAt, source, encryption: db.encryptionEnabled });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Connect / update: validate the key with Sumble, then store it encrypted.
app.post('/api/sumble-connection', async (req, res) => {
  try {
    const { portalId, apiKey } = req.body;
    if (!portalId) return res.status(400).json({ status: 'error', message: 'Missing portalId' });
    if (!portalAllowed(portalId)) return res.status(403).json({ status: 'error', message: 'This portal is not allowed to configure the app.' });
    if (!apiKey || !apiKey.trim()) return res.status(400).json({ status: 'error', message: 'Paste your Sumble API key' });
    if (!db.encryptionEnabled) {
      return res.status(500).json({ status: 'error', message: 'Backend encryption is not configured (set ENCRYPTION_KEY). Credentials are only stored encrypted.' });
    }
    const valid = await testSumbleKey(apiKey.trim());
    if (!valid) return res.status(400).json({ status: 'error', message: 'Sumble rejected that key. Double-check it at sumble.com/account/api-keys.' });
    await db.setSecret(portalId, apiKey.trim());
    await db.setCached('global', 'sumble_lists', null); // bust list cache for the new key
    res.json({ status: 'success', connected: true, masked: mask(apiKey.trim()) });
  } catch (err) {
    console.error('[CONNECT] error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Disconnect: remove the stored key for this portal.
app.delete('/api/sumble-connection', async (req, res) => {
  try {
    const { portalId } = req.body || {};
    if (!portalId) return res.status(400).json({ status: 'error', message: 'Missing portalId' });
    if (!portalAllowed(portalId)) return res.status(403).json({ status: 'error', message: 'Not allowed.' });
    await db.deleteSecret(portalId);
    res.json({ status: 'success', connected: !!ENV_SUMBLE_KEY });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

const PORT = process.env.PORT || 3001;
db.init()
  .catch((err) => console.error('[STARTUP] db.init failed (continuing):', err.message))
  .finally(() => {
    app.listen(PORT, () => console.log(`Sumble backend listening on ${PORT}`));
    bootstrapSeatSums();        // build portal seat sums once if never built
    scheduleNightlySeatSums();  // refresh nightly thereafter
    bootstrapBreakdowns();      // pull score-decomposition export once if empty
    scheduleDailyBreakdowns();  // refresh daily thereafter
  });
