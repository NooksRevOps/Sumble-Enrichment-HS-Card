# Sumble Enrichment — HubSpot Custom Cards

Three HubSpot company-record cards (one private app) that surface Sumble's enrichment depth directly in HubSpot, so reps don't have to tab-switch to the Sumble web app.

| Card | What it shows | Sumble credits |
|---|---|---|
| **Sumble · Sales Org & Fit** | Beautifully formatted view of the synced `sumble_*` properties: Nooks fit score, sales segment, **IC SDR / IC AE seat counts**, GTM org breakdown, growth + hiring signals, B2B/B2C/AI-native, lead-gen tools. | **0** — reads HubSpot properties only |
| **Sumble · SDR People** | The named IC-SDR people behind the synced count (live from Sumble), reconciling synced vs. live count so reps can verify RevOps' sellable-seat sizing. | ~1 / person (cached 24h) |
| **Sumble · Intelligence Brief** | Sumble's AI account brief (angle, who to contact, the intel). Auto-loads, polls while generating, renders to formatted sections. | ~50 / brief (cached 7d) |

> **Why not iframe the Sumble page?** Sumble serves `X-Frame-Options: DENY` + `frame-ancestors 'none'`, a hard browser ban on embedding. So we pull the data via Sumble's REST API and deep-link out for the full experience.

## Architecture

```
HubSpot Company record
  └─ 3 UI-extension cards (crm.record.tab)
        │ hubspot.fetch
        ▼
  Render web service `sumble-enrichment-backend` (Express)
        ├─ Bearer SUMBLE_API_KEY      → api.sumble.com (REST)
        ├─ Bearer HUBSPOT_SERVICE_KEY → HubSpot CRM (read company props)
        └─ DATABASE_URL               → Render Postgres (durable per-org cache)
```

The **Sales Org & Fit** card needs no backend — it reads synced HubSpot properties directly. The other two call the backend, which proxies Sumble and caches every response per org so credits are spent once per company per TTL, not on every view.

## Live resources

- GitHub: `NooksRevOps/Sumble-Enrichment-HS-Card`
- Render web service: `sumble-enrichment-backend` → https://sumble-enrichment-backend.onrender.com
- Render Postgres: `sumble-enrichment-cache`
- HubSpot project/app: `sumble-enrichment-card` / `sumble-enrichment-app` (portal 21261434)

## Setup

### 1. Sumble API key
Create at **sumble.com/account/api-keys**. Copy it (shown once).

### 2. HubSpot Service Key
HubSpot **Settings → Integrations → Service Keys** → new key, scope **`crm.objects.companies.read`**. Copy it.

### 3. Render env vars
On the `sumble-enrichment-backend` service → **Environment**:
- `SUMBLE_API_KEY` = your Sumble key
- `HUBSPOT_SERVICE_KEY` = your HubSpot Service Key
- `DATABASE_URL` = use **"Add from Database" → sumble-enrichment-cache → Internal Database URL** (auto-injects; no copy-paste)

Render redeploys automatically. Health check: `curl https://sumble-enrichment-backend.onrender.com/health`.

> The backend runs even without `DATABASE_URL` (falls back to a non-durable in-memory cache), but set it so the cache survives restarts and protects credits.

### 4. Install the app + add the cards
```bash
hs project upload          # already done for build #1
```
Then in HubSpot: open the project (`hs project open`) → **sumble-enrichment-app** → **Distribution → Install**. Approve the `crm.objects.companies.read` scope.

Add cards to the company record: open any company → **Customize record** → drag **Sumble · Sales Org & Fit**, **Sumble · SDR People**, and/or **Sumble · Intelligence Brief** into the middle column.

## Backend API

| Endpoint | Body | Returns |
|---|---|---|
| `GET /health` | — | `{status:"ok"}` |
| `POST /api/enrichment` | `{ companyId, want?: "all"\|"people"\|"brief" }` | cached enrichment: SDR people + counts, brief markdown, deep-links |
| `POST /api/refresh` | same | same, but bypasses cache (spends credits) |

## ⚠️ Verify against the live Sumble API

Sumble's published response schemas are thin. The endpoint paths + response field names are isolated at the top of `backend/server.js` and parsed defensively, but **must be confirmed** with a real key:

- `SUMBLE_PEOPLE_FIND_PATH` = `/v6/people/find` — confirm `filters.job_functions`/`job_levels` accept the exact strings, and that the total lives in `people_count`.
- Whether a per-person **Sumble Lead Score** is returned (the SDR People table shows the column only if present).
- `SUMBLE_BRIEF_PATH` / `SUMBLE_ORG_MATCH_PATH` — confirm exact paths + the brief's markdown field + `sumble_url`, and the 202-pending shape.

Quick check once the key is set:
```bash
curl -s https://api.sumble.com/v6/people/find \
  -H "Authorization: Bearer $SUMBLE_API_KEY" -H "Content-Type: application/json" \
  -d '{"organization":{"domain":"fivetran.com"},"filters":{"job_functions":["Sales Development Representative"],"job_levels":["Individual Contributor","Senior","Lead","Principal"]},"limit":10}' | jq
```

## Phase 2 (not built yet)

Push HubSpot companies into Sumble organization lists (free add-to-list) — an App Page for bulk-from-a-HubSpot-list, plus a per-company "Add to Sumble list" button. See the project plan.

## License

MIT
