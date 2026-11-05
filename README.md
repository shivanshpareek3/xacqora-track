# Xacqora Track

Lead tracker & attribution CRM. For every lead it shows which ad brought them in,
every ad they clicked after that, where they stand in the funnel, and whether they paid.
It pulls Meta spend and sends real outcomes back to Meta through the Conversions API.

This repo is a **zero-dependency demo build** (Node 24 + built-in `node:sqlite`), built
from the "Xacqora Track: Product Requirements" doc. Every module in Section 5 of the doc
has a working implementation; the Meta spend pull and CAPI push run in a mock/dry-run
mode so no live tokens are needed. Wire in the real Meta + gateway calls where marked.

Storage is dual-engine (Phase P): **SQLite** (Node built-in, the zero-dependency default
for local dev + tests) and **Postgres** (`DATABASE_URL` set) with row-level security on
every client-bearing table. On Postgres the dump/restore path runs as the superuser
`xacq_backup` role (`PG_BACKUP_USER`) because RLS-forced tables can't be dumped by the
non-superuser app role. See `CHANGELOG.md` (Phase P) and `docs/auth-security.md`.

## Run it

```bash
npm run seed     # one-time: users, 2 clients, 2 ad accounts, sample leads
npm start        # http://localhost:4100/signin   (password: xacqora)
```

**`.env` (local dev)** — copy `.env.example` → `.env` and fill it. Real secret
values (Meta token, Postgres URL, AES key) come from your secret manager and are
**never committed** (`.env` is gitignored; `.env.example` is the committed
template). The app loads `.env` on startup; real env vars always win. For a live
Meta spend pull, fill only the `META_*` values — see
[docs/meta-live-connect.md](docs/meta-live-connect.md) (the 3-point
"what to grab from Meta" list + the live-pull test).

Demo users (all password `xacqora`):

| email | role |
|---|---|
| owner@xacqora.local | owner |
| arpit@xacqora.local | media_buyer |
| rep@xacqora.local | sales_rep |
| client@xacqora.local | client (read-only portal, client 1 only) |

Tracking test target: `http://localhost:4100/demo?utm_source=facebook&utm_medium=paid&utm_campaign=CAM-101&fbclid=IWD&campaign_id=CAM-101&adset_id=ACT-100001-111&ad_id=ACT-100001-3001`

## Screens (all 14 from Section 5.E)

Dashboard, Leads, Lead timeline, Pipeline (kanban + list), Reports, Meta hub,
Integrations, Duplicates, Client portal, Import, Admin (users/roles/audit),
Sign in, Meta spend, Weekly summary.

## What's wired

- **Tracking (`xt.js`)** — `<10 KB`, first-party visitor cookie, fbc from fbclid,
  auto-fills hidden form fields, appends attribution to outgoing links, queue + retry.
- **Ingest API** — `/api/ingest/<platform>` with per-endpoint secret + rate limit.
  Every inbound payload is logged (`webhook_log`) with processed / failed / duplicate status.
- **14 platform adapters** — Meta leadgen, TagMango, Razorpay, Cashfree, Cosmofeed,
  Aevent, Zoom, Calendly, FlexiFunnels, Pabbly, WhatsApp, Google Sheets/CSV.
- **Identity** — phone normalised to `+91…` (E.164), match on phone then email,
  anonymous visitor touchpoints attach to the lead on form fill, never merge across clients.
- **Events + pipeline** — every action is an event on the lead timeline;
  auto stage moves (`webinar_joined -> Attended`, `payment_success -> Paid`, …).
- **Meta pull** — scheduled ad account pull (spend + entities), mock generator when no token.
- **Real-data dashboard + DATA_MODE (v9)** — dashboard/reports centre on the real
  ad accounts (`act_…`, 7d/30d KPIs in INR + billing currency, top campaigns/ads,
  30-day trend, pull status + "Pull now"; ROAS shows "N/A — pilot live" until
  revenue is real). `DATA_MODE` (`demo` default locally, `live` in prod) hides the
  seed fixtures in live mode, with the yellow demo band on / off and clean empty
  states; admin toggle is audit-logged. See `docs/dashboard-real-data.md`.
- **CAPI push** — hashed phone/email, fbc/fbp, deterministic `event_id` for dedup;
  never sends twice, suppresses Purchase on refund, records Event Match Quality.
- **Attribution** — last paid click (default, 30d), first click, linear, lead source;
  window editable per client. Reports: funnel, ad performance, wasted spend,
  new vs old, Meta vs Xacqora Track, source mix, weekly summary.
- **Security** — session auth, roles, masked phones for roles without need,
  audit log, privacy deletion that stops future CAPI.

## Module docs (the context contract for every AI session)

- `docs/tracking-script.md` — xt.js: what it does, size, how to test queue+retry
- `docs/webhooks-adapters.md` — ingest API, all 14 adapters, dedup + log rules
- `docs/identity.md` — phone normalisation, matching, duplicate merge, deletion
- `docs/meta-spend-capi.md` — spend pull + CAPI push (dedup, hashing, PRD rules)
- `docs/reports-attribution.md` — 4 models, 7 reports, settings keys
- `docs/auth-security.md` — roles, masking, client isolation, audit
- `docs/pilot-tooling.md` — Phase G: CSV import, URL checker, gate suite, accuracy checkers
- `docs/pilot-live-checklist.md` — live-pilot runbook (who/where/pass-fail per step)
- `docs/deploy.md` — Phase H: Vercel + managed Postgres (Mumbai), env vars, staging, monitoring, prod verify
- `docs/frontend-tour.md` — Phase F: the /app SPA, dashboard→portal walk-through, screenshots + the demo-data label
- `docs/meta-live-connect.md` — Meta live connect (pull only, CAPI dry-run): the 3-point "what to grab from Meta" list, `.env`→DB token bridge, live-pull test + ≤1% spend gate, `/alerts` token-expiry + friendly failure lines
- `docs/dashboard-real-data.md` — v9+v10: where every dashboard number comes from, DATA_MODE resolution + live/demo semantics, empty-state copy, and the dev-DB hygiene model (v10: the sweep runs on a scratch DB + the `__sweep_test` marker guard, so test runs never dirty the dev DB)

## Tests

```bash
npm test        # replays each sample payload through the live ingest API on a throwaway DB
npm run tracker # demo landing page target
bash test/sweep.sh     # 14 screens + isolation + masking + 2FA + export + rate-limit + backup gates.
                       # v10: runs on a throwaway scratch DB + its own server (SQLite file or PG
                       # scratch database, dropped on exit) — it can NEVER write to the dev DB.
# dev-DB hygiene (v10):
node scripts/clean-test-artifacts.js       # dry-run: list the all-NULL sweep-artifact leads (id>126,
                                           # no deals/touchpoints, degenerate events)
node scripts/clean-test-artifacts.js --delete  # backup first, then delete them (idempotent)
node scripts/live-screenshots.js           # 5 owner screenshots of the RUNNING live server ->
                                           # docs/screenshots/v10-live-*.png (for Arpit / the manager)
node test/security.js  # AES-GCM secrets, RFC 6238 TOTP vectors, rate limit, client-access rules
node test/isolation.js # DB-layer client-isolation proof: canary renders + query-dump audit
node test/xt-queue.js  # xt.js survives the API being down (nothing lost)
node test/liveapi.js   # Razorpay/Cashfree gateway signatures (verified spec)
node test/gates.js     # Phase G pilot tooling: CSV import, URL checker, G1–G4, accuracy checkers
node test/metalive.js  # Meta live-connect bridge: .env->DB token sync, liveMode gate, CAPI dry, /alerts signals
node test/datamode.js  # DATA_MODE: resolution, admin toggle, demo empty-predicates, live seed-only exclusion, KPI aggregation

# backups (Phase S / PRD §10)
node scripts/backup.js      # WAL-safe VACUUM INTO snapshot -> backups/ (keep 7)
bash scripts/restore-drill.sh  # restore newest snapshot to a fresh dir, assert table counts

# Phase H: production prep
bash scripts/staging.sh     # prod-mirror config on a throwaway PG db: full suite + sweep + backup/restore
bash scripts/prod-verify.sh # Phase S checklist re-verified on the prod Postgres cluster (runbook in docs/deploy.md)
```

`test-samples/*.json` are saved sample payloads (fake data — never real client data).

## Notes / open decisions (from the doc)

- Final product name, pilot accounts, product owner / lead dev names, hosting budget,
  attribution default, and whether client sales reps log calls are still Arpit's calls.
- The real Meta/gateway SDK calls still run behind the mock/dry-run layer (opt-in live,
  Phase L); Postgres + row-level security is done (Phase P).
