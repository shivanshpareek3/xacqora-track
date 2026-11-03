# CHANGELOG

Every completed task lands here so the next AI session has context. Newest first.

## 2026-11-03 (Meta live connect — pull only, CAPI dry-run; .env bridge)

The task asked for "fill the .env Meta section and be done." Reading the code
first (task rule: code is the authority) revealed the token is **not** an env
var the pull path reads — it is stored **per ad account** in
`meta_ad_account.token` (encrypted at rest via `security.encryptSecret`,
keyed by `XACQORA_SECRET_KEY`), and the only live-mode env var is
`XACQORA_LIVE` (+ `MOCK`). So a bare `.env` with `META_ACCESS_TOKEN=` would do
nothing. This task wires the missing bridge so the requested workflow works.

### What landed
- **`.env` (gitignored, `git check-ignore` passes)** — copy of the
  `.env.example` template with a **META LIVE** section: `META_ACCESS_TOKEN`,
  `META_AD_ACCOUNT_IDS` (comma-separated `ACT_` ids), optional
  `META_PIXEL_ID`/`META_AD_ACCOUNT_NAME`/`META_CLIENT_ID`; each with a
  "kahan se milega" comment. Prod placeholders (Postgres URL, `PG_BACKUP_USER`,
  `XACQORA_SECRET_KEY`) left empty until cutover. Real values never committed
  and never pasted into chat.
- **`server/lib/env.js`** — zero-dep `.env` loader (the app had no dotenv).
  Fills `process.env` only for keys not already set, so real env / Vercel
  dashboard vars always win. Loaded first in `server/index.js`.
- **`server/lib/metalive.js`** — the **env → DB bootstrap**:
  `syncMetaAccountsFromEnv` upserts `meta_ad_account` rows (token **encrypted**
  at rest, `status='connected'`, pixel) for each id in `META_AD_ACCOUNT_IDS`;
  a blank `.env` is a no-op (dev stays mock). Also `classifyMetaError` (401 →
  "regenerate token"; 200/permission → "assign the account"; network →
  "retries with backoff") and `metaTokenExpiry` (expired / expiring-within-48h
  flags from a new `meta_ad_account.token_expires_at` column).
- **`server/index.js`** — calls the bootstrap on startup (`[meta-live] …` log
  line when values are present).
- **`server/schema.sql` + `schema.pg.sql` + `db.js`** — additive
  `meta_ad_account.token_expires_at TEXT` (idempotent migration for live DBs).
- **`/health` + `/alerts.html`** — a "Meta token expiry" signal row + friendly
  (classified) Meta-pull-failure lines, so a bad token is actionable, not a
  raw dump.
- **`scripts/meta-validate.js`** — offline-safe. No token → prints the 3-point
  "grab-from-Meta" steps and exits 0. With a token → `GET /me` + `/me/adaccounts`
  (lists accessible `ACT_` ids, flags any not in `META_AD_ACCOUNT_IDS`) +
  `/debug_token` (prints `expires_at`, records it on the account rows for the
  `/alerts` warning).
- **`test/metalive.js`** (both engines) — env→DB upsert + encrypted-at-rest +
  idempotent re-sync; blank `.env` no-op; `liveMode()` `XACQORA_LIVE`/`MOCK`
  gating; **CAPI dry-run by default**; error-classifier + expiry signals.
- **Docs** — `docs/meta-live-connect.md` (architecture, 3-point list, live-pull
  test + ≤1% spend gate, the CAPI dry-run rule); `.env.example` + `README.md`
  get the "create `.env` for local dev (values from your secret manager), never
  commit" line; test + module-doc entries in the README index.

### CAPI stays dry-run (explicit task rule)
No code change flips it on: the gate is `settings.capi` (seeded `dry`) re-checked
by `liveMode()` + a real row token. Keep `settings.capi='dry'` (the alerts
screen's toggle) — live CAPI is a pilot-cutover step only.

### Live-pull test (task 3, human + real data)
Not run here — needs a real token + network (never in chat). Runbook is
`docs/meta-live-connect.md`: fill `.env` with **one** `ACT_`, set
`XACQORA_LIVE=1` + a real `XACQORA_SECRET_KEY`, restart, watch `/alerts` +
`/meta.html → Pull now`; pass = `spend_daily` rows, spend within **≤1%** of
Meta Ads Manager, and Reports → Meta-vs-Track showing real conversions. Add
the other accounts once the first is green.

### Verification
`test/metalive.js` + the full existing suite green on BOTH engines (SQLite:
8 suites incl. `metalive` PASS + server boot no-op confirmed; Postgres:
provision + all suites incl. `metalive` + replay + sweep, in progress at
commit time). **Commit is code/docs/tests only — `.env` is never committed.**

## 2026-11-03 (Phase F close-out — polished SPA, dual-engine green, tour + screenshots)

Closed out the Phase F frontend (the SPA the Phase F session built in-tree but
had not committed/verified on Postgres). Green on BOTH engines: 7 backend
suites + the headless `test/spa.js` (42 assertions: role-aware masking,
client scoping, 403 on team-only endpoints) + replay + sweep = 0 failures on
SQLite and on a clean Postgres re-provision.

### What landed
- **Demo-data banner (master v7 §1.4/§6)** — an honest "Demo data — the live
  pilot will show real numbers" band on every screen, in BOTH UIs:
  - classic screens: `layoutDemoBand()` in `server/lib/shared.js` (a yellow
    band under the nav).
  - SPA: the API's `me` now returns `demo: !liveapi.liveMode()`, and the SPA
    chrome renders the band only when `demo` is true.
  - The band is **mode-driven, not static**: it shows in mock mode and
    disappears automatically the moment `XACQORA_LIVE=1` flips the build to
    real gateways/Meta — so a screenshot taken live is unambiguously real.
- **SPA data-layer fixes (found while screenshotting):**
  - `renderDashboard` never called `clear(main)` after the API resolved, so a
    stuck "Loading…" card sat above the dashboard. Fixed.
  - The `h()` DOM helper in `public/app/ui.js` had no `selected` handling and
    option elements passed `'selected'` as a child (rendered as literal text
    "…(default)selected") plus no attribute, so every `<select>` silently fell
    back to its first option (Window showed "7d" while the banner said "30d").
    Added a `selected` case to `h()` and converted all 10 option call-sites to
    `selected: <cond>` in attrs.
- **Deterministic demo seed** (the Phase F session's `scripts/seed.js`): 26
  leads across every stage, 8 deals (incl. refunds + a failed payment),
  ad-click touchpoints, Meta campaigns/adsets/ads for 2 accounts, 14 days of
  per-ad spend, CAPI log, webhook log, and a duplicate pair — all via
  `rnd(seed)` so both engines show identical numbers and every screen is
  populated on a fresh open (no empty states).
- **Tour + screenshots** — `docs/frontend-tour.md` (open-it, the
  dashboard→portal walk-through, role-aware/honest-label notes, file map) and
  `scripts/screenshots.js` (zero-dep CDP driver over the cached headless
  Chrome + Node 24's built-in WebSocket; captures the 5 pilot screens as
  `docs/screenshots/shot-*.png`). Two `/reports` crops are made distinct by
  document-offset `clip` (the headless shell's clip is document-anchored and
  ignores scroll, so the ad-performance crop targets the per-ad card's Y).
- **Provisioner idempotency fix** — `scripts/pg-provision.sh`: `CREATE ROLE`
  has no `IF NOT EXISTS` clause in Postgres, so a re-run on a cluster where
  the backup role survives the db drop failed. Now drop-then-create (the
  backup role is dump-only and holds nothing of its own, so dropping is safe).

### Honest note for the pilot (master v7 §6)
Every number on these screens is demo data until the §6 decisions + prod
cutover happen; the demo-data band is the thing to show alongside any
screenshot. After this: pilot cutover is a ~30-min task the moment Arpit's
§6 answers (name, 3–4 clients, owner/dev, hosting budget, default
attribution, call-logging, live-secret owner) land.

## 2026-11-03 (Phase H — production hosting prep)

Production-ready prep: Vercel + managed Postgres (Mumbai) one-command deploy,
staging prod-mirror gate, monitoring, prod security re-verify. Green on BOTH
engines after (all 7 unit suites + replay + sweep 0 failures); `scripts/staging.sh`
run green end-to-end on a throwaway PG db; `scripts/prod-verify.sh` passes every
check except owner-2FA (expected — that's the pre-cutover gate, not a dev check).

### 1. `/health` JSON + `/alerts.html` screen (`server/lib/health.js` + `screens.alerts`)
- **`GET /health`** (public, no-store) — `ok`, `engine`, `ts`, mode flags
  (live/mock/`secret_key_set` via new `security.keySecure()`/CAPI/meta-business-
  verified/xt subdomain), and the five PRD §11 signals: webhook failures 24 h,
  queue age >10 min (engine-agnostic — keyed off the `job.next_run_at` epoch
  column), Meta pull failures (`meta_ad_account.last_error`), CAPI stuck-unsent
  events, last daily backup + latest backup file.
- **`/alerts.html`** (team-only, 403 for client — swept) — signal board with
  PASS/ALERT pills, recent webhook-failure rows, prod toggles (Meta business
  verification flag + CAPI live/dry flips, both audit-logged), xt.js subdomain
  display. New POST routes `/alerts/meta-verify` + `/alerts/capi`.
- `security.js` gains `keySecure()` so the "secrets prod-only" check is
  meaningful (the insecure dev fallback is now a visible red pill, not silent).

### 2. Serverless-safe app + Vercel wiring (`api/index.js`, `vercel.json`)
- `server/index.js` refactored: the request handler is `handleRequest` (exported),
  `server.listen` runs only when the file is the entry point (`require.main`) —
  so `api/index.js` (one line: `module.exports = require('../server').handleRequest`)
  is the Vercel function and the `node:http` req/res shapes match natively.
- **Vercel Cron → `POST /admin/tick`** every 5 min (gated by the
  `XACQORA_TICK_SECRET` header, timing-safe compare) replaces the in-process
  ticker on a scale-to-zero host; `XT_DISABLE_TICKER=1` turns the interval off
  (self-hosted `npm start` keeps the interval, endpoint optional there).
- `vercel.json`: catchall rewrite → `/api`, 60s maxDuration, the cron entry.

### 3. Staging gate (`scripts/staging.sh`)
- Throwaway `xacqora_staging` PG db (fake data only — privacy rule), prod-mirror
  config (pg engine + generated `XACQORA_SECRET_KEY` + prod rate limits) →
  full backend suite (reports/security/liveapi/xt-queue/isolation/gates) +
  replay + sweep + backup/restore drill. `STAGING PASS` = prod will mechanically
  pass. **Run and green this session.**

### 4. Prod security re-verify (`scripts/prod-verify.sh`)
- Phase S checklist against the prod cluster, read-only: engine=pg, FORCE RLS
  binding (scoped conn sees only its client), `XACQORA_SECRET_KEY` set
  (prod-only secrets), owner 2FA enrolled, audit_log live, daily backup +
  monthly restore drill on THIS cluster, `/health` clean (when `APP_URL` set),
  prod toggles state. `PROD VERIFY PASS` is the entry condition for the
  live-pilot cutover.

### 5. Deploy doc + env reference (`docs/deploy.md`, `.env.example`)
- Topology (Vercel function + Mumbai Postgres + `track.` subdomain for xt.js on
  CSP pages), role design (non-super `xacq_app` binds FORCE RLS; super
  `xacq_backup` dump-only), full env-var table with prod values, the `vercel
  deploy --prod` one-command sequence, rollback (additive schema = both
  directions boot), and the 4-step live-pilot cutover (LIVE flag, secrets,
  `capi=live`, prod-verify + checklist).

### 6. Test wiring
- `test/sweep.sh` gains: `/alerts.html` (owner 200, client 403) + `/health`
  (200, `ok:true`, all five signal fields present).

**Done per the fast-track:** deploy docs + staging config + monitoring
committed; one command can prod-deploy once the budget decision (Arpit §6)
lands. Next session: Phase F frontend upgrade.

## 2026-11-03 (Phase G — pilot gates tooling)

Pilot-ready self-verification on fake/pilot-mock data, green on BOTH engines
(SQLite + Postgres; `test/gates.js` new, sweep extended with `/pilot` 200/403).

### 1. CSV import of old leads (`server/lib/pilot.js` → `importOldLeads`)
- **Column-mapping screen + endpoint** — `/pilot` → CSV import (maps source
  columns to name/phone/email/city/stage/amount/registered/attended/paid_at/
  refund); `/import/csv` now accepts a `csv` string → mapped import. An explicit
  mapping wins; otherwise the header row is **inferred** (`inferMapping`:
  "Full Name"→name, "Mobile"→phone, "Status"→stage, "Paid At"→paid_at, …).
- **E.164 normalisation** — +91 981… / 0981… / bare 10-digit all → `+91…`
  (reuses `shared.normPhone`); unnormalisable numbers kept raw, never dropped.
- **Duplicate skip** — phone-then-email identity match; re-import of the same
  file adds 0 new leads and 0 duplicate deals (idempotent, proven in test).
- **Backfill** — amount → `deal` (gateway `csv`); refund flag → deal created
  then marked refunded (surfaces in the funnel's refunded bucket, net 0);
  registered/attended → events. All audit-logged (`import.csv` with the
  `+imported/matched/skipped/deals` counts).
- **Fixture** — `samples/old-leads.csv` (6 rows covering every path incl. a
  refund).

### 2. Ad URL checker (`pilot.checkAdUrl`)
- Paste a pilot ad destination URL → per-token report: where `{{ad.id}}`
  (error — leads land with NO ad_id ⇒ G1 fails for that ad), `{{adset.id}}`,
  `{{campaign.id}}` (warnings), `fbclid` (info) are missing + missing UTM
  params. Served at `/pilot` → Ad URL checker.

### 3. Gate assertion suite (`pilot.runGates` + `test/gates.js`)
- **G1** Instant Form leads land with an ad_id within 1 min (100% of
  `meta_leadgen` leads + no webhook job stuck pending >1 min).
- **G2** landing leads ad_id/UTM coverage ≥ 95%.
- **G3** same person two forms = one lead (0 phone-duplicate leads).
- **G4** webhook log: 0 unprocessed events > 10 min — keyed off the
  `job.next_run_at` **epoch** column, which `enqueue()` sets identically on
  both engines (webhook timestamps are display-format and differ per engine).
- `test/gates.js` asserts all four on a pilot-mock dataset on both engines;
  also proves CSV import E.164/dup-skip/refund, URL checker, and the accuracy
  checkers. Swept into `test/sweep.sh` (`/pilot` → 200 owner / 403 client).

### 4. Accuracy checkers (pilot month — "paste the export in")
- `revenueVsGateways` — net-of-refunds `deal` total vs gateway settlement,
  **≤ 2%** diff.
- `spendVsMeta` — `spend_daily` total vs Meta Ads Manager export, **≤ 1%** diff.
- `capiQuality` — avg `match_quality` on Purchase ≥ 7 (% ≥7 surfaced).
- `weeklyTiming` — before/after minutes logged to `settings`
  (`weekly_report_time_before_min` / `..._after_min`) + improvement %.
- Routes `/pilot/accuracy` + `/pilot/timing` (team-only, 403 for client role),
  each audit-logged; last accuracy run re-shown on the screen.

### 5. Live checklist (`docs/pilot-live-checklist.md`)
- Step-by-step live-run instructions (who does what, where to check,
  pass/fail criteria): entry conditions (Arpit §6), per-client setup
  (webhooks/secrets/ad URLs/old-lead backfill), the G1–G4 gate run, and the
  weekly accuracy cadence (3.1–3.4). Served in-app at `/pilot-live-checklist`.
- Module README: `docs/pilot-tooling.md`.

**Done criteria met:** gate suite green on the pilot-mock dataset on both
engines + checklist doc committed. Next session per the fast-track:
Phase H (production hosting prep).

## 2026-11-02 (Phase R + Task 1 close)

### Task 1 — gateway-signature close-out
- **Razorpay + Cashfree re-verified against current official SDK source (2026-11-02):**
  Razorpay `X-Razorpay-Signature` = HMAC-SHA256(rawBody, webhookSecret) hex;
  Cashfree `X-Cf-Signature` = HMAC-SHA256(rawBody, clientSecret) hex. Both match
  `server/lib/liveapi.js` exactly — **no code change**; the two earlier "pending"
  markers are gone. Zero pending items for either gateway.
- **5-platform verification batch attempted live, logged UNVERIFIED by policy**
  (`docs/adapter-verification.md`): Aevent / Zoom / Calendly / Pabbly /
  FlexiFunnels docs are unreachable from this environment (JS SPA shells that
  render no body to a plain fetch, 404s on the canonical paths, auth-gated, or a
  hostname that does not resolve; `web_search` returned nothing usable). Each row
  carries the exact reason + a bumped retry date; they fall back to the
  per-endpoint shared-secret check until their native verification is wired.

### Phase R — Reports finish
- **CSV + Excel export on every report** — `/export/<funnel|report|source-mix|
  new-vs-old|meta-vs-track|weekly-summary>` with `?fmt=csv` (default) or
  `?fmt=excel`. Excel is a hand-written zero-dep SpreadsheetML ".xls" writer
  (`server/lib/shared.js` → `toExcel`), not a SheetJS dependency; CSV reuses
  `toCsv`. Both are role-masked (phone/email) for the leads export and every
  export writes an `audit_log` row (`export.csv` / `export.xls`).
- **Every number links to the leads behind it** — the report KPIs, ad-row
  "Leads"/"Revenue" cells, and source-mix chips deep-link to `/leads?ids=…`
  (numeric-only, RLS-safe). `funnelReport` / `adPerformance` / `sourceMix`
  now return `lead_ids` lists; `/leads` accepts `?ids=` as an extra filter with a
  "showing N leads behind a report number" banner.
- **Net-of-refunds revenue everywhere** — `funnelReport` computes a
  `refunded` count and a net revenue (SUM only `status='success' AND
  refunded_at IS NULL`), surfaced as a KPI and in the weekly summary + PDF.
  Regression test in `test/reports.js`: a fully-refunded lead contributes ₹0.
- **Auto weekly client summary (Monday 9 AM IST, zero manual)** — the
  `server/index.js` ticker now writes, in addition to the all-client JSON: one
  PDF per client under `reports/summary-<date>-client<N>.pdf` (zero-dep PDF 1.4
  writer in `server/lib/pdf.js`) and records the path in `settings`; the client
  portal shows the latest weekly-summary card + a `/weekly.pdf` download link.
- **Meta vs Xacqora Track (conversions, per ad + delta)** — the Meta pull
  (`server/lib/liveapi.js`) now requests `conversions,quality_conversions`;
  `server/lib/meta.js` stores them in a new `spend_daily.conversions` column
  (added to both `schema.sql` + `schema.pg.sql` with an idempotent `ADD COLUMN`
  migration in `db.js`); the mock pull synthesizes a plausible value.
  `metaVsTracker` returns per-ad Meta-vs-ours rows with a delta column, rendered
  as a table on the Reports screen and exported via `/export/meta-vs-track`.
- **Tests green on both engines** — `node test/reports.js` (net-of-refunds,
  drill-down lead-id lists, Meta-vs-Track delta, weekly PDF bytes, CSV/Excel
  export shapes) passes on SQLite *and* Postgres (scratch db). Full
  `replay`/`isolation`/`sweep` suites re-run green on Postgres after a clean
  re-provision (sweep 0 failures). `docs/reports-attribution.md` +
  `docs/adapter-verification.md` updated.

## 2026-11-02 (Phase P)

### Phase P — Postgres live engine + DB-level client isolation (RLS)
- **Engine switch on `DATABASE_URL`** — new `server/pg.js` (synchronous `pg-native`/libpq
  facade exposing the same `prepare().get/all/run` + `exec` shape as `node:sqlite`, so the
  ~150 sync call sites stay untouched). `server/db.js` picks: `DATABASE_URL` set -> Postgres
  (live), else SQLite (zero-dep default, still fully green). SQL translation: `?`->`$n`,
  auto-quoting of the reserved `"user"` table, JS-bound ISO-8601 timestamps (no
  `datetime('now')`), `RETURNING id` for `lastInsertRowid`, INT8->Number so `COUNT(*)`
  compares like the SQLite engine.
- **`server/schema.pg.sql`** — full DDL port + RLS on every client-bearing table
  (`ENABLE` + `FORCE ROW LEVEL SECURITY` so it binds the owning role too; the app connects
  as the non-superuser `xacq_app` so the policies actually apply). Default-OPEN model:
  an unscoped/system connection (ticker, queue, pg_dump, bare psql) sees all rows; a
  connection carrying the `app.client_ids` / `app.unrestricted` GUCs is locked to that
  client. Child tables (`event`,`touchpoint`,`task`,`note`,`call_log`) scope via
  `EXISTS(lead WHERE id=lead_id)`; `funnel_stage` via `funnel`.
- **`makeTx(db, user)` RLS backstop** — a client role gets a dedicated connection pinned
  to its own `client_ids`; team roles run unrestricted. Concurrent requests for different
  users never share a session, so their scopes can't bleed. Webhook ingest + the daily
  ticker/queue run system-scoped (`makeTx(db, null)`).
- **Sequence re-alignment** — `alignSequences(db)` (in `server/db.js`) re-points every
  `*_id_seq` to `MAX(id)` after explicit-id bulk loads; the seed and the isolation fixtures
  both call it, so the first auto-id INSERT continues after the last explicit id instead
  of colliding on `deal_pkey` (the bug that broke the razorpay deal row on Postgres).
- **Backup under FORCE RLS** — `pg_dump` by the RLS-bound app role is structurally refused
  ("query would be affected by row-level security policy"), so a dedicated superuser backup
  role `xacq_backup` handles dump/restore (superusers bypass RLS). `scripts/pg-dev.sh` +
  `pg-provision.sh` create it; `server/lib/backup.js` runs `pg_dump` + a restore-verify into
  a scratch db, and the whole backup/restore path honours `PG_BACKUP_USER` (default
  `xacq_backup`). Engine-aware `scripts/backup.js` + `scripts/restore-drill.sh` (SQLite =
  `VACUUM INTO`; Postgres = `pg_dump`/`pg_restore`).
- **Cluster scripts** — `scripts/pg-dev.sh` (fresh dev cluster on 127.0.0.1:5433, run from a
  real terminal: initdb's bootstrap postmaster needs SysV shared memory the app sandbox
  blocks), `scripts/pg-provision.sh` (role/DB/schema/grants + RLS scoping verify),
  `scripts/dbq.js` (engine-aware one-line query runner), `scripts/pg-smoke.js`
  (facade + RLS smoke).
- **Tests green on both engines** — Postgres: `test/replay.js` all pass, `test/isolation.js`
  all pass including the new RLS-enforcement section (bare scans under a client-2 scope
  return only client-2 rows; a cross-client write is rejected by the DB), `test/sweep.sh`
  reports 0 failures, backup/restore-drill restores all six tables with matching counts.
  SQLite (no `DATABASE_URL`): the same suite + `test/security.js` + `test/liveapi.js` all
  stay green.
- **New deps** — `pg` + `pg-native` (libpq, used only on the Postgres path); the SQLite
  default remains zero-dependency.

## 2026-10-30 (Phase S)

### Phase S — Security checklist (PRD §10)
- **S.1 Client isolation at the data layer** — `test/isolation.js` proof: (a) canary
  leads/revenue/ads in two clients, rendered through every screen + every report
  function as client-2's user; no client-1 marker leaks anywhere; `?client=` filters
  cannot widen a client login's scope; cross-client lead routes are refused.
  (b) query-dump: wraps the tx API, captures every data-table statement in the
  scoped reports, asserts lead-table reads carry a client filter, no unscoped
  top-level aggregation, and no FK child lookup touches a foreign client's key.
- **S.2 Secrets encrypted at rest (AES-256-GCM)** — new `server/lib/security.js`
  (`encryptSecret`/`decryptSecret`, master key from `XACQORA_SECRET_KEY`; the
  no-env-key dev fallback is flagged insecure). Meta tokens, webhook endpoint
  secrets and TOTP secrets are now stored encrypted; decrypt-at-read is wired
  in `server/lib/meta.js` (pull + CAPI) and `server/index.js` (ingest secret
  check + live gateway signature verify). Seed writes encrypted blobs.
- **S.3 2FA for team logins (TOTP, RFC 6238)** — `user.totp_secret`/`totp_enabled`
  + a short-lived `tfa_pending` row. Sign-in for a 2FA-enabled account (or a
  team account when `settings.two_factor_enforced=1`) redirects to `/2fa/verify`;
  a correct 6-digit code (±1 step drift, timing-safe, 5-strike lockout) issues
  the session; wrong codes are rejected and audited. Admin screen: enroll /
  disable with an on-screen authenticator-app secret (never in the URL).
- **S.4 Masking + export audit** — `maskEmail`/`roleSeesFullContacts` in
  `shared.js`; phone AND email are masked in every role-conditional view
  (leads, lead timeline, pipeline, portal) for roles without full-contact
  access. New `GET /export/leads` and `GET /export/ report` (CSV, client- and
  role-scoped, phone/email masked for the caller's role) — every export writes
  an `audit_log` row (`export.csv`).
- **S.5 Backups + restore drill** — `scripts/backup.js` (WAL-safe `VACUUM INTO`
  snapshot into `backups/`, keep-7 retention), `server/lib/backup.js` invoked
  once per IST calendar day by the ticker; `scripts/restore-drill.sh` restores
  the newest snapshot into a fresh temp dir and asserts every table opens and
  its counts are sane (exit non-zero on failure).
- **S.6 Ingest rate limits (per-IP + per-endpoint)** — `security.js rateLimit()`
  sliding-window limiter; the public ingest API now 429s a per-IP flood
  (`XT_RATE_PER_MIN_IP`, default 600/min) and a per-endpoint window
  (`XT_RATE_PER_MIN_ENDPOINT`, default 300/min), with `Retry-After`.
- **Tests** — `test/security.js` (AES round-trip + tamper-fail, RFC 6238 TOTP
  vectors + drift window, rate-limit buckets, client-access rules) and
  `test/isolation.js` (S.1 proof). `test/sweep.sh` gains S.4/S.5/S.6/S.3 gates.
- **Bug fixed** — `shared.js adPerformance` scoped path: `meta_adset` has no
  `client_id` column, so ad scoping now goes through `meta_ad.ad_account_id →
  meta_ad_account.client_id`; the unscoped all-ads spend fallback no longer
  runs when a client scope is active (spend could otherwise leak across clients).

## 2026-10-30 (Phase L)

### Phase L (close): gateway signature specs VERIFIED + 2 real bugs fixed
- Verified Razorpay + Cashfree signature specs against **official SDK source**
  (not just docs): both use **HMAC-SHA256** over the raw body, hex-encoded.
  - Razorpay: header `X-Razorpay-Signature`, key = webhook secret
    (`razorpay/razorpay-node` → `validateWebhookSignature`).
  - Cashfree: header `X-Cf-Signature`, key = client secret
    (`cashfree/cashfree-sdk-nodejs` → `verifySignature`).
- **Bug 1 (would have broken all live gateway deliveries):** `liveapi.js` used
  HMAC-SHA512; now SHA256, matching both SDKs.
- **Bug 2:** Cashfree header read as `x-cashfree-signature`; the real header is
  `X-Cf-Signature`.
- `test/liveapi.js` now uses a **real sample-signed payload** per gateway +
  negative cases (tampered body, wrong secret, missing header) + regression
  guards (SHA512 must be rejected; legacy Cashfree header ignored).
- `docs/adapter-verification.md`: VERIFIED vs UNVERIFIED log with source URLs +
  dates. UNVERIFIED (docs not reachable/SPA): Aevent, Zoom, Calendly, Pabbly,
  FlexiFunnels — each with a retry date. They stay on the shared-secret
  endpoint check until wired.
- Scratch probe `test/spec-research.js` kept for re-running the week-1 check.

## 2026-10-29 (later)

### Phase L — opt-in live integration layer
- Added `server/lib/liveapi.js`: `MOCK=1` (dev default) forces mock;
  `XACQORA_LIVE=1` opts into real API calls. Inbound gateway signature check
  (Razorpay/Cashfree HMAC-SHA512, shared-secret for the rest), batched Meta
  Marketing API pull, and a real CAPI POST.
- `runMetaPull` / `pushCapiEvent` now take the live path only when a real
  (non-MOCK) token is configured; failures alert + back off instead of dropping
  the queue (PRD risk rule).
- Ingest rejects unsigned gateway payloads at the edge in live mode.
- New test `test/liveapi.js` (3 checks) — mock skips signatures, live validates
  a correct HMAC and rejects invalid/missing.
- Wrote the 6 module READMEs under `docs/` so the next session has context.

## 2026-10-29

### Verification gate (phase-0 skeleton verified)
- Full page sweep: all 14 screens + demo page + xt.js return 200 as owner; team-only screens 403 for the client role.
- Phone masking verified: client role sees 0 full phone numbers; owner sees all.
- xt.js confirmed 5,894 bytes (< 10 KB limit).
- xt-queue harness (`test/xt-queue.js`): proves events are held in localStorage when the API is down and flush when it returns — nothing lost.
- Replay suite (`test/replay.js`): 15/15 assertions on a fresh DB, including duplicate-payload safety.

### Client data isolation
- Reports, dashboard, leads list and funnel/attribution math now scope by the logged-in user's allowed clients. Client logins can only see their own client's numbers; team roles see all internal clients (filterable).
- Client-1 login verified to see no client-2 leads, ad accounts, or spend.

### Bugs fixed
- Razorpay adapter: was mis-reading nested webhook payload (`payload.event` is a string; entity lives under `payload.payload.payment.entity`). Fix stopped null gateway_txn_ids.
- `getOrCreateLead`: `const p` was re-assigned; lead INSERT had one too few placeholders.
- Touchpoint INSERT had 20 placeholders for 19 columns.
- Meta pixel lookup used the wrong column.
- CAPI push: job payload was missing `client_id`.
- `funnelReport(null)` matched zero leads; now null = all clients, number = one client.
- Seed INSERTs: placeholder/arg count mismatches.

## 2026-10-28

### Initial build (from Xacq-Track.docx PRD)
- Zero-dependency Node 24 + built-in SQLite demo build.
- 13+ table schema, identity rules, 14 platform adapters, webhook queue,
  auto stage moves, Meta spend pull + CAPI push (mock/dry-run), 4 attribution
  models, 7 reports, 5-role auth with masking + audit log, 14 demo screens,
  xt.js tracking script, CSV import, seed + replay tests.
