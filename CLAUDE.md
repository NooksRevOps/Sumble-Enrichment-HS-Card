# Sumble Enrichment — HubSpot app · working context

> Handoff/state doc so any session can continue without the original chat. Pair with `README.md` (full architecture) and the user memory file `hubspot-sumble-trial-apps.md`.

## What this is
A private HubSpot project app (platform 2025.2) that surfaces Sumble enrichment in HubSpot. Sibling app: `../Trial-Skip-Deal-Card`. HubSpot portal **21261434**. Repo: `github.com/NooksRevOps/Sumble-Enrichment-HS-Card` (public — Render couldn't fetch private NooksRevOps repos).

## Live infra
- Render web service `sumble-enrichment-backend` → https://sumble-enrichment-backend.onrender.com (auto-deploys on push to `main`).
- Render Postgres `sumble-enrichment-cache` (DATABASE_URL).
- Backend env vars: `HUBSPOT_SERVICE_KEY` (scopes: crm.objects.companies.read + crm.lists.read), `ENCRYPTION_KEY` (AES-256-GCM at-rest for stored Sumble key — **may not be set yet**), `ALLOWED_PORTAL_ID` (optional single-tenant guard), `SUMBLE_API_KEY` (optional fallback), `DATABASE_URL`.

## Components (all deployed via `hs project upload`)
- `src/app/cards/SumbleSalesOrgCard.jsx` — synced-props card (free). location crm.record.tab.
- `src/app/cards/SumblePeopleCard.jsx` — "Sellable Seats": SDR→AE top-up→SDR job-postings cascade. Click-gated.
- `src/app/cards/SumbleBriefCard.jsx` — AI intelligence brief. Click-gated ("Generate").
- `src/app/cards/SumbleAddToListCard.jsx` — per-company add to a Sumble list. sidebar.
- `src/app/pages/SumbleListBuilder.jsx` — app home page: push a HubSpot company list → Sumble org list.
- `src/app/settings/SumbleSettings.jsx` — admin connects Sumble (key validated + stored encrypted per-portal).
- `src/app/app-hsmeta.json` — app config; `logo: "/app/logo.png"` (srcDir-absolute path — NOT relative).

## Auth / key model
Backend resolves the Sumble key per request: **stored per-portal key (encrypted, from Settings) → `SUMBLE_API_KEY` env fallback**. All cards/page pass `portalId` (from `context.portal.id`) so resolution works. `db.js` has `setSecret/getSecret/deleteSecret` (AES-256-GCM via ENCRYPTION_KEY). Sumble has **no OAuth** (API-key only) — connect = admin pastes key in Settings.

## Backend endpoints (`backend/server.js`)
`/health` · `/api/enrichment` (people+brief, cachedOnly default true = no-credit auto-load) · `/api/refresh` · `/api/hubspot-company-lists` · `/api/sumble-lists` (returns creditsRemaining) · `/api/push-to-sumble-list` · `/api/add-to-sumble-list` · `/api/sumble-connection` (GET/POST/DELETE) · `/api/segment-report` · `/api/push-log`.

## Verified Sumble API facts
- `POST /v6/people/find` (job_functions + job_levels; total in `people_count`; **no per-person lead score**). AE = `Account Executive` + IC levels.
- `POST /v6/jobs/find` (`filters.query: "job_function EQ '…' AND hiring_period EQ '1yr'"`).
- `POST /v6/organizations/match` (org id at `results[0].match.id`; takes `url` not domain).
- `GET /v6/organizations/{id}/intelligence-brief` (202+Retry-After while generating; body=markdown).
- Org lists: `GET/POST /v6/organization-lists`, `POST /v6/organization-lists/{id}/organizations` (slugs; **Sumble de-dupes**; create+add are FREE). List array under `organization_lists`; envelope has `credits_remaining`.
- Lists filter **Organization** search only (not people/jobs). Deep-link: `sumble.com/orgs?sort=Sumble+score&desc=1&lists={id}`.

## Credit safeguards
API cards are **click-gated** (viewing a record spends nothing). Durable Postgres cache: people 30d, brief until manual refresh, org match 30d, sumble-lists 5min. Create/add-to-list are free.

## ⏳ CURRENT IN-FLIGHT STATE (as of commit 5324f62)
Building home-page features 1–4 (user approved; chat copilot deferred). Status:
- ✅ **Backend done & committed (5324f62), deploys on push:** `/api/segment-report` (feat 1+2, free synced-prop aggregate: total/matched/match-rate/IC SDR+AE+total sums/avg fit/segment dist/hiring count), push log (feat 3), credit capture (feat 4).
- ⬜ **NOT done — the home-page dashboard UI** that consumes these. Plan: restructure `SumbleListBuilder.jsx` into `Tabs` — "Build list" (existing) / "Segment report" (call `/api/segment-report` for the chosen HubSpot list; show seat totals + coverage) / "Recent activity" (`/api/push-log`); show `creditsRemaining` in the header. Pass `portalId` everywhere. The list builder should also send `hubspotListName` + `sumbleListName` to `/api/push-to-sumble-list` so the log is readable.
- ⬜ **Feature 6 (custom workflow action "Flag SDR-seat mismatch")** — NOT started. First verify the 2025.2 `workflow-actions` component format (see `HubSpot/hubspot-project-components` repo, `2025.2/components/workflow-actions`) AND that the portal's hub tier supports custom workflow actions. It's inherently opt-in (toggleable). Build only if viable; else report back.
- 🔭 **Chat "Sumble copilot" — deferred, needs decisions** (own LLM provider + key, per-question/daily cost+credit ceiling, card vs home placement). Not in current scope.

## Build / deploy
```
cd /Users/charliewiebe/Sumble-Enrichment-HS-Card
hs project upload            # deploy cards/page/settings to HubSpot (portal 21261434)
git push                     # → Render auto-deploys backend
node --check backend/server.js   # syntax-check before deploy
```
Verify backend after deploy: `curl https://sumble-enrichment-backend.onrender.com/health`.

## Gotchas
- Shell cwd resets between Bash calls — always `cd` into the repo first (esp. before `hs`/`git`).
- Component UI props: inspect real types at `src/app/cards/node_modules/@hubspot/ui-extensions/dist/shared/types/components/*.d.ts` — don't guess. Distance tokens: flush/extra-small/small/medium/large/extra-large. Button/Link href = `{url, external:true}` (and DON'T add a manual ↗ — HubSpot renders its own external icon). No native chat/markdown component.
- `hs project upload` must run from the repo root; it warns about `~/.hscli/config.yml` being git-trackable — ignore (it's outside the repo).
- Both this app + Trial-Skip need the HubSpot **granular-permissions migration** before late July 2026.
