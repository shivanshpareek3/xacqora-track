# Module: Attribution + reports

**What it does** — credits every sale to exactly one ad under a fixed, stated
rule. Four selectable models: **last paid click** (default, 30-day window),
**first click**, **linear** (split equally across ad clicks), **lead source**.
Sales with no ad click inside the window go to **Organic / unknown**. Window is
editable per client (7/14/30/60 days). Revenue is always net of refunds.

**Reports (7)** — funnel report (spend/leads/registrations/attended/calls/sales,
CPL, show-up rate, close rate, revenue **net of refunds** + refunded count), ad
performance table (campaign→ad drill-down, spend/leads/revenue/ROAS/profit, ad
thumbnail + ad-id per row, wasted-spend flag, and a per-ad **Meta vs ours**
conversions column), wasted spend (ads above threshold with zero sales, sorted
by spend), new vs old leads, Meta vs Xacqora Track (Meta-reported `conversions`
from the spend pull vs our counted leads, per ad + delta), lead source mix
(Instant Form / landing / organic / unknown), and the auto weekly client summary
(Monday 9 AM IST, generated in `server/index.js`'s ticker into
`reports/summary-<date>.json` **and** one PDF per client under
`reports/summary-<date>-client<N>.pdf`, linked from the portal + `/weekly.pdf`).

**Every report exports** (Phase R): `/export/<funnel|report|source-mix|
new-vs-old|meta-vs-track|weekly-summary>` with `?fmt=csv` (default) or
`?fmt=excel`. Excel is a hand-written zero-dep SpreadsheetML (".xls") document
(`server/lib/shared.js` → `toExcel`); CSV uses `toCsv`. Both are role-masked
(phone/email) for the leads export and every export writes an `audit_log` row
(`export.csv` / `export.xls`).

**Every number links to the leads behind it** (Phase R): the report KPIs, ad-row
"Leads"/"Revenue" cells, and source-mix chips all deep-link to
`/leads?ids=1,2,3` (numeric-only, RLS-safe). `/leads` accepts `?ids=` as an
extra filter with a "showing N leads behind a report number" banner.

**Files** — `server/lib/shared.js` (`attributeSale`, `adPerformance`,
`funnelReport`, `wastedSpend`, `newVsOld`, `metaVsTracker`, `sourceMix`,
`weeklySummary`, `weeklyPdfLines`, `toCsv`, `toExcel`; settings keys
`attribution_model`, `attribution_window_days`, `wasted_spend_threshold` in the
`settings` table), `server/lib/pdf.js` (zero-dep PDF writer),
`server/screens.js` → `reports()` + `leads()` `?ids=` drill-down,
`metaVsTracker()` in `server/lib/shared.js`, the export route (`/export/...`,
`/weekly.pdf`) + the Monday-IST block in `server/index.js`. Meta-reported
conversions come from the insights pull (`server/lib/liveapi.js` requests
`conversions,quality_conversions`; `server/lib/meta.js` stores them in
`spend_daily.conversions`; the mock pull synthesizes a plausible value).

**How to test** — `node scripts/seed.js` seeds ad touchpoints + payments; open
`/reports.html` with `?model=...` to compare models; check the attribution
bucket counts on the funnel card. Every number in a report links to the leads
behind it (click a KPI / ad-row lead count / source chip → lead list).
`node test/reports.js` asserts net-of-refunds revenue, drill-down lead-id
lists, the Meta-vs-Track delta, the weekly PDF bytes, and CSV/Excel export
shapes (runs on either engine; set `DATABASE_URL` for Postgres).
