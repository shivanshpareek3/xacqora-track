# Meta live connect (pull only; CAPI stays dry-run)

How to get a real Meta spend pull running against this app. **Secrets live
only in `.env` (gitignored) — never in chat, never committed.** The app loads
`.env` on startup (`server/lib/env.js`); real environment variables (shell or
Vercel dashboard) always win.

## How the token reaches the app (architecture, from the code)

The live pull does **not** read a `META_ACCESS_TOKEN` env var at pull time.
The token is stored **per ad account** in `meta_ad_account.token`, encrypted
at rest with AES-256-GCM (`security.encryptSecret` — keyed by
`XACQORA_SECRET_KEY`). `meta.js → runMetaPull` decrypts the row's token and
calls the Marketing API (`liveapi.js → runLiveMetaPull`,
`v19.0/{acct}/insights?level=ad`, a 7-day `time_range` with
`time_increment: 1` for one row per day, fields
`ad_id,spend,impressions,reach,clicks,conversions`).
Two live-verified API facts (see `tmp/probe-meta.js`):
- **Spend is in currency units, not microcurrency** — a 7-day aggregate and
  the same days summed from the daily rows both read e.g. `9.72` (not `9.72e-6`).
  Do not divide by 1e6; doing so would store near-zero and break the ≤1% gate.
- **Daily rows carry `date_start`/`date_stop` (equal), not a `date` field** —
  the pull reads `date_start` so `spend_daily.date` is always populated.

So the `.env` → app path is a **bootstrap bridge** (`server/lib/metalive.js`,
run on every server start):

```
.env  META_ACCESS_TOKEN + META_AD_ACCOUNT_IDS
  └─> metalive.syncMetaAccountsFromEnv()
        └─> meta_ad_account rows (token ENCRYPTED, status 'connected')
              └─> ticker / "Pull now" → live runLiveMetaPull()
                    └─> meta_campaign / meta_adset / meta_ad + spend_daily
```

Fill the two values in `.env` and start the server — that's the whole wiring.
You never edit the DB by hand.

Guard: the bridge needs its target client row to exist
(`meta_ad_account.client_id` is NOT NULL, FK to `client`). On a fresh,
unseeded database (e.g. the replay test's scratch DB) the boot logs a
`[meta-live] target client id … not found — skipping sync` line and starts
clean instead of crashing on the FK; seed (`node scripts/seed.js`) and the
next start syncs.

## The 3-point list — what to grab from Meta, and where

1. **`META_ACCESS_TOKEN`** — the **system-user token**:
   Meta Business Suite → *System Users* → pick/created the system user →
   **Generate Token** (60-day token; exchange for a long-lived one later).
   Permissions that must be ticked on that token:
   - `ads_read` — required for the spend pull.
   - `pages_read_engagement` — needed later for lead-form (Instant Form) webhooks.
   Then grant the token **to each ad account** you want to track:
   *Business Settings → System Users → your user → Access to… → Ad Account →
   assign*. Without this, the pull 401s even with a valid token.
2. **`META_AD_ACCOUNT_IDS`** — the `ACT_` id of every ad account to pull.
   Get them either from **Meta Ads Manager** (account switcher → each
   account's `ACT_` id) or by running
   `node scripts/meta-validate.js` (it lists `/me/adaccounts`).
   Comma-separated: `ACT_123,ACT_456`.
   **Pilot tip:** put **one** `ACT_` in first; confirm the live pull + spend
   land green, *then* add the rest.
3. **Expiry check** — `node scripts/meta-validate.js` prints
   `/me` (who the token is), the accessible `ACT_` list, and
   `/debug_token`'s `expires_at`, and records it on the account rows so
   `/alerts` shows a "token expires on X" line 48 h before.

**Verify before you fill anything** (offline-safe — prints the steps above
and exits 0 with no network):

```bash
node scripts/meta-validate.js
# once you have the token:
node scripts/meta-validate.js META_ACCESS_TOKEN=EAAB...
```

## The live-pull test (task 3)

```bash
# 1. fill .env (META_ACCESS_TOKEN, one META_AD_ACCOUNT_IDS, XACQORA_SECRET_KEY,
#    XACQORA_LIVE=1)
# 2. restart the server — the [meta-live] bootstrap log line confirms the sync
node server/index.js
# 3. open /alerts.html  (or GET /health) → "Meta pull failures" + "Meta token expiry"
# 4. open /meta.html → "Pull now" on the account; or wait for the 3h auto-pull
```

**Pass criteria (PRD gate):**

- `spend_daily` (the table — *not* `meta_spend_daily`) has rows for the ad;
  the last 7 days, billing-currency spend + INR via the `fx_rate` table.
- Total spend vs Meta Ads Manager within **≤ 1%** (same window, same currency).
  Cross-check on the **Reports → Meta vs Xacqora Track** table (Phase R): Meta
  self-reported `conversions` vs our counted leads, per ad, with the Δ column.
- Dashboard/Reports now show real numbers (the mock fixture data is gone).
- **One account first**, green → add the others.

**Failures** show on `/alerts` as a classified, operator-facing line
(`metalive.classifyMetaError`): *401/invalid token → "regenerate the
system-user token"*; *permission/not-assigned → "assign the ad account to
the system user"*; *network/API → "retries with backoff"* (the ticker's
existing backoff re-runs failed jobs — no manual retry needed).

## CAPI: keep it dry-run (explicit task rule)

The dry-run gate is the DB setting `settings.capi` (seeded `dry`), checked in
`meta.js → pushCapiEvent` (`dryRun = settings.value !== 'live'`) and re-gated
by `liveMode()` + a real row token. **Do nothing** to keep CAPI dry: leave
`settings.capi='dry'` (the `/alerts` screen's "Flip CAPI to dry-run" button).
Sending `Purchase` live before webhooks are live is an early + duplicate-event
risk (deterministic `event_id` prevents double-counts, but not premature
ones). **Live CAPI is a pilot-cutover step only** (a later task): flip
`settings.capi='live'` on the alerts screen *after* the pixel + ad account are
verified and the webhook pipeline is confirmed.

## Both engines

The bridge is engine-agnostic (`makeTx` + the additive
`meta_ad_account.token_expires_at` migration in `db.js`). Verify on SQLite
(default) and, if `DATABASE_URL` is set, on Postgres:

```bash
node test/gates.js && node test/reports.js        # existing suites still green
node test/metalive.js                              # new: bridge + classifier test
```
