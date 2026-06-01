# Sumble Enrichment — HubSpot App

A private HubSpot app (project-based, platform 2025.2) that surfaces Sumble's enrichment depth directly in HubSpot — four company-record cards plus a full-page list builder — so reps don't tab-switch to the Sumble web app.

## Components

### Company-record cards

| Card | Surface | What it shows | Sumble credits |
|---|---|---|---|
| **Sumble · Sales Org & Fit** | middle column | Formatted view of synced `sumble_*` properties: Nooks fit score, sales segment, **IC SDR / IC AE seat counts**, GTM org breakdown, YoY growth, hiring signals, B2B/B2C/AI-native, lead-gen tools. | **0** — reads HubSpot properties only |
| **Sumble · Sellable Seats** | middle column | Verifies the IC-SDR sellable-seat count against the live Sumble count, then lists the actual people. **Cascade:** top 10 SDRs → if <10, top up with IC AEs (each row badged) → if 0 of either, show recent SDR **job postings** (last 12mo). | click-gated; ~1 / person (≤10), cached 30d. Jobs fallback 2 / posting (≤10), only when no people |
| **Sumble · Intelligence Brief** | middle column | Sumble's AI account brief (angle, who to contact, the intel, recent changes), rendered to formatted sections with clickable people links. Shows "Generated X ago" + manual refresh. | click-gated ("Generate"); ~50 / brief, cached until refreshed |
| **Sumble · Add to List** | sidebar | Add **this** company to a Sumble organization list (existing or new), then open the filtered org-search view. | **0** to add; loading the list dropdown is ~1 / existing list (cached 5min) |

### App page

| Page | What it does | Credits |
|---|---|---|
| **Add a HubSpot list to Sumble** (app home, Marketplace-icon nav) | Pick a HubSpot company list → bulk-add every member to a Sumble org list (by synced slug) → open the filtered org-search view. Companies without a Sumble match are skipped; Sumble de-dupes the rest. | **0** to create/add; ~1 / existing list to load the dropdown |

> **Why not iframe the Sumble page?** Sumble serves `X-Frame-Options: DENY` + `frame-ancestors 'none'`, a hard browser ban on embedding. So we pull data via Sumble's REST API and deep-link out.

## Architecture

```
HubSpot Company record + App home page
  └─ UI extensions (cards + page)
        │ hubspot.fetch
        ▼
  Render web service `sumble-enrichment-backend` (Express)
        ├─ Bearer SUMBLE_API_KEY      → api.sumble.com (people, jobs, brief, org-lists)
        ├─ Bearer HUBSPOT_SERVICE_KEY → HubSpot CRM (read company props + lists)
        └─ DATABASE_URL               → Render Postgres (durable cache)
```

The **Sales Org & Fit** card needs no backend (reads synced properties). The others call the backend, which proxies Sumble and caches per org so credits are spent once per company per TTL, not on every view. **Every credit-costing action is gated behind an explicit click** — opening a record or the app page spends nothing.

## Live resources

- GitHub: `NooksRevOps/Sumble-Enrichment-HS-Card`
- Render web service: `sumble-enrichment-backend` → https://sumble-enrichment-backend.onrender.com
- Render Postgres: `sumble-enrichment-cache`
- HubSpot project/app: `sumble-enrichment-card` / `sumble-enrichment-app` (portal 21261434)

## Setup

### 1. Sumble API key
Create at **sumble.com/account/api-keys**. Copy it (shown once).

### 2. HubSpot Service Key
HubSpot **Settings → Integrations → Service Keys** → new key with scopes:
- `crm.objects.companies.read` — read company props
- `crm.lists.read` — read HubSpot lists (for the List Builder app page)

### 3. Render env vars
On the `sumble-enrichment-backend` service → **Environment**:
- `SUMBLE_API_KEY` = your Sumble key
- `HUBSPOT_SERVICE_KEY` = your HubSpot Service Key
- `DATABASE_URL` = **"Add from Database" → sumble-enrichment-cache → Internal Database URL**

Health check: `curl https://sumble-enrichment-backend.onrender.com/health`.

> The backend runs without `DATABASE_URL` (non-durable in-memory cache), but set it so the cache survives restarts and protects credits.

### 4. Install + place
```bash
hs project install-deps
hs project upload
```
Then `hs project open` → **sumble-enrichment-app** → **Distribution → Install** (approve scopes).
- **Cards:** open a company → **Customize record** → add the cards to the middle column (and "Add to List" to the sidebar).
- **List Builder:** Marketplace-icon nav → **Sumble Enrichment** → app home.

## Backend API

| Endpoint | Body | Returns |
|---|---|---|
| `GET /health` | — | `{status:"ok"}` |
| `POST /api/enrichment` | `{ companyId, want?: "all"\|"people"\|"brief", cachedOnly? }` | cached enrichment: people (SDR/AE) + counts, brief, deep-links, mode |
| `POST /api/refresh` | `{ companyId, want? }` | same, cache-bypass (spends credits) |
| `GET /api/hubspot-company-lists` | — | the account's COMPANY lists (List Builder source) |
| `GET /api/sumble-lists` | — | existing Sumble org lists (cached 5min) |
| `POST /api/push-to-sumble-list` | `{ hubspotListId, sumbleListId?\|newListName? }` | reads HubSpot list members → bulk-adds by slug → `{added, skippedNoSlug, listId}` |
| `POST /api/add-to-sumble-list` | `{ slugs[], sumbleListId?\|newListName? }` | per-company add by slug |

`cachedOnly` defaults true on `/api/enrichment` — auto-load never spends credits; the card sends `cachedOnly:false` on an explicit click.

## Verified against the live Sumble API ✅

All endpoints verified end-to-end (Upwork = AE top-up, Jobgether = jobs fallback, "Test HS Integration list" = 126-company push):

- **People Find** — `POST /v6/people/find`, `organization.domain` + `filters.job_functions` + `filters.job_levels`; total in `people_count`. No per-person lead score (column omitted). AE filter = `job_functions:["Account Executive"]` + same IC levels.
- **Jobs Find** — `POST /v6/jobs/find`, `filters.query: "job_function EQ '…' AND hiring_period EQ '1yr'"`; fields `job_title`, `location`, `primary_job_function`, `datetime_pulled`, `url`.
- **Organizations Match** — `POST /v6/organizations/match`, `organizations:[{url}]`; org id at `results[0].match.id`.
- **Intelligence Brief** — `GET /v6/organizations/{orgId}/intelligence-brief`; `202` + `Retry-After` while generating (free), then `body` (markdown) + `sumble_url`.
- **Org lists** — `GET /v6/organization-lists` (lists under `organization_lists`, 1cr/list), `POST /v6/organization-lists` (create, free), `POST /v6/organization-lists/{id}/organizations` (add by `organization_slugs`, free, de-duped server-side).

Endpoint paths/fields are isolated at the top of `backend/server.js` if Sumble revs the API.

## Credit safeguards

- Sales Org & Fit: **0** (synced props).
- Sellable Seats & Brief: **click-gated** — viewing a record spends nothing; the rep clicks Load/Generate to spend.
- Caching: people 30d (matches Sumble's ~monthly refresh), brief until manual refresh, org match 30d, Sumble-lists dropdown 5min. Durable in Render Postgres → spent once per company per TTL.
- Lists: create + add are **free**; only loading the existing-lists dropdown costs ~1cr/list.

## Notes

- App logo set via `app-hsmeta.json` `logo: "/app/logo.png"` (srcDir-absolute path) → the app icon in Connected Apps / app home.
- Sumble lists filter **Organization** search in the web app (not people/jobs search) — so a pushed list is a saved segment you work via org search, sorted by Sumble score.

## License

MIT
