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

// People filters. "IC" per Nooks = these four non-manager levels.
const SDR_JOB_FUNCTIONS = ['Sales Development Representative'];
const AE_JOB_FUNCTIONS = ['Account Executive'];
const IC_JOB_LEVELS = ['Individual Contributor', 'Senior', 'Lead', 'Principal'];
const PEOPLE_TARGET = 10; // fill up to this many rows: SDRs first, then AEs
const JOBS_LIMIT = 10;     // job-posting fallback when no SDR/AE people exist

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

// ---- Sumble: people for a given function set (IC levels) ----
async function fetchPeople(domain, jobFunctions, limit) {
  if (limit <= 0) return { people: [], totalCount: 0 };
  const resp = await fetch(`${SUMBLE_BASE}${SUMBLE_PEOPLE_FIND_PATH}`, {
    method: 'POST',
    headers: sumbleHeaders(),
    body: JSON.stringify({
      organization: { domain },
      filters: { job_functions: jobFunctions, job_levels: IC_JOB_LEVELS },
      limit,
    }),
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
async function fetchJobs(domain, jobFunction, limit) {
  const resp = await fetch(`${SUMBLE_BASE}/v6/jobs/find`, {
    method: 'POST',
    headers: sumbleHeaders(),
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
async function buildSdrPeopleData(domain) {
  const sdr = await fetchPeople(domain, SDR_JOB_FUNCTIONS, PEOPLE_TARGET);
  let people = sdr.people.map((p) => ({ ...p, type: 'SDR' }));
  let aeLiveCount = null;

  if (people.length < PEOPLE_TARGET) {
    const ae = await fetchPeople(domain, AE_JOB_FUNCTIONS, PEOPLE_TARGET - people.length);
    aeLiveCount = ae.totalCount;
    people = people.concat(ae.people.map((p) => ({ ...p, type: 'AE' })));
  }

  const out = { people, sdrLiveCount: sdr.totalCount, aeLiveCount, mode: 'people' };

  // Only look at postings if there are NO SDR and NO AE people.
  if (people.length === 0) {
    const sdrJobs = await fetchJobs(domain, 'Sales Development Representative', JOBS_LIMIT);
    out.mode = 'jobs';
    out.jobs = sdrJobs.jobs.map((j) => ({ ...j, type: 'SDR' }));
    out.jobsTotal = sdrJobs.total;
  }
  return out;
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

  // ----- People (with AE top-up + job-posting fallback) -----
  if (want === 'all' || want === 'people') {
    let pdata = force ? null : await db.getCached(orgKey, 'people', PEOPLE_TTL_MS);
    if (pdata) {
      result.peopleStatus = 'cached';
    } else if (cachedOnly && !force) {
      result.peopleStatus = 'not_loaded'; // gated — no paid call
    } else if (!SUMBLE_API_KEY) {
      result.peopleError = 'SUMBLE_API_KEY not configured on backend.';
    } else if (!domain) {
      result.peopleError = 'No domain to query Sumble people.';
    } else {
      try {
        pdata = await buildSdrPeopleData(domain);
        await db.setCached(orgKey, 'people', pdata);
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
app.get('/api/sumble-lists', async (_req, res) => {
  try {
    let lists = await db.getCached('global', 'sumble_lists', SUMBLE_LISTS_TTL_MS);
    if (!lists) {
      const resp = await fetch(`${SUMBLE_BASE}/v6/organization-lists`, { headers: sumbleHeaders() });
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
      await db.setCached('global', 'sumble_lists', lists);
    }
    res.json({ status: 'success', lists });
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

app.post('/api/push-to-sumble-list', async (req, res) => {
  try {
    const { hubspotListId, sumbleListId, newListName } = req.body;
    if (!hubspotListId) return res.status(400).json({ status: 'error', message: 'Missing hubspotListId' });
    if (!sumbleListId && !newListName) {
      return res.status(400).json({ status: 'error', message: 'Pick a Sumble list or provide a new list name' });
    }
    if (!SUMBLE_API_KEY) return res.status(500).json({ status: 'error', message: 'SUMBLE_API_KEY not configured' });

    // Resolve target list (create if new).
    let listId = sumbleListId;
    let listUrl = null;
    let listName = null;
    if (newListName) {
      const cr = await fetch(`${SUMBLE_BASE}/v6/organization-lists`, {
        method: 'POST',
        headers: sumbleHeaders(),
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
        headers: sumbleHeaders(),
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

    res.json({
      status: 'success',
      listId,
      listName,
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

const PORT = process.env.PORT || 3001;
db.init()
  .catch((err) => console.error('[STARTUP] db.init failed (continuing):', err.message))
  .finally(() => {
    app.listen(PORT, () => console.log(`Sumble backend listening on ${PORT}`));
  });
