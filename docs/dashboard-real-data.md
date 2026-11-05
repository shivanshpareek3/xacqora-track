# Dashboard real-data + DATA_MODE (Master v9)

The dashboard and reports are now centred on **real** Meta data (the
operator's 7 ad accounts pulled by the ticker), with seed/demo fixture data
behind a switch. This page is the source of truth for where every number on
the dashboard comes from, and what "live" vs "demo" changes.

## Two data populations, one switch

| Population | What it is | How it's marked |
|---|---|---|
| **demo** | `scripts/seed.js` fixtures: leads 101–126, deals 1–10, ad accounts `ACT-100001…03`, their spend rows, `pay_seedfail`/seed webhook refs | explicit ids / prefixes the seed writes |
| **live** | rows the pull + gateway ingest create: ad accounts `act_…`, `spend_daily` rows for those accounts, gateway leads/deals (auto ids), webhook rows | everything else |

`DATA_MODE` decides which population the screens show:

```
resolution (first present wins):
  1. settings.data_mode   ← admin toggle  POST /admin/data-mode  (audit-logged: data_mode.toggle)
  2. env DATA_MODE        ← .env (dev default: demo) / Vercel dashboard (prod default: live)
  3. 'demo'               ← safe default when neither is set
```

- **demo** (default, local dev): seed + real rows together, with the yellow
  "Demo data — seed figures included" band under the top bar.
- **live** (default in prod): every seed row is excluded from every screen
  (leads, deals, meta entities, spend, webhook log). Screens that would
  otherwise show a demo figure instead show a clean empty state ("No leads
  yet — your first lead lands when the Meta Instant Form webhook goes live
  (pilot cutover). Ad spend below is already real."). **ROAS is never
  faked**: with no attributed revenue yet it renders "N/A — pilot live".

The demo predicates key off the seed's own conventions — **never off ranges
of auto-generated ids** — so real gateway leads (which get sequential
auto-ids after the seed's) are never excluded. Single source of truth:
`server/lib/datamode.js → SEED`.

## Where each dashboard number comes from

| Element | Query source | Scope |
|---|---|---|
| KPI cards (7d/30d spend, impressions, reach, clicks, CTR, avg CPC) | `spend_daily` sum over the account's `spend_inr`/`spend` (billing currency) | selected ad account (switcher) or all in-scope accounts |
| Top campaigns (7d) | `spend_daily` LEFT JOIN `meta_ad → meta_adset → meta_campaign` | LEFT JOIN on purpose: the ad tree may lag the first pull, spend must still chart |
| Top ads (7d) | `spend_daily` LEFT JOIN `meta_ad` (thumbnail `creative_img`) | same |
| 30-day trend + campaign split | `spend_daily` grouped by `date` (zero-filled 30 days) | same |
| Pull status / next auto-pull | `meta_ad_account.last_pull_at / last_error / auto_pull`; ticker pulls every account older than 3 h (`server/index.js`), "Pull now" button per account | team roles only |
| ROAS | `spend` vs attributed revenue (`deal` success, unrefunded, client-scoped) | shows "N/A — pilot live" while revenue = 0 |
| Revenue | `deal` (success, unrefunded) attributed to ad clicks in window | demo deals 1–10 excluded in live |

### Billing currency

`meta_ad_account.currency` is recorded from the ad account's `currency`
field on each pull (the API field is `currency`, **not** `currency_code` —
the latter 400s with `#100`). KPI cards show INR + the account's billing
currency side by side.

## Custom date range (v10 follow-on: pick any window, all genuine Meta data)

The dashboard's `Last 7d / Last 30d` presets are still there, but you can
now pick **any** window:

- **URL:** `?from=YYYY-MM-DD&to=YYYY-MM-DD` (optional `&acc=<ad_account_id>`
  to scope one account; defaults to the auto-selected largest account).
  **`server/lib/shared.js → parseDashboardRange`** validates: `from <= to`,
  span **<= 92 days** (Meta's per-request insights limit), and `from` not
  earlier than **365 days** back. An invalid/over-cap range is silently
  ignored, so the page always renders a real-data preset window.
- **What renders over the chosen window:** the KPI cards (the first card is
  labelled "custom range"), the per-day spend trend (zero-filled across the
  whole window), the per-campaign split, and the top campaigns / top ads —
  all computed from `spend_daily` for exactly `from..to`
  (`metaAccountReport`'s `range` bundle, `shared.js`), with the same
  account + data-mode scoping as the presets, so the numbers stay genuine
  Meta spend (never demo rows).
- **Genuine-data guarantee:** the dashboard only ever numbers from
  `spend_daily`, and for a real `act_` account every row in that table is
  Meta-pulled (the mock generator only mints rows for the seed `ACT-`
  accounts, which live DATA_MODE excludes). When a chosen window has **no
  pulled data yet**, the dashboard shows a clear CTA instead of blanks:
  **"No Meta data yet for {range} — [Fetch this range from Meta]"**.
- **Fetch / re-pull this range:** `GET /dashboard/refresh?acc=&from=&to=`
  (team-only, `server/index.js`) live-fetches that window from the Meta Ads
  Insights API for the chosen account (`meta.js → runMetaPull` now accepts
  `payload.from`/`payload.to`; the 3 h ticker still pulls the default
  last-7-days), stores it in `spend_daily`, audits `meta.range_pull`, then
  redirects back to the dashboard. It never invents numbers — it pulls
  real Meta rows, or records the pull failure in the account's
  `last_error`. Self-select any 7-day window with From/To → Apply, and use
  "Re-pull this range" to refresh that exact window later.

`scripts/live-screenshots.js` captures `docs/screenshots/v10-live-dashboard-range.png`
(a 7-day window on the largest account) as the range-mode proof shot.

## `test/datamode.js` (run on both engines)

Proves, on a scratch DB: resolution order, the admin toggle write/delete,
demo mode returning empty predicates (byte-identical SQL), live mode hiding
exactly the seed-convention rows while keeping real auto-id rows, and
`metaAccountReport` KPI aggregation (live excludes `ACT-` spend; demo
includes it).

```bash
node test/datamode.js                                  # SQLite
DATABASE_URL=postgres://... node test/datamode.js      # Postgres (scratch db xacqora_datamode)
```

## Dev-DB hygiene (v10: the dev DB never gets test-artifacts again)

Earlier, repeated `test/sweep.sh` runs POSTed the degenerate body
`{"client_id":1}` through the live ingest pipeline into the **shared dev DB**,
minting all-NULL leads (no phone/email/name, `source_unknown=1`, one
degenerate `meta_form_lead` event each). They are not seed.js rows and are
NOT what `DATA_MODE` filters (that targets seed conventions only), so they
kept showing up in live mode. Fixed at the root (v10):

- **Prevention (root cause):** `test/sweep.sh` now runs on a **throwaway
  scratch DB** (a `xacqora-sweep-scratch.sqlite3` file, or a
  `xacqora_sweep_<pid>` Postgres database) + its own server, seeded fresh and
  dropped on exit. A test run can no longer write to the running dev/prod DB.
  (`test/replay.js` → `xacqora-test.sqlite3` and `scripts/staging.sh` →
  `xacqora_staging` were already isolated.)
- **Marker guard (defense-in-depth):** the sweep's S.6 flood POSTs and the
  integrations "Send test event" button now tag their payload with
  `__sweep_test:true`. `server/index.js` → `handleIngest` logs such payloads
  as test-only (`webhook_log` row, `test=1`) and does **not** enqueue them, so
  they verify the secret/rate-limit path without ever minting a lead.
- **Cleanup for pre-existing rows:** `node scripts/clean-test-artifacts.js`
  (dry-run by default; `--delete` backs up via `scripts/backup.js` first).
  It deletes only all-NULL leads strictly above the seed range (>126) with
  zero deals/touchpoints whose events are all degenerate (the
  `__sweep_test` marker or the exact `{"client_id":N}` body) — the 26 named
  seed leads and anything with a real identity are structurally excluded, and
  re-running is a no-op. Production never accumulates these.

## Related

- `docs/meta-live-connect.md` — how the token + pull pipeline works
- `docs/reports-attribution.md` — the four attribution models
- `docs/pilot-live-checklist.md` — the cutover that turns leads/revenue on
