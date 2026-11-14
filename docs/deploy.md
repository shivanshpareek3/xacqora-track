# Deploy (Phase H)

One-command production deploy: **Vercel (app) + managed Postgres (Mumbai)**.
Everything in this doc is prep + runbook; the live wiring (30 min) happens the
moment Arpit's §6 hosting budget lands. No real secrets live in this repo —
env vars and the Vercel dashboard only.

> **Region note:** pilot is India (IST), pilot latency budget matters for
> webhook ingest. Managed Postgres in **Mumbai** (Supabase/Neon/Supabase
> equivalent in `ap-south-1`); the Vercel function can stay global or pin to
> `mrs`/nearest — the DB is the latency-dominant hop.

---

## 1. Topology

```
 Meta / gateways / xt.js (client pages)
        │  POST /api/ingest/<platform>      (webhook secrets, HMAC-verified in live mode)
        ▼
 ┌────────────────────────────┐        ┌──────────────────────────────┐
 │ Vercel (Node 24 function) │───────▶│ Managed Postgres (Mumbai)    │
 │  api/index.js → handleReq │        │  role xacq_app   (non-super, │
 │  /admin/tick  (daily tick)│        │             FORCE RLS binds) │
 │  /webhooks/… (FlexiFunnels)│      │  role xacq_backup (super,    │
 └────────────────────────────┘        │             dump-only)      │
        │                              └──────────────────────────────┘
        ▼
 https://<your-app>.vercel.app   (stable public URL → the FlexiFunnels
                                   webhook base, replaces dev tunnels)
 https://track.<domain>/xt.js    (subdomain or CDN, Phase H item 2)
```

Key properties:

- **Serverless-safe app** — `server/index.js` no longer auto-listens when
  imported: the request handler is exported (`module.exports = { handleRequest,
  server }`) and `api/index.js` is the Vercel entry. The 5s in-process ticker
  is replaced by **Vercel Cron → `POST /admin/tick`** (`vercel.json`), gated
  by the `XACQORA_TICK_SECRET` header. Self-hosted runs (`npm start`) keep the
  interval and never call the endpoint.
- **Hobby cron limit (v15)** — Vercel **Hobby** plans allow **at most one cron
  firing per day**. The original `*/5 * * * *` (every 5 min) is rejected on
  Hobby ("would run more than once per day") — it is a *warning*, not a build
  failure, but it means the 5-min drain never runs. The committed `vercel.json`
  is now **daily: `0 0 * * *`** (option A). See §9 for the options and how to
  get sub-daily drains back without Pro.
- **Real-time webhooks without a 5-min drain** — because the Hobby cron is
  daily, a webhook that only *enqueued* would sit in the queue up to 24h. So
  the inbound paths (`/api/ingest/<platform>` + the token URL
  `/webhooks/<platform>/<slug>/<token>`) **process the FlexiFunnels/other
  webhook INLINE on the serverless target** (the `DISABLE_TICKER` condition,
  i.e. `XT_DISABLE_TICKER=1`): the adapter runs in the same function
  invocation and the lead lands in Postgres immediately. If inline processing
  throws, it falls back to the durable queue (the daily cron drains it). Local
  dev + both test engines leave `XT_DISABLE_TICKER` unset, so they take the
  original enqueue-only path — **byte-identical**.
- **Queue drain on a timer** — `/admin/tick` runs the same ticker cycle as the
  interval: webhook jobs, scheduled Meta pulls, the daily backup, and the
  Monday-9AM-IST weekly summary. On Hobby it fires **daily**; a cron firing
  while a function instance is still alive just re-runs an idempotent cycle
  (jobs are claimed in the queue, deduped by `dedup_key`). Under the daily
  cron, **Meta pull freshness is daily** unless you add an external cron
  (§9-B) — manual "Pull now" (`/meta.html`) is always available.
- **xt.js on its own subdomain** — third-party CSP pages (Meta-hosted
  Instant-Form thank-you pages, Lovable/WordPress clients) can't always load a
  script cross-origin. `xt.js` is already served with `Access-Control-Allow-Origin: *`
  and the `public/xt.js` asset; host it at `track.<yourdomain>` (a second Vercel
  project or a CDN) and point `data-endpoint` there. Set `XACQORA_XT_SUBDOMAIN`
  so the alerts screen can show the canonical URL.
- **RLS still binds in prod** — the app connects as the **non-superuser**
  `xacq_app` (FORCE RLS applies); `pg_dump`/`pg_restore` run as the
  **superuser** `xacq_backup` only (`PG_BACKUP_USER`), because forced-RLS
  tables refuse export by the app role (Phase P rule).

---

## 2. Environment variables (full list)

Set in the Vercel project (prod) / `.env` (self-hosted). Template:
[`.env.example`](../.env.example). **None of these are committed; real values
never go into AI chat.**

| Var | Where | Purpose | Prod value |
|---|---|---|---|
| `DATABASE_URL` | Vercel | Managed Postgres connection (app role) | `postgresql://xacq_app:PW@host/db` |
| `PG_BACKUP_USER` | Vercel | Superuser role for pg_dump/restore (FORCE RLS) | `xacq_backup` |
| `XACQORA_SECRET_KEY` | Vercel | 32-byte AES-256-GCM master key for secrets-at-rest (gateway secrets, Meta tokens) | `openssl rand -hex 32` |
| `XACQORA_LIVE` | Vercel | `1` = real Meta pull/CAPI + gateway HMAC verification | `1` |
| `MOCK` | Vercel | `1` forces mock even with creds (dev default) | unset / `0` |
| `XACQORA_TICK_SECRET` | Vercel | Cron secret for `POST /admin/tick` (header `x-xacqora-tick-secret`) | random 32+ chars |
| `XACQORA_XT_SUBDOMAIN` | Vercel | canonical host for `xt.js` (third-party CSP pages) | `track.<domain>` |
| `XT_RATE_PER_MIN_IP` | Vercel | per-IP flood guard (Phase S.6) | `600` |
| `XT_RATE_PER_MIN_ENDPOINT` | Vercel | per-endpoint cap | `300` |
| `PORT` | Vercel | listen port (Vercel sets; harmless) | `4100` |
| `XT_DISABLE_TICKER` | Vercel | `1` turns off the in-process interval (serverless) + switches webhooks to inline processing | `1` |
| `DATA_MODE` | Vercel | `live` = real data only (seed/demo fixtures hidden); prod default | `live` |
| `APP_URL` | Vercel | **public base for generated webhook URLs (FlexiFunnels paste points)** — set to the Vercel app URL | `https://<app>.vercel.app` |
| `META_ACCESS_TOKEN` | Vercel | Meta system-user access token (env→DB bridge encrypts it onto the ad-account rows) | your token |
| `META_AD_ACCOUNT_IDS` | Vercel | comma-list of ad account ids to bridge from env | `act_123,act_456` |
| `META_PIXEL_ID` / `META_AD_ACCOUNT_NAME` / `META_CLIENT_ID` | Vercel | optional env→DB bridge extras (pixel, display name, target client) | per account |

> **`APP_URL` is the FlexiFunnels webhook base (v15).** The "Webhooks & API
> Keys" screen generates `/webhooks/<platform>/<slug>/<token>` URLs on
> `APP_URL` when it is set; a Vercel deploy gives a **stable public URL** for
> good, so the temporary trycloudflare/ngrok dev tunnels are retired. On the
> screen, `baseIsProd` (true when `APP_URL`/`XACQORA_PUBLIC_URL` is set) hides
> the "localhost won't reach FlexiFunnels" dev notice.

---

## 3. Managed Postgres (Mumbai) — provisioning

One-time, per provider (Supabase / Neon / RDS / Aiven `ap-south-1`):

```sql
-- non-superuser app role: owns the DB, RLS binds it
CREATE ROLE xacq_app LOGIN;
-- superuser dump-only role: pg_dump/pg_restore must bypass FORCE RLS
CREATE ROLE xacq_backup LOGIN SUPERUSER;
CREATE DATABASE xacqora OWNER xacq_app;
GRANT ALL ON DATABASE xacqora TO xacq_app;
```

Then load the schema **as the app role** (RLS policies bind the owner):
```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/schema.pg.sql
# grants: owner may GRANT on its own tables (Phase P provisioning step)
psql "$DATABASE_URL" -Atc "GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO PUBLIC;"
```

- **Neon** note: Neon's default role is a superuser; create the two roles
  above (Neon lets the owner role create login roles via its dashboard SQL).
  Point `DATABASE_URL` at the app role, not the pooler "pooled" role, so
  session GUCs (`app.client_ids`) pin the RLS scope.
- **pg-native** ships prebuilt binaries for Node 24 on Vercel's runtime; if a
  platform bump breaks the binary, the pure-JS `pg` driver (already in
  `package.json`) is the documented fallback — swap `require('pg-native')` in
  `server/pg.js` for a `pg.Pool` sync-shim. That is a 1-file change.

---

## 4. Deploy

```bash
# once: link the repo, add the env vars from §2
vercel link
vercel env add DATABASE_URL       # paste the prod value (never commit)
vercel env add PG_BACKUP_USER
vercel env add XACQORA_SECRET_KEY
vercel env add XACQORA_TICK_SECRET
vercel env add XACQORA_LIVE       # = 1 in prod
vercel env add DATA_MODE          # = live in prod
vercel env add APP_URL            # = your Vercel app URL (FlexiFunnels webhook base)
vercel env add XT_DISABLE_TICKER # = 1 (serverless: no in-process interval)
# Meta env->DB bridge (optional): META_ACCESS_TOKEN, META_AD_ACCOUNT_IDS, ...

vercel deploy --prod
```

`vercel.json` (committed) does the rest: catchall rewrite → `api/index.js`
(handles `/webhooks/*`, `/health`, `/admin/tick`, the SPA `/app` fallback, and
every other route through the single function), and a **Hobby-legal daily
cron `0 0 * * *` → `/admin/tick`** with the tick-secret header (Hobby allows at
most one cron firing per day — the former `*/5 * * * *` was rejected; see §9).
Because the drain is now daily, **inbound webhooks process INLINE on the
serverless target** (a FlexiFunnels POST lands in Postgres in the same
invocation, not at the next cron), and `/admin/tick` runs the capped-drain
serverless cycle (3.4) so it stays inside the function timeout.

**Self-hosted (VPS) alternative:** same code, `npm start` under a process
manager; keep `XT_DISABLE_TICKER` unset so the in-process ticker runs; back the
DB with the managed Postgres above; `pg_dump` nightly via `scripts/backup.js`
+ `scripts/restore-drill.sh` on cron.

---

## 5. Staging (fake data, prod-mirror config)

`scripts/staging.sh` (Phase H item 3) boots the **prod-mirror** config on a
throwaway Postgres db — Postgres engine, a generated `XACQORA_SECRET_KEY`,
prod rate-limit values — seeds it with the **fake** demo dataset (no client
data, ever), and runs the full backend suite + sweep + backup/restore drill on
that config. Green staging = green prod, mechanically:

```bash
# dev cluster (scripts/pg-dev.sh) or a real staging Postgres via PSQL_*:
bash scripts/staging.sh
# -> [5/5] all suites + sweep + backup/restore on xacqora_staging
```

---

## 6. Monitoring & alerts (Phase H item 5)

- **`GET /health`** (public, no auth, `Cache-Control: no-store`) — JSON with
  `ok`, `engine`, `ts`, plus the five signal blocks and their booleans:
  webhook failures (24 h), queue age > 10 min, Meta pull failures, CAPI stuck
  unsent, last daily backup. Drive any uptime dashboard off it.
- **`/alerts.html`** (team-only screen, in the nav as **Alerts**) — the same
  signals as a triage board, recent webhook-failure rows, and the prod toggles
  (Meta business-verification flag + CAPI live/dry flip; live mode itself is
  the `XACQORA_LIVE` env var, changed via Vercel + redeploy).
- **Page on:** any `/health` signal boolean true for > 10 min, `secret_key_set`
  false, or the daily `/admin/tick` (Hobby) missing its beat on two
  consecutive days (queue age gate, G4, will trip first; sub-daily beats are
  only available via an external cron, §9-B).

---

## 7. Security re-verify on prod (Phase H item 6)

`scripts/prod-verify.sh` runs the Phase S checklist **against the prod
cluster** (read-only checks + one restore drill into a scratch db):

```bash
DATABASE_URL=... PG_BACKUP_USER=xacq_backup APP_URL=https://app.yourdomain.com \
  bash scripts/prod-verify.sh
```

Checks: engine = pg · FORCE RLS binding (scoped conn sees only its client) ·
`XACQORA_SECRET_KEY` set (secrets prod-only, no insecure dev key) · owner 2FA
enrolled · audit_log live · daily backup ran · monthly restore drill passed ·
`/health` clean · prod toggles state. Must be **PASS** before the live-pilot
cutover (the checklist's entry condition).

**Live-pilot cutover** (after Arpit §6 answers):
1. `vercel env rm XACQORA_LIVE; vercel env add XACQORA_LIVE=1` (+ `MOCK` unset) → redeploy
2. Ops fills the live gateway/Meta secrets (encrypted at rest by
   `XACQORA_SECRET_KEY`) — see `docs/pilot-live-checklist.md` §1.2
3. Set `settings.capi='live'` only after the pixel + ad account verify
   (dry-run until then; `match_quality` is the 7–9 estimate while dry)
4. Run `scripts/prod-verify.sh` + the pilot checklist; open the 4-week
   accuracy window (`docs/pilot-live-checklist.md` §3 cadence)

> **⚠️ Token hygiene — read before cutover:** the live Meta access token used
> during development was pasted into an AI chat session. Treat it as
> compromised: before step 2, **rotate it in Meta's system-user token
> dashboard** and confirm the new token is the only one in `.env` / the
> endpoint rows (old copies deleted). If Arpit has already rotated it,
> confirm once in writing and tick this line off.

---

## 8. Rollback

- **App:** previous Vercel deploy (zero-downtime). Schema changes are
  additive (the `ALTER TABLE … ADD COLUMN IF NOT EXISTS` in `db.js` makes
  old app + new DB and new app + old DB both boot — no down-migration needed
  for Phase H).
- **DB:** `pg_restore` from the newest `xacq_backup`-role dump
  (`scripts/restore-drill.sh` is exactly that path).

---

## 9. Hobby cron limit & pull-freshness options (v15)

**The Hobby red box.** Vercel Hobby allows **at most one cron firing per
day**. The original `vercel.json` shipped `*/5 * * * *` (every 5 min), which
Hobby rejects with:

> "Hobby accounts are limited to daily cron jobs. This cron expression
> (`*/5 * * * *`) would run more than once per day."

It is a **warning, not a build failure** — the deploy proceeds, but the 5-min
drain never runs. Concretely: the 3-hour Meta auto-pull fires at most once
a day, and a webhook that only *enqueued* would sit in the queue until the
next daily cron.

**Chosen — option A: daily cron (committed).** `vercel.json` now schedules
`/admin/tick` at **`0 0 * * *`** (UTC, one firing/day — Hobby-legal). What
that buys / gives up:

- Meta auto-pull is **daily** (was 3-hour). The manual **"Pull now"** on
  `/meta.html` (team-only) always works, so a fresher number is one click
  away; only the *automatic* cadence coarsens.
- **Webhooks are not delayed by the cron**: on the serverless target the
  token-URL (`/webhooks/…`) and `/api/ingest` paths process the FlexiFunnels
  event **inline** in the same function invocation (§1 "Real-time webhooks"),
  so a lead lands in Postgres immediately, not at the next daily tick.
- `/admin/tick` runs the **capped-drain serverless cycle** (`XT_TICK_MAX_JOBS`,
  default 50) so one invocation stays inside the function timeout; un-claimed
  jobs roll to the next fire. Heavy Meta pulls are per-account jobs (each
  small on its own).

> **Variant:** to align Monday's tick with the weekly-summary window
> (`tickerCycle` writes the Mon-9AM-IST summary only when UTC hour = 3, i.e.
> Mon 08:30–09:29 IST), schedule **`0 3 * * *`** instead — still one firing/
> day, still Hobby-legal. (On Hobby the weekly PDF is audit-only anyway, since
> the function FS is ephemeral.)

**Option B — external cron (3-hour pull back, without Pro).** Keep the Vercel
Hobby app (Vercel cron daily as a floor, or none) and have a free external
timer POST to the secret-gated endpoint every 5 min / 3 h:

```
POST https://<your-app>.vercel.app/admin/tick
header: x-xacqora-tick-secret: <XACQORA_TICK_SECRET>
```

Any of these work (store the secret in the hoster's env, not in the repo):
a Cloudflare Worker cron trigger, GitHub Actions `schedule` (free; min cadence
≈1 h), or a cheap VPS `curl` on crontab. The endpoint is gated by
`XACQORA_TICK_SECRET`, so only that timer can trigger it. This restores
sub-daily Meta-pull freshness on Hobby.

**Option C — Vercel Pro (Arpit's budget call).** On Pro the Hobby "once a
day" cap lifts, so restore **`*/5 * * * *`** (5-min drain, 3-hour pulls)
exactly as originally designed and optionally raise `maxDuration` past 60 s
for heavier ticks. No code change — just put the schedule back in `vercel.json`
and redeploy.

**Stable public URL for FlexiFunnels (v15).** A Vercel deploy gives the app a
permanent `https://<app>.vercel.app` URL. Set **`APP_URL`** to it and the
"Webhooks & API Keys" screen generates the token URLs on that base — the
temporary trycloudflare / ngrok dev tunnels are **retired**; FlexiFunnels
posts to the stable Vercel URL and leads land in Postgres in real time.
