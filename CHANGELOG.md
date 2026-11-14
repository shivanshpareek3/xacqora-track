# CHANGELOG

Every completed task lands here so the next AI session has context. Newest first.

## 2026-11-14 (v15: Vercel Hobby deploy fix — daily cron, serverless-safe ticker, stable FlexiFunnels URL)

Vercel red box ("Hobby accounts are limited to daily cron jobs. This cron
expression (`*/5 * * * *`) would run more than once per day") was blocking
the Hobby deploy. Fix, without touching app core logic or the local
SQLite/Postgres test paths:

- **`vercel.json`: cron `*/5 * * * *` → `0 0 * * *`** (option A — Hobby-
  legal daily drain to `/admin/tick`). Meta auto-pull is now daily;
  manual "Pull now" still works anytime. (Option B external-cron timer and
  C Vercel Pro are documented, not implemented.)
- **Real-time webhooks on serverless**: with a daily drain a *queued*
  FlexiFunnels event would wait up to 24h. So `handleIngest` +
  `handleTokenWebhook` now process the webhook **inline in the same
  function invocation when `XT_DISABLE_TICKER=1`** (falling back to the
  durable queue on error — nothing is dropped). Local dev + all test
  suites leave the flag unset → the enqueue-only path is byte-identical.
- **Serverless-safe `/admin/tick`** (`tickerCycle({ serverless })`,
  used by `tickEndpoint` when the interval is off): enqueue due Meta
  pulls BEFORE the drain, cap the drain at `XT_TICK_MAX_JOBS` (default
  50) so one invocation fits the function timeout; un-claimed jobs roll
  to the next fire. In-function `pg_dump` and `reports/` PDF file
  writes are skipped on Vercel (ephemeral FS, no pg_dump binary) and
  recorded honestly in audit/settings instead — provider-managed
  snapshots are the Vercel backup.
- **`server/db.js` Vercel guard**: on a `VERCEL` host without
  `DATABASE_URL`, `db.open()` throws at boot rather than silently
  opening an ephemeral SQLite file. `node:sqlite` stays lazy (SQLite-
  branch only) — the Postgres path never loads it.
- **Postgres decision (3.2)**: prod stays on the sync `pg-native`
  facade. `libpq@1.11.0` ships a compiled `addon.node` (node-gyp);
  Vercel builds it at deploy time (`install: true` is set in
  vercel.json — confirm the build log compiles it for the target
  runtime). Documented fallback if that ever fails: swap
  `server/pg.js`'s `require('pg-native')` for a `pg.Pool` sync-shim
  (pure-JS `pg` is already a dependency) — 1-file change, no core
  logic touched.
- **`docs/deploy.md`**: §1 topology + Hobby-cron properties, §2 env
  table extended (`DATA_MODE`, `APP_URL`, `META_ACCESS_TOKEN`,
  `META_AD_ACCOUNT_IDS`, …), §4 deploy steps + new §9 "Hobby cron
  limit & pull-freshness options" (A daily / B external cron timer /
  C Pro) + the **stable public URL for FlexiFunnels** (set `APP_URL`
  to the Vercel URL; dev tunnels retired).

**Verify (done on the host the agent runs on):** all in-process suites
green on SQLite (security / spa 42 / isolation / gates / metalive /
reports / webhook-keys 39); module-load checks pass in both shapes
(local interval ON; `XT_DISABLE_TICKER=1` off + no listen); Vercel
guard throws as intended; vercel.json valid, no sub-daily cron. The
Postgres in-process run needs the dev cluster (`scripts/pg-dev.sh`) —
blocked in the agent sandbox (`shmget` denied; run it in a terminal).

**Still user-side:** set the §2 env vars on the Vercel project
(`DATABASE_URL` incl. `?sslmode=require`, `XACQORA_SECRET_KEY`,
`XACQORA_TICK_SECRET`, `XT_DISABLE_TICKER=1`, `DATA_MODE=live`,
`APP_URL`=Vercel URL, META_* as needed), `vercel deploy --prod`, then
the live smoke test (deploy.md §9 note): `GET /health` 200 · `/app`
loads · sample FlexiFunnels POST → lead in Postgres · paste the two
generated URLs into FlexiFunnels.

## 2026-11-12 (v14.2: Classic UI — "Webhooks & API Keys" screen + sidebar entry)

The v14/v14.1 screen shipped SPA-only (`/app/#/webhooks`). The user's daily
driver is the **Classic UI** (`dashboard.html`, `localhost:4100`), whose
sidebar comes from `S.navFor` — so the option simply didn't exist there
("ab toh webhooks or api key ka option he nhi dikh rha").

Fix:
- `server/screens.js`: new `webhooks(db, user, p)` screen — the classic
  twin of the SPA screen, server-rendered listing (endpoint table with
  pause/resume/revoke/rotate + full-URL copy, API-key table, recent
  inbound events) + the same generate cards (webhook URL + API key) that
  POST to the SAME JSON API the SPA uses (`/api/app/webhooks/*`), so
  audit/RLS/hashing are one code path. Live mode lists only REAL clients
  (demo fixtures excluded, matching v14.1); FlexiFunnels 4-step
  setup guide + dev public-URL notice included.
- `server/lib/shared.js` `navFor`: "Webhooks & API Keys" sidebar item in
  the Integrations group for owner/admin/media_buyer (classic + SPA /me
  both read this function).
- `server/index.js`: `GET /webhooks.html` route (team-only guard).
- `test/sweep.sh`: owner sweep + client-403 list now include
  `webhooks.html`.
- Latent alias bug caught by the smoke render: the classic screen's
  inbound-log query had to alias the table (`webhook_log w`) because the
  live-mode `webhookEx` predicates emit `w.`-prefixed columns.

**Rule of thumb:** any new screen ships in BOTH UIs — the SPA tab AND a
classic `screens.js` page + `navFor` entry + route + sweep gates. The
integrations screen cross-links `/app/#/webhooks`; the new classic screen
cross-links back to integrations.

Tests: all in-process suites green (SPA 42/42, security, webhook-keys
39 checks) + classic-screen smoke render vs a scratch copy of the dev DB
(live mode: real clients only, generate/guide/key sections present).

## 2026-11-12 (v14.1: real clients only in live mode + prominent webhook generation)

User pushback on the v14 screen: it still listed the SEED demo clients
("Coach Ravi — Webinar Funnel", "Kaya Coach — Workshop") and their old
`/api/ingest/...` endpoint rows, and the "generate a webhook" flow was
buried (form inside the endpoint table header, URL only in a modal). The
dev DB now has 6 real clients (Abhishek pal … Piyush ahuja) and the app
runs in live mode (`DATA_MODE=live`), so the seed clients were just
never filtered out of the SPA's client lists.

Fix:
- `server/lib/api.js`: new `realClients(tx, user)` — team roles get
  `datamode.clientOptions` (demo-flag-aware: live mode drops
  `client.demo=1` rows, demo mode keeps the fixtures); used by every SPA
  client picker (`dashboard`, `leads`, `pipeline`, `reports`,
  `integrations`, `webhooks`, `duplicates`, `portal`, `pilot`).
- `scopeOf(user, p, tx)` is live-aware: a team role's team-scope ids are
  the REAL client ids in live mode (invalid `?client=` ignored), so the
  dashboard KPIs/funnel/recent-leads + the webhooks endpoint list + the
  inbound log all exclude demo-client data in live mode; demo mode is
  byte-identical to before.
- `leads` / `lead` / `pipeline` / `meta` (accounts, spend, CAPI log) /
  `webhook_log` (both screens) hide demo-client rows for team roles in
  live mode. A team role can no longer open a demo-client lead (404).
- Latent SQL bug surfaced + fixed: `spendTrendDays` referenced `s.ad_id`
  while `FROM spend_daily` had no alias — it only "worked" because team
  `ids` used to be null; now that live scoping passes ids, the alias is
  required. (`api.js` `spendTrendDays`.)
- Screen rework (`public/app/app.js`): a prominent top-of-page
  "Generate a webhook URL" card (real-client picker + platform defaulting
  to FlexiFunnels + event scope + a big Generate button). The generated
  URL lands in a green copy-box directly under the form (also used for
  Rotate + API-key creation), not just a modal. Endpoint table +
  FlexiFunnels guide + field mapping + API keys below.

Tests: `test/webhook-keys.js` + all in-process suites green (SPA 42/42,
security, isolation, gates, metalive, reports). Live/demo sanity vs a
scratch copy of the dev DB: live = real-only everywhere, demo =
fixtures intact. Socket suites (replay/sweep) still need the sweep host.

## 2026-11-06 (v14: Webhooks & API Keys screen + FlexiFunnels live-lead pipeline)

The user's ask: a team-only "Webhooks & API Keys" tab where they can generate
/manage multiple webhooks AND multiple API keys, and have real FlexiFunnels
leads show up on the dashboard the moment they arrive. FlexiFunnels support
confirmed the flow: generate a webhook URL on our side, paste it into
FlexiFunnels (Forms → Webhook + Products/Purchases → Webhook).

**Data model (both engines + idempotent migration in server/db.js):**
- `webhook_endpoint` gained `slug, token_hash, description, events, status,
  events_total, last_event_at, created_at`. Multi-webhook per client+platform
  was already structurally true (UNIQUE on url); now each endpoint is a
  token-in-URL endpoint with its own lifecycle. `status` = active/paused/revoked.
- New `api_keys` table: `scope_client_id` (NULL = workspace-level), `label`,
  `permission` (read_only|read_write), `key_hash` (sha256 of `xak_…`; the
  plaintext is returned ONCE at creation), `created_by/created_at`,
  `last_used_at`, `revoked_at`. Postgres RLS: the table is hidden from
  scoped client sessions (team-managed credential store).

**Inbound token-URL path (server/index.js `handleTokenWebhook`):**
`POST /webhooks/<platform>/<slug>/<token>` — the URL's token authenticates the
endpoint row (`lib/webhooks.resolveByToken`), then the same enqueue + log +
per-IP/per-endpoint rate-limit flow as `/api/ingest`. Paused endpoint =
accept-and-ignore (200), revoked = 410, unknown token = 404. GET on a webhook
URL returns 200 JSON (FlexiFunnels "verify endpoint" probe) without enqueuing.
`events` scope filter: a `purchases`-scoped URL logs + skips lead-family events
(and vice-versa) so a form URL and a purchase URL can coexist without
cross-posting.

**FlexiFunnels adapter (server/lib/adapters.js):** maps form-submit payloads to
`form_submit` (or `registered` when the client's `field_map.event_type` says so)
and order payloads to `checkout_started` (pending) / `payment_success` (paid).
Phone → E.164; purchase with no matching lead = `source_unknown` lead that still
counts revenue; duplicate orders blocked on `gateway_txn_id`. Because FlexiFunnels
pages don't run `xt.js`, `utm_*` + `page_url` are captured onto a touchpoint so
ad attribution still works, and the lead shows a "UTM attribution" source card.

**API-key bearer auth (server/index.js on `/api/app/*`):** `Authorization:
Bearer xak_…` or `X-API-Key: xak_…`. A verified key resolves to a synthetic user
— workspace-level key → owner (unrestricted); client-scoped key → a client login
locked to that client (RLS + api.js both honor the scope). read-only keys are
GET-only. `lib/webhooks.js` = the endpoint + key lifecycle, token/key
generation, and `verifyApiKey`.

**Screen (public/app `#/webhooks`, team-only):** Section A = endpoints
(generate/copy/pause/resume/revoke/rotate, events-scope, last-event + total,
FlexiFunnels 2-step setup guide + a public-URL dev notice with a tunnel command,
per-client FlexiFunnels field-mapping editor). Section B = API keys
(create with one-time copy, scope × permission, revoke). The integrations screen
cross-links to it.

**Dashboard (public/app):** new-leads KPIs (`leadsToday` / `leads7d`, computed
engine-identically with a space-form midnight threshold) + a "New leads" card
(real webhook events: source platform, form title / page, masked phone, when) +
the lead timeline's UTM source card. The classic dashboard's empty state now
points at the webhook generator.

**Tests:** `test/webhook-keys.js` (in-process, engine-agnostic like spa.js — 39
checks: screen access, multi-endpoint + token auth, FlexiFunnels form→lead + UTM
+ KPI + source card, purchase→deal idempotency + checkout_started, scope filter,
pause/revoke lifecycle, API-key create/verify/scope/revocation, field-map
override). `test/replay.js` + `test/sweep.sh` gained the flexifunnels sample +
the public token-route / team-screen gates. `test-samples/flexifunnels.json`.
All in-process suites green on SQLite; replay/sweep (socket-based) run in the
sweep host. `test/datamode.js` "demo topAds includes ACT- ad" is a PRE-EXISTING
failure (fails on the clean tree too — confirmed via `git stash`).

**For the user:** the tab is live; to get real FlexiFunnels leads flowing, a
generated URL must be PUBLIC — either deploy (`APP_URL`, docs/deploy.md, Arpit's
hosting decision) or run a tunnel in dev (`cloudflared tunnel --url
http://localhost:<PORT>` / `ngrok`) and paste that public URL. Docs:
`docs/webhooks-adapters.md` §v14 + `.env.example` APP_URL block.

## 2026-11-06 (v13 spend-accuracy fix 2: the 30-day KPI was under-counting)

The user pushed back on the first spend fix: 7d was fine, but Abhishek
Pal - FML's real spend is much bigger than what "Last 30d" showed. A live
Meta probe (`tmp/meta-real-spend.js`, account-level `date_preset=last_7d`
/ `last_30d` — the same basis as Ads Manager) proved it:
- 7d: app = Meta, 0.00% on all 7 accounts
- **30d: app under-counted by 53–99%** (Abhishek ₹4,28,713 vs Meta ₹15,42,007;
  Piyush ₹9.72 vs ₹70,613).
Root cause: the 7 `act_` accounts were just mapped (v11) and the 3h ticker
only pulls the **last 7 days**, so `spend_daily` held a week of history —
the 30d KPI silently summed that week as if it were the month.

Fix:
1. **One-time 30-day backfill** for all 7 accounts (Meta live, 0 errors) —
   after: app 30d = Meta 30d at 0.00% on every account.
2. **`scripts/meta-backfill.js`** (new): reusable safe 30-day backfill —
   refuses to run in mock mode (would seed fake spend), skips MOCK-token
   accounts, idempotent upserts. Run after mapping any new ad account.
3. `server/lib/meta.js`: ticker default kept at 7 days, with a comment
   explaining why (older days are final + accumulate; 30d relies on
   accumulated history + the backfill seed).
4. `docs/spend-verification.md`: new "REAL 30-day bug" section + both
   windows' proof table. New screenshots `spend-v13-7d.png` (₹3,81,089) +
   `spend-v13-30d.png` (₹15,42,007 — Meta exact).

Both engines green (9 suites + replay + sweep, 0 failures) after the change.

## 2026-11-06 (v13 spend-accuracy fix — dashboard KPIs now match Meta Ads Manager)

User report: dashboard KPIs "don't match Ads Manager, Re-check still shows
drift". Diagnosis-first (no speculative code), via the new read-only
`scripts/spend-diagnose.js` (3 numbers per account: app DB / Meta
account-level live / Meta ad-level live sum, both windows, drifts, fx_rate,
AED + near-zero notes).

Root-cause classification (from the numbers, not guesswork):
- **Cause B (window mismatch)** — the visible mismatch. Dashboard "7d" was
  N-6→N (**today in**); Ads Manager "last 7 days" = N-7→N-1 (**today out**).
  Today's Meta spend is T+1-mutable, so the two always differ by ~a day's
  spend. Proof: over the today-excluded window, **all 7 real accounts match
  Meta live at 0.00%**, and Meta's own account-level aggregate equals its
  ad-level sum at 0.00% on every account (no aggregation-level bug).
- **Cause A (staleness)** — residual 0.22–0.42% on the same-window
  (today-in) comparison; Meta's today was still accruing between the 06:37
  UTC pull and the check. Not a bug; now labelled.
- **Cause C (AED currency labeling)** — The Job Workshop bills in AED; the
  app's INR column = spend × fx_rate('INR') (=1.0, no AED rate exists) and
  `spend_daily.currency` was hardcoded 'INR'. KPIs labelled ₹ were actually
  AED numbers.
- **Re-check blocker (schema drift)** — the dev DB's `meta_accuracy_check`
  was created on the older INR-basis shape (`app_spend_inr`/`meta_spend_inr`,
  no `currency`); `CREATE TABLE IF NOT EXISTS` can't extend it, so every
  `/meta/check` failed with `no column named app_spend` and recorded nothing.
  This is why "Re-check" appeared to still show drift.

Fix (all committed):
- `server/lib/shared.js`: KPI/aggregate windows → **complete days**
  (N-7..N-1 / N-30..N-1, today excluded) for kpis, top campaigns, top ads,
  the default-account rule, and the accuracy check — the Ads Manager basis.
  The 30-day trend keeps today (it's a trend, labelled "not final, T+1").
- `server/screens.js`: truth labels — under the KPIs: "Data through N-1 ·
  last 7 complete days (today N excluded …) · last Meta pull X h ago [Pull
  now]"; KPI currency is honest (`LAST 7D SPEND (AED) AED 2,700`, ₹ only
  for INR); trend badge "through today (not final, T+1)"; accuracy table
  headers "7 complete days (app) / (Meta live)" + every row shows
  `window · checked` (checked timestamp on recorded rows, current window
  basis on unchecked ones).
- `server/index.js` `/meta/check`: live-fetches the SAME N-7..N-1 window and
  records `window_from/to` — apples-to-apples with the KPI and Ads Manager.
- `server/db.js`: idempotent migration adding `app_spend`/`meta_spend`/
  `currency` to `meta_accuracy_check` on BOTH engines (SQLite PRAGMA-driven
  ALTER; PG `ADD COLUMN IF NOT EXISTS`) so Re-check works on pre-v11 DBs.
- `scripts/spend-diagnose.js` (new): read-only 3-number diagnosis for any
  engine; `docs/spend-verification.md` (new): exact KPI formulas, the 7-row
  proof table (all 0.00% drift, gate passed 2026-11-06), the 5-minute Ads
  Manager check steps, AED + Piyush-inactive notes, screenshot list.
- 4 screenshots: `docs/screenshots/spend-v13-{dashboard,accuracy,aed,piyush}.png`.
- NOTE for later: `fx_rate` still has no AED→INR rate (INR=1.0 seed only);
  the app now labels AED honestly but does not convert it. Add a rate when
  cross-currency KPIs matter.

Both engines green (11 components each: reports/security/liveapi/xt-queue/
isolation/metalive/gates/datamode/spa + replay + sweep, 0 failures).

## 2026-11-06 (v12 — final close-out: adapter re-verification, CAPI audit, staging/QA green)

Master v12 Task 1: make the project technically **pilot go-live ready**. All
work below; pilot cutover (Task 2) starts the moment Arpit's §2 checklist items
arrive.

1. **5-platform webhook spec retry** (`docs/adapter-verification.md`):
   - **Calendly promoted UNVERIFIED → VERIFIED** (2026-11-06). The official
     `developer.calendly.com` API docs are now public + fetchable (the
     auth-gated path the 2026-11-02 pass hit 404s). Spec: header
     `Calendly-Webhook-Signature` = `t=<ts>,v1=<HMAC-SHA256(secret, ts+"."+rawBody)>`
     — the timestamp is part of the signed message (3-min replay tolerance,
     matching the docs example).
   - Native Calendly HMAC path added in `server/lib/liveapi.js`
     (`calendlyVerifySignature`, exposed + a `case 'calendly'` branch), with a
     real sample-signed-payload regression in `test/liveapi.js` (valid /
     tampered / missing / malformed / stale-timestamp all asserted). The shared
     secret fallback for Calendly is gone — live mode now verifies its native
     signature.
   - Zoom stayed UNVERIFIED but its reason was corrected: official docs still
     404, and a consistent third-party reference shows the *current* spec is
     `x-zm-signature` = `v0=HMAC-SHA256(secret, "v0:"+ts+":"+rawBody)` +
     `x-zm-request-timestamp` (NOT the older token+secret / method+uri+date
     form recorded in 2026-10/11). Retry dates bumped: Aevent/Zoom →
     2026-11-20, Pabbly/FlexiFunnels → 2026-11-27. `pilot-live-checklist.md`
     entry-condition + §4 retry lines updated to match.

2. **CAPI dry-run audit** (new `docs/capi-audit.md` + read-only probe
   `tmp/capi-audit.js`): 40 dry-run `capi_log` rows, **0 duplicate event_ids**
   (dedup invariant holds), refund-suppression branch confirmed in code
   (`meta.js:120`, `sent_to_meta=2`), queue fully drained, `settings.capi='dry'`
   (nothing has hit Meta yet). The single "Purchase on a refunded lead" row
   traced to demo seed data (client 1, dry-run, pre-rule) — not a live bug.
   Cutover actions listed (flip to live only with real pixel + token; re-run
   the probe post-cutover, gate CAPI MQ ≥ 7 on Purchase).

3. **Pilot readiness**: `test/gates.js` G1–G4 green on the mock pilot dataset;
   `docs/pilot-live-checklist.md` re-checked against the current repo
   (staleness after `client.demo` + per-client dashboard fixes folded into item 1).

4. **Staging re-run** (`scripts/staging.sh`, prod-mirror PG): 0 failures across
   all 5 steps (suite, replay, sweep, backup+restore). One real bug found +
   fixed: **with `.env` carrying `XACQORA_LIVE=1` + a valid `XACQORA_SECRET_KEY`**
   (our dev .env now does), the seeded endpoint secrets become decryptable and
   the replay/sweep spawned servers enter live signature-gate mode → bare
   sample POSTs 401 "bad signature". Fix: `staging.sh` now runs replay + sweep
   with `MOCK=1` (the gate's own HMAC regressions stay covered by `test/liveapi.js`
   under the real key). Without this, any future staging run with a dev .env
   that has `XACQORA_LIVE=1` would red for no code reason.

5. **Final QA, both engines green**: reports, security, liveapi, xt-queue,
   isolation, metalive, gates, datamode, spa + replay + sweep — all PASS on
   SQLite and Postgres (consolidated runs logged; sweep 0 failures both).

6. **Token hygiene**: `docs/deploy.md` §7 cutover now carries a one-line
   reminder — the live Meta token was pasted in an AI chat session; rotate it
   in Meta before wiring secrets (or confirm in writing if already rotated).

Ready state: project is technically pilot-go-live ready. Cutover (v12 Task 2)
is gated on Arpit's checklist: 7 decisions, gateway credentials via `.env`
handover, Meta CAPI pixel/dataset IDs, Mumbai PG + Vercel + `track.`
subdomain, pilot CSVs + ad destination URLs, token-rotation confirmation.


Arpit's mapping-task ask: the dashboard kept centering **dummy data** — the 7
real `act_` ad accounts were all pinned to the seed "Coach Ravi" client, so
live mode still showed seed numbers on the front page. Map each real `act_`
account to its real client, keep the demo clients in the DB but mark them so
`DATA_MODE=live` hides their whole dataset (accounts + leads + deals + spend,
not just leads), flip the default to `live` (demo is now an opt-in flag), and
give the dashboard a per-client real view with an accuracy spot-check.

Task 1 — audit: `tmp/audit-mapping.js` prints `.env META_AD_ACCOUNT_IDS`,
every `meta_ad_account` row (kind / client / last pull), and `spend_daily`
counts + date range + 7d/all-time INR per account. Confirmed the root cause
(all real `act_` under seed client 1).

Task 2 — mapping + demo-client hiding:
- `client.demo` column added to `server/schema.sql` + `server/schema.pg.sql`
  + the SQLite/PG migrations in `server/db.js` (idempotent `ADD COLUMN`).
- `scripts/map-real-clients.js` (new, one-shot, idempotent, both engines):
  creates the operator's 6 real clients, points the 7 `act_` accounts at them
  (Abhishek pal owns 2: `act_1042839737275035` + `act_500594992542527`;
  Cracckfyi / Swraj jain / Upcurvv / The Job work shop / Piyush ahuja own 1
  each), and sets `client.demo=1` on "Coach Ravi — Webinar Funnel" +
  "Kaya Coach — Workshop". Real-client rows matched by name, accounts by
  `ad_account_id`, so re-running never duplicates.
- `server/lib/datamode.js`: `clientNotDemo` (NOT EXISTS on the row's
  client_id) + `spendClientNotDemo` (NOT EXISTS through the ad_account_id's
  client, for `spend_daily` which has no client_id) layer the whole-client
  hiding on top of the seed-convention predicates; combined live helpers
  `leadEx`/`dealEx`/`spendEx`/`metaAccEx`/`metaEntityEx`/`webhookEx`,
  `realClientIds` + `clientOptions` (the switcher's option list). `mode()`
  now defaults to **live** (demo opt-in via `.env`/toggle); demo-mode
  predicates still return `''` so demo SQL stays byte-identical.

Task 3 — per-client dashboard + accuracy spot-check:
- `server/lib/shared.js`: `metaAccountReport` + `adPerformance` +
  `funnelReport` + `metaVsTracker` + `sourceMix` take the combined live
  predicates; `accuracyCheck`/`recordAccuracyCheck` added for the spot-check.
- `server/screens.js dashboard`: a top-bar **client** select (`?client=`,
  real-only in live) scopes KPIs / 30-day trend / top campaigns+ads / ROAS /
  funnel / recent leads to one client's real accounts; an **accuracy
  spot-check** table renders per in-scope real account — the app's stored 7d
  spend vs the operator's Ads-Manager figure, with drift % (green pill when
  ≤1%); the client picker switches carry `?client=` through.
- `server/index.js`: team-only `GET /meta/check?acc=` live-fetches the last 7
  days from Meta for one account (`lib/meta.js → fetchMetaSpendTotal`),
  records the drift in the new `meta_accuracy_check` table, and **does not**
  upsert `spend_daily` (a check must not mutate the pipeline it audits);
  failures land in `last_error`.
- All report screens + `leads`/`pipeline`/`meta`/`integrations`/`portal`/
  `duplicates`/`pilot`/import + the leads/health/identity predicates moved to
  the combined helpers so a demo client's dataset hides everywhere in live.

Task 4 — verify:
- Piyush Ahuja `act_1377451727314532` "Pull now": the pull ran clean
  (`last_error` null, `last_pull_at` advanced) — the account is connected but
  its real spend is a tiny ₹9.72 all-time (16 rows, one day), i.e. an
  inactive / near-zero-spend account, **not** a pull failure.
- Live mode: owner + every client screen show zero demo names/numbers; the
  client switcher lists real clients only. Demo mode: everything comes back.
- 4 screenshots: `docs/screenshots/v11-mapping-{dash-switcher,dash-client3,
  reports-mvt,leads-empty}.png`.
- Both engines green: SQLite + Postgres, all suites (gates, isolation,
  liveapi, metalive, reports, security, spa, xt-queue, datamode) + replay +
  scratch-DB sweep (0 failures). `test/datamode.js` + `test/isolation.js`
  updated for the live default + the demo-client fixtures.

Docs: `docs/dashboard-real-data.md` (v11 section + live-default semantics),
README module-docs index + Tests notes.

`.env` (real token) is gitignored and never committed, per the working rule.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

## 2026-11-05 (v10 follow-on — dashboard custom date range: pick any window, all genuine Meta data)

Arpit's dashboard ask: keep `Last 7d / Last 30d`, but let him **pick any
date window** ("custom date ka bhi option… 7 days mein khud select karu")
and guarantee **only genuine Meta numbers, no fake/dummy data**. He
reported the fixed 7d/30d looked "galat" because he could not match Meta
Ads Manager's own picked days, and the pull only ever fetched the last 7
days.

- **`server/lib/shared.js`:** `metaAccountReport` now takes a `range:
  {from, to}` option and returns a `range` bundle — KPIs, a zero-filled
  per-day trend, the campaign split, and top campaigns/top ads — all over
  the exact `[from, to]` window with the same account + data-mode scoping
  (so it stays genuine Meta spend, demo rows still excluded). New helpers
  `parseDashboardRange` (validates `from<=to`, span <=92d, not >365d back;
  over-cap silently ignored) + `eachDay` (zero-filled date list), both
  exported. All range SQL is `s.date >= ? AND s.date <= ?` on the TEXT
  date column — engine-agnostic (no `?`-in-literal / `datetime('now')`
  pitfalls).
- **`server/lib/meta.js`:** `runMetaPull` accepts `payload.from`/`payload.to`
  (YYYY-MM-DD) to fetch an explicit window; the 3h ticker's default
  last-7-days behaviour is unchanged.
- **`server/index.js`:** new team-only `GET /dashboard/refresh?acc=&from=&to=`
  route — live-fetches the chosen window from the Meta Ads Insights API for
  the chosen (or every in-scope) account, stores it, audits
  `meta.range_pull`, then 302s back to the dashboard. The genuine-data
  path: it pulls real rows, never invents numbers.
- **`server/screens.js → dashboard`:** the window controls are now
  `Last 7d / Last 30d` presets + a **From/To date picker**. When a range
  is set, KPIs/trend/top tables come from `rep.range`, the first KPI is
  labelled "custom range" with the range shown, and a **"No Meta data yet
  for {range} — [Fetch this range from Meta]"** CTA (or a "Re-pull this
  range" link) appears. The account switcher now carries `from`/`to`
  through so changing accounts keeps the chosen window.
- **`scripts/live-screenshots.js`:** captures
  `docs/screenshots/v10-live-dashboard-range.png` (a 7-day window) as the
  range-mode proof shot.
- **`docs/dashboard-real-data.md`:** new "Custom date range" section.

Verified live on the running dev server (owner, live DATA_MODE): a
`?from=&to=` dashboard renders "custom range" KPIs equal to the genuine
`spend_daily` total for that account+window; `/dashboard/refresh` 302s
back + writes a `meta.range_pull` audit row; a client is denied 403.
Both engines green (8 suites + scratch-DB sweep + replay, SQLite &
Postgres; sweep 0 failures).

## 2026-11-05 (v10 follow-on — real ad-account NAMES persisted + displayed)

Closes the last gap in "sirf real Meta accounts + unke **real naam**": the
switcher + Meta hub were showing the raw ad-account **IDs** (`act_1377…`)
where Arpit's real account names (Meta shows e.g. "Redanza Skin Care")
should be. Root cause: the `metalive` bootstrap created the rows with
`name = ad_account_id` (the `.env` had no per-account name), and the live
pull fetched `AdAccount.name` but **dropped it** on return, so it was never
written back.

- **`server/lib/liveapi.js → runLiveMetaPull`:** now returns `accountName`
  (the real `AdAccount.name`; the `/acct` call already requested `name`).
- **`server/lib/meta.js`:** after each live pull, persists the real name
  onto `meta_ad_account` (only when Meta returns one and it differs from the
  id) — so every future pull keeps the name current.
- **`scripts/meta-name-sync.js` (new one-shot):** for accounts created
  before this fix, fetch each `act_…` account's name+currency with its own
  encrypted token and write them back. Idempotent, offline-safe, token never
  printed. On the dev DB it renamed all 7: Piyush Ahuja, Abhishek Pal - FML,
  FML New, CardGenius 2, Upcurvv-FML, FML X ABHISHEK PAL, The Job Workshop.
- **`server/screens.js → meta.html`:** the account row now leads with the
  real name (ID + currency as the muted sub-line) and drops the seed
  client-name bracket that read as "dummy".
- Re-captured the 5 `docs/screenshots/v10-live-*.png` — dashboard switcher
  and Meta hub now show the real account names.

Both engines still green (reports / datamode / metalive / security / spa
suites + the scratch-DB sweep, SQLite + Postgres; sweep 0 failures).

## 2026-11-05 (v10 — real-data guarantee: test artifacts gone for good + live-only UI)

Arpit's v10 requirement: the frontend must show **only his real Meta ad
accounts** — no dummy. v9 had the mechanism (`DATA_MODE=live`), but two
things kept leaking demo: (1) local dev still defaulted to `demo`, and
(2) 181 nameless test-artifact leads had accumulated in the dev DB from
sweep runs and escaped the seed-based filter. This closes both at the root.

### Task 1 — test artifacts, permanent cleanup + prevention
- **Root cause found:** `test/sweep.sh` was the only harness POSTing through
  the **live ingest pipeline into the shared dev DB** (replay.js →
  `xacqora-test.sqlite3` and staging.sh → `xacqora_staging` were already
  isolated). Its S.6 rate-limit flood POSTed degenerate `{"client_id":1}`
  bodies; the `meta_leadgen` adapter minted one all-NULL `source_unknown`
  lead each time → the 181 rows.
- **`test/sweep.sh` (rewritten setup):** now runs on a **throwaway scratch
  DB + its own server** — a `xacqora-sweep-scratch.sqlite3` file (SQLite) or
  a `xacqora_sweep_<pid>` database (Postgres), seeded fresh, dropped on exit
  (EXIT + INT/TERM traps). It refuses to reuse a busy port (a foreign server
  would not be on the scratch DB). The S.6 loop POSTs are tagged
  `__sweep_test`.
- **`server/index.js → handleIngest` (marker guard):** a payload carrying
  `__sweep_test:true` is logged as test-only (`webhook_log`, `test=1`) and
  **not enqueued** — it verifies the secret/rate-limit path without minting a
  lead. Placed after the rate-limit checks so S.6's 429 still fires.
- **`server/screens.js` (integrations "Send test event"):** the daily-dev
  button now sends the `__sweep_test` marker too.
- **`scripts/clean-test-artifacts.js` (new):** one-time cleanup of
  pre-existing artifacts. Dry-run by default; `--delete` backs up via
  `scripts/backup.js` first. Deletes only all-NULL leads strictly above the
  seed range (>126) with zero deals/touchpoints whose events are all
  degenerate (the marker, or the exact `{"client_id":N}` body). The 26 named
  seed leads + anything with a real identity are excluded by construction;
  re-running is a no-op. Engine-aware.

### Task 2 — the operator's live-only view, verified
- **`.env`: `DATA_MODE=live`** (local dev now matches prod intent).
- **`scripts/live-screenshots.js` (new):** drives the already-running live
  server (no reseed, no new DB) to capture 5 shareable owner screenshots —
  `docs/screenshots/v10-live-{dashboard,leads,meta,reports,alerts}.png`.
- Confirmed on the running server: dashboard KPIs are real ad-account spend
  (`act_…` ids, INR + billing currency), Reports shows real ad spend with
  ROAS "N/A — pilot live", the leads page shows the clean empty state, and
  the alerts board no longer lists demo `ACT-` pull failures.

### Bugs found + fixed while verifying
- **`shared.js → metaVsTracker` (real v9 live-mode 500):** the client-scoped
  WHERE was built by string-concatenating a trailing `AND` onto
  `liveLeadEx`, producing `...ANDNOT (l.id BETWEEN …)` — a syntax error that
  only fired when **clientIds + live mode** both applied (owner Reports).
  Now a parts-list + ` AND ` join.
- **`health.js` (alerts demo leak in live mode):** seed `ACT-…` ad-account
  `last_error` rows showed on the ops board as pull failures. Now excluded
  in live mode via `metaNotDemo` (the public `/health` JSON stays
  system-scoped — monitoring reflects true state).

### Tests + docs
- `test/datamode.js` + all 8 prior suites + replay + the **new scratch-DB
  sweep** green on **both engines** (SQLite + Postgres). The sweep now proves
  the point directly: after a full sweep the dev DB still has 26 seed leads
  and 0 artifacts.
- `docs/dashboard-real-data.md` — the "Dev-DB hygiene" section rewritten to
  the v10 scratch-DB + marker-guard model (replaces the old one-shot note).
- `docs/pilot-live-checklist.md` — entry-conditions line added: the dev DB
  never gets test-artifacts (scratch DB + marker guard) + the cleanup command.

**Arpit's Task 3 (token close-out):** revoke/regenerate the Meta system-user
token in Business Suite (it was pasted into chat earlier), drop the new
long-lived token into `.env` `META_ACCESS_TOKEN`, restart, then confirm
`/meta` → "Pull now" is green for all 7 accounts. Old token is now invalid
so the transcript copy carries no risk.

## 2026-11-04 (v9 Task 3 — UI overhaul: "website feel" → SaaS dashboard)

The third master-v9 task: turn the classic server-rendered screens from a
"website jaisa, confusing" look into a clean SaaS dashboard aesthetic,
built **on the existing CSS primitives** — one shared stylesheet in
`shared.js`, zero-dep, no framework, no build step.

### What changed
- **`server/lib/shared.js → css()`** — a full design-system rewrite of the
  single stylesheet: a token palette (`:root` surfaces / text / status /
  geometry tokens), a soft radial-accent background, glassy sticky top bar,
  KPI cards (micro-caps label + tabular value + hairline accent bar),
  hover-able tables, tinted pills, focus rings on inputs, softer shadows
  and a consistent radius scale. Legacy token names are kept as aliases
  (inline styles in `screens.js` reference `--blue`/`--green`/`--ok`…).
- **`server/lib/shared.js → layout()`** — a two-tier app shell: a fixed left
  sidebar (brand + nav grouped into Workspace / Insight / Integrations /
  Ops / Admin) + a slim sticky top bar (ad-account switcher + user + sign
  out) for signed-in screens; the compact single top bar is kept for auth
  / 403 / 404. Responsive: the sidebar collapses to a horizontal row under
  900 px. All 14 screens + the demo band + the ad-account switcher render
  through the same shell; routing, paths and role-gating are untouched.
- **`server/lib/shared.js → navFor()`** — nav links now carry a `group`;
  the SPA's `/api/app/me` still reports the same paths, so the SPA is
  unaffected (it builds its own sidebar).
- **`server/screens.js`** — page titles + actions move to a `pagehead`
  pattern (title row flush-left, actions flush-right), and the dashboard
  KPI strip is a `g6` grid. No query, permission or money logic changed
  (those stay human-reviewed).

### Kept working (regression-checked)
Demo band, ad-account switcher, all 14 classic screens, the `/app` SPA
shell, and the Task 2 empty states all render through the new shell. The
demo band, switcher, empty states and role-gating logic are byte-for-byte
the same — only presentation moved.

### Docs
- **`docs/ui-design-system.md`** (new): where the classic look comes from
  (the `css()` blob + `layout()` shell), the token model, and how to verify
  it. The Phase F SPA (`public/app/app.css`) keeps its own independent
  design system and is intentionally **not** part of this pass.

### Tests
- Both engines green after the pass: SQLite 8 suites + replay + sweep
  (0 failures); Postgres 9 suites + replay (all PASS). **Known
  pre-existing, unrelated:** the PG sweep's 2FA step (S.3) fails reading
  the enrolled TOTP secret on the PG cluster (memory:
  `pg-sweep-2fa-preexisting`).

## 2026-11-04 (v9 — real-data dashboard + DATA_MODE switch; UI overhaul next session)

Two tasks from the master v9 spec: **(1)** the dashboard/reports are now
centred on the operator's **real** Meta ad accounts, and **(2)** demo seed
data is behind a `DATA_MODE` switch with professional empty states. The UI
overhaul ("website feel" → SaaS) is scoped to the next session.

### Task 1 — real-data dashboard
- **`server/lib/shared.js → metaAccountReport`** — the report engine: 7d/30d
  KPIs (spend in INR + billing currency, impressions, reach, clicks, CTR,
  avg CPC), 30-day zero-filled trend, per-campaign split, top-5 campaigns /
  top-5 ads (LEFT JOINs so the ad tree may lag the first pull and spend
  still charts), pull status + per-account next auto-pull (3 h ticker),
  ROAS only when attributed revenue is real — otherwise "N/A — pilot live"
  (never a fake number).
- **`server/screens.js → dashboard/reports`** — rebuilt around the switcher:
  a top-bar ad-account select (real `act_` accounts only, with last-pull
  status), the whole dashboard scoped to the chosen account; "Pull now" for
  team roles. Reports got the same switcher.
- **`meta_ad_account.currency`** — new column (both schemas + idempotent
  migration), recorded from the ad account's `currency` field on each pull
  (the API field is `currency`, **not** `currency_code` — that 400s #100).
  KPI cards show INR + billing currency side by side.
- **`server/lib/liveapi.js`** — ad-tree fetch now uses the bracket edge
  field `campaign{id}` (v19.0's field parser rejects dotted `campaign.id`
  with a 400 "Expected (") so campaigns resolve.

### Task 2 — DATA_MODE demo/live switch
- **`server/lib/datamode.js`** (new) — resolution
  `settings.data_mode → env DATA_MODE → 'demo'`; NOT-predicates that hide
  the seed's own conventions only (leads 101–126, deals 1–10, `ACT-…`
  accounts/entities/spend, seed webhook refs) — **never auto-id ranges**,
  so real pilot rows are untouched.
- **Admin toggle** — `POST /admin/data-mode` (owner/admin), audit-logged
  (`data_mode.toggle`); three buttons demo/live/default on the admin screen.
- **Every screen** threads `dm.mode(tx)` + the band (`layoutDemoBand`):
  demo shows seed+real with the yellow band; live shows real rows with
  clean empty states ("No leads yet — your first lead lands when the Meta
  Instant Form webhook goes live (pilot cutover). Ad spend below is
  already real."). Band added on all ten screens incl. duplicates/admin/
  portal/pilot/alerts; live mode also excludes seed webhook failures from
  the alerts board (`lib/health.js`, engine-aware).
- **Engines:** default prod = `DATA_MODE=live`; local dev `.env` = `demo`.
- **One-time dev-DB cleanup** (`tmp/clean-sweep-leads.js`): 181 sweep/
  replay artifacts (all-NULL leads, one degenerate `{"client_id":1}` event
  each, 0 deals/touchpoints) removed from the gitignored dev DB; the 26
  named seed leads intact. Production never accumulates these.

### Bugs found + fixed while verifying
- `revByAd` ReferenceError → client dashboard/portal 500 (declaration
  dropped in an earlier edit, re-added in `adPerformance`).
- `webhookNotDemo` used the alias unconditionally → `no such column: w.ref`
  on integrations (demo OK, live 500); now strips an empty alias.
- `COALESCE(c.id,'?')` in `metaAccountReport` — the PG engine's `?`→`$n`
  translator treats `?` inside a string literal as a placeholder → every
  dashboard/reports page 500s on Postgres. Now `'na'`. **Caught by the new
  `test/datamode.js` running on PG.**

### Tests + docs
- **`test/datamode.js`** (new, both engines): resolution order, admin
  toggle, demo empty-predicates, live seed-only exclusion (real auto-id
  rows survive), KPI aggregation (live excludes `ACT-` spend).
- **`docs/dashboard-real-data.md`**: source of truth for every dashboard
  number + live/demo semantics + dev-DB hygiene note.
- Both engines green: SQLite 8 suites + replay + sweep (0 failures);
  Postgres 9 suites + replay (all PASS). **Known pre-existing:** the PG
  sweep's 2FA step (S.3) fails reading the enrolled TOTP secret via
  `scripts/dbq.js` on PG — unrelated to this change (2FA/TOTP untouched);
  SQLite sweep 2FA passes.

Next session: master v9 Task 3 — the UI overhaul (SaaS dashboard look,
build on the existing CSS primitives; the demo band + switcher stay).

## 2026-11-04 (Meta live pull GREEN — real spend in the DB, both engines)

The env→DB bridge (`9a423fd`) landed, but the first live pull failed with
`Provided value cannot be bound to SQLite parameter 1` on every account. A
host-side probe of the real `v19.0` insights surface (`tmp/probe-meta.js`)
proved two API facts the mapper got wrong:

1. **Daily `time_increment:1` rows carry `date_start`/`date_stop`, not `date`**
   → `spend_daily.date` was bound as undefined → the crash.
2. **`spend` is in currency units, not microcurrency** — a 7-day aggregate
   (`9.72`) equals the sum of its daily rows (`9.72`), not `9.72e-6`. The old
   `÷1e6` would have stored near-zero spend and defeated the ≤1% gate.

### What landed
- **`server/lib/liveapi.js`** — `mapInsightRow` reads `date_start` (skips rows
  missing it, never fakes a date) and passes `spend` through unscaled
  (`microToUnits` removed; comment pins the live-verified unit).
- **`server/lib/meta.js`** — pull window is the last 7 calendar days
  (`YYYY-MM-DD`, required by the API); error paths unchanged (classified,
  surfaced on `/alerts`).
- **`server/index.js`** — the `[meta-live]` bootstrap now checks its target
  `client` row first: on a fresh unseeded DB (the replay test's scratch DB,
  or a first prod start pre-seed) it logs
  `[meta-live] target client id N not found — skipping sync` instead of
  crashing the boot on the `meta_ad_account.client_id` FK. This was a
  real regression the `replay.js` suite caught after `9a423fd`.
- **`scripts/pg-dev.sh`** — `xacq_app` now gets `CREATEDB` (the test suites
  each create + drop their own scratch DB; the app itself never createdb).
- **`scripts/meta-validate.js`** — `act_`-prefix normalization on both sides
  of the accessible-vs-requested account comparison.
- **Live verification (this DB, 7 real accounts):** all 7 pulled green,
  `spend_daily` holds 923 real rows across the 7 accounts (2026-10-22
  → 2026-11-04; e.g. `act_500594992542527` 7-day spend ₹90,784); Reports → Meta vs Track renders real ad rows (₹ figures,
  impressions, clicks). **≤1% gate**: DB-stored 7-day spend vs Meta's own
  ad-level surface = 0.000–0.030% drift, 7/7 accounts PASS. **CAPI stayed
  dry-run** (0 live `capi_log` rows, `settings.capi=dry`).
- **Both engines green:** all 10 suites (`gates, isolation, liveapi,
  metalive, replay, reports, security, spa, spec-research, xt-queue`) pass on
  SQLite and on Postgres (dev cluster `127.0.0.1:5433` + CREATEDB role),
  plus `test/sweep.sh`.

Note for the next session: all 7 real `act_` accounts pull clean (the demo
seed accounts ACT-100001/02/03 are mock rows; ACT-100003 shows a harmless
"token expired (401)" from its placeholder mock token — ignore or re-seed).
`scripts/meta-validate.js` lists the 55 accounts the system user can reach;
the 7 requested ids are all in that list. The prod Postgres URL in `.env`
is still the template placeholder — fill it at cutover.

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
