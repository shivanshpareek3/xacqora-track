# Module: Attribution + reports

**What it does** — credits every sale to exactly one ad under a fixed, stated
rule. Four selectable models: **last paid click** (default, 30-day window),
**first click**, **linear** (split equally across ad clicks), **lead source**.
Sales with no ad click inside the window go to **Organic / unknown**. Window is
editable per client (7/14/30/60 days). Revenue is always net of refunds.

**Reports (7)** — funnel report (spend/leads/registrations/attended/calls/sales,
CPL, show-up rate, close rate), ad performance table (campaign→ad drill-down,
spend/leads/revenue/ROAS/profit, ad thumbnail per row, wasted-spend flag),
wasted spend (ads above threshold with zero sales, sorted by spend), new vs old
leads, Meta vs Xacqora Track (Meta-reported vs our counted, per ad), lead source
mix (Instant Form / landing / organic / unknown), and the auto weekly client
summary (Monday 9 AM IST, generated in `server/index.js`'s ticker into
`reports/summary-<date>.json`).

**Files** — `server/lib/shared.js` (`attributeSale`, `adPerformance`,
`funnelReport`, `wastedSpend`, `newVsOld`, `metaVsTracker`, `sourceMix`,
`weeklySummary`; settings keys `attribution_model`, `attribution_window_days`,
`wasted_spend_threshold` in the `settings` table), `server/screens.js` →
`reports()`, `metaVsTracker()` and `weeklySummary()` in `server/lib/shared.js`,
the Monday-IST block in `server/index.js`.

**How to test** — `node scripts/seed.js` seeds ad touchpoints + payments; open
`/reports.html` with `?model=...` to compare models; check the attribution
bucket counts on the funnel card. Every number in a report links to the leads
behind it (click an ad row → lead list).

**Open (Phase R)** — CSV + Excel export on every report, PDF weekly summary to
the client portal, and the side-by-side Meta-reported conversion column.
