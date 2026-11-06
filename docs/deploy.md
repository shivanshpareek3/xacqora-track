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
 │  /admin/tick  (cron 5m)   │        │             FORCE RLS binds) │
 └────────────────────────────┘        │  role xacq_backup (super,   │
        │                              │             dump-only)      │
        ▼                              └──────────────────────────────┘
 https://track.<domain>/xt.js  (subdomain or CDN, Phase H item 2)
```

Key properties:

- **Serverless-safe app** — `server/index.js` no longer auto-listens when
  imported: the request handler is exported (`module.exports = { handleRequest,
  server }`) and `api/index.js` is the Vercel entry. The 5s in-process ticker
  is replaced by **Vercel Cron → `POST /admin/tick`** every 5 minutes
  (`vercel.json`), gated by the `XACQORA_TICK_SECRET` header. Self-hosted runs
  (`npm start`) keep the interval and never call the endpoint.
- **Queue drain on a timer** — `/admin/tick` runs the same ticker cycle as the
  interval: webhook jobs, scheduled Meta pulls, the daily backup, and the
  Monday-9AM-IST weekly summary. A cron firing while a function instance is
  still alive just re-runs an idempotent cycle (jobs are claimed in the queue,
  deduped by `dedup_key`).
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
| `XT_DISABLE_TICKER` | Vercel | `1` turns off the in-process interval (serverless) | `1` |

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
vercel env add DATABASE_URL      # paste the prod value (never commit)
vercel env add PG_BACKUP_USER
vercel env add XACQORA_SECRET_KEY
vercel env add XACQORA_TICK_SECRET
vercel env add XACQORA_LIVE
# prod = XACQORA_LIVE=1, XT_DISABLE_TICKER=1, MOCK unset

vercel deploy --prod
```

`vercel.json` (committed) does the rest: catchall rewrite → `api/index.js`,
and the **`*/5 * * * *` cron → `/admin/tick`** with the tick-secret header.

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
  false, or the 5-min `/admin/tick` missing three consecutive beats (queue age
  gate, G4, will trip first).

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
