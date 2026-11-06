# Spend verification (v13 spend-accuracy task)

Diagnosis date: **2026-11-06**. Every KPI formula below is exact and
reproducible; the 7-row table is the live proof. Companion script:
`scripts/spend-diagnose.js` (read-only — run it any time to re-verify).

## What the diagnosis found

The perceived "dashboard ≠ Ads Manager" mismatch was **not** a data bug.
Three separable causes, each proven by the diagnosis numbers:

| Cause | What it is | Evidence |
|---|---|---|
| **B — window mismatch** (the visible one) | The dashboard's "7d" KPI = **N-6 → N (today in)**; Ads Manager's "last 7 days" = **N-7 → N-1 (today out)**. Today's Meta spend is T+1-mutable, so the two always disagree by roughly a day's spend | Same pipeline vs live Meta over the **today-excluded** window (N-7..N-1): **0.00% drift on all 7 accounts** |
| **A — staleness** | Same-window (N-6..N) comparison shows **0.22–0.42%** because Meta's "today" was still accruing between the app's last pull and the live check | 0.28% Abhishek / 0.42% FML X / 0.34% Upcurvv / 0.33% CardGenius / 0.22% Job Workshop (fresh pull at 06:37 UTC, check moments later) |
| **C — AED currency labeling** | The Job Workshop bills in **AED**, but the app's `spend_inr` = spend × `fx_rate(date,'INR')` (= 1.0, no AED rate exists) and `spend_daily.currency` was hardcoded `'INR'` → KPIs labelled ₹ were actually raw AED numbers | Diagnosis: app 7d = 2,453.78 "AED" (the ₹ label was wrong); live Meta same window = 2,699.7 AED → 0.00% once the currency is named honestly |

Plus a **Re-check blocker** found mid-task: the dev DB's `meta_accuracy_check`
table had been created with an **older INR-basis shape**
(`app_spend_inr`/`meta_spend_inr`, no `currency`), so every `/meta/check`
failed with `no column named app_spend` — the "Re-check" button silently
recorded nothing. Fixed with an idempotent migration in `server/db.js`
(SQLite + PG branches). This is why the user saw "drift still showing"
after pressing Re-check: **the check had never once succeeded in dev.**

## The fix (all committed with this task)

1. **KPI basis = complete days** (`server/lib/shared.js`): the 7d/30d KPIs,
   top campaigns, top ads and the default-account rule now aggregate
   **N-7..N-1 / N-30..N-1** — identical basis to Ads Manager's "last 7/30
   days" (today excluded). The 30-day **trend** keeps today (it's a trend
   line, not a KPI) and is labelled "through today (not final, T+1)".
2. **Truth labels** (`server/screens.js`):
   - under the KPI cards: **"Data through N-1 · last 7 complete days
     (today N excluded — Meta finalises today's spend at T+1) · last Meta
     pull X h ago [Pull now]"**
   - KPI currency is honest: `LAST 7D SPEND (AED) AED 2,700` for the AED
     account (₹ only for INR accounts).
   - Accuracy table: header now says "7 complete days (app) / 7 complete
     days (Meta live)" + every row shows its `window · checked` timestamp
     (including un-checked rows, so the basis is always visible).
3. **`/meta/check` (Re-check) aligned** (`server/index.js`): now live-fetches
   the **same N-7..N-1 window** and records `window_from/window_to` — the
   number that lands in the table is the apples-to-apples one.
4. **Schema migration** (`server/db.js`): `meta_accuracy_check` gets
   `app_spend`/`meta_spend`/`currency` idempotently on both engines.
5. **Diagnosis script** (`scripts/spend-diagnose.js`): read-only; prints the
   3 numbers per account (app / Meta account-level / Meta ad-level sum), the
   two drifts, both windows, last_pull_at, fx_rate rows, and the AED +
   near-zero notes.

> The ≤1% gate claim from `820fe42` was **true for complete days** (it was
> always 0.00% there). The mismatch was the today-inclusive default window +
> the unrecorded Re-check (schema drift). Both are now corrected; the number
> shown is now the number an operator will see in Ads Manager for the same
> window.

## KPI formulas (exact)

| KPI | Formula | Basis |
|---|---|---|
| Last 7d spend | `SUM(spend_daily.spend) WHERE ad_account_id=… AND date ∈ [today-7, today-1]` (complete days, today excluded) | native currency; INR column = `spend × fx_rate(date,'INR')` |
| Impressions / Reach / Clicks | `SUM(impressions/reach/clicks)` same window | Meta ad-level daily rows (`level=ad, time_increment=1`), summed per day — the account-level aggregate matches this sum to 0.00% (verified) |
| CTR | `clicks / impressions × 100` | — |
| Avg CPC | `spend_inr / clicks` | 0 when clicks = 0 |
| ROAS | `attributed revenue / spend_inr` | "N/A — pilot live" until pilot revenue lands |
| Trend (30d) | daily `SUM(spend_inr)` over last 30 days **including today** | labelled "through today (not final, T+1)" |

Meta fetch: `GET /act_{id}/insights?level=ad&fields=ad_id,spend,impressions,reach,clicks,conversions&time_range={"since","until"}&time_increment=1` (v19.0, currency units, NOT microcurrency). Note: `link_clicks`/`currency` are **not valid** v19.0 insights fields (#100) — do not add them.

## 7-row final table (user-facing proof, 2026-11-06)

Basis: last 7 complete days **2026-10-30 → 2026-11-05** (today 11-06
excluded). "Meta live" = fresh account-level insights fetch at check time;
recorded in `meta_accuracy_check` via the Re-check button (all `gate=true`).

| Account | App 7d spend | Meta live 7d spend | Drift % | Cause / note |
|---|---|---|---|---|
| Abhishek pal · `act_1042839737275035` (Abhishek Pal - FML) | ₹3,81,089.02 | ₹3,81,089.02 | **0.00%** | verified — earlier "mismatch" = Cause B (today-inclusive default window) |
| Abhishek pal · `act_500594992542527` (FML X ABHISHEK PAL) | ₹1,00,197.69 | ₹1,00,197.78 | **0.00%** | verified (0.08-unit T+1 re-attribution inside Meta, rounds to 0) |
| Cracckfyi · `act_1626467978880942` (FML New) | ₹58,937.74 | ₹58,937.74 | **0.00%** | verified |
| Swraj jain · `act_4683943305259169` (CardGenius 2) | ₹44,819.09 | ₹44,819.09 | **0.00%** | verified |
| Upcurvv · `act_4749960348632164` (Upcurvv-FML) | ₹37,449.98 | ₹37,449.98 | **0.00%** | verified |
| The Job work shop · `act_935714081758825` (AED) | **AED 2,699.70** | **AED 2,699.74** | **0.00%** | verified — Cause C: KPI now labelled AED, not ₹. (fx_rate has no AED→INR rate yet, so the INR column = raw AED; add one when FX matters) |
| Piyush ahuja · `act_1377451727314532` | ₹9.72 | ₹9.72 | **0.00%** | **INACTIVE account, not a pull issue** — all-time spend ₹9.72 across 16 rows, all dated 2026-11-01; account is connected and pulls clean |

Timezone one-liner (task §1.6): the app's "today" is a **UTC calendar day**;
Meta's daily rows are in the **account's timezone (IST)** — between 00:00–05:30
IST the two "todays" differ by one day, which is exactly why the complete-days
(N-7..N-1) basis is the stable one.

## The 5-minute Ads Manager check (do this once, for the record)

For any account above (Abhishek Pal - FML is the biggest, so it's the one to
spot-check):

1. Open Meta **Ads Manager** → that ad account.
2. Date range: **"Last 7 days"** (or custom **2026-10-30 → 2026-11-05** —
   the window printed above the accuracy table).
3. Level: **Ad account** → Summary → **Spend** column.
4. That number must equal the table's *Meta live 7d spend* column (₹3,81,089
   for Abhishek). If it matches: the app is honest end-to-end and any earlier
   mismatch was the today-inclusive window / unrecorded Re-check. If it
   doesn't match the *Meta live* column (not the app column): the problem is
   in Meta's own dashboard vs the Marketing API (e.g. token rate-limit or a
   stale Ads-Manager cache) — not the app.

Re-run any time with: `node scripts/spend-diagnose.js`

## Screenshots

- `docs/screenshots/spend-v13-dashboard.png` — KPI truth labels + accuracy table (7 accounts, 0%)
- `docs/screenshots/spend-v13-accuracy.png` — accuracy table close-up (checked rows + window + timestamp)
- `docs/screenshots/spend-v13-aed.png` — The Job Workshop AED-honest KPI labels
- `docs/screenshots/spend-v13-piyush.png` — Piyush Ahuja near-zero/inactive view
