# Frontend tour (Phase F)

The Phase F frontend is a **zero-dependency SPA** served at `/app` — a single
hash-routed app (`public/app/`: `app.js` + `ui.js` + `app.css`) that reads the
JSON API at `/api/app/*` (`server/lib/api.js`) and renders the SAME data the
classic server-rendered screens show, in a polished dark SaaS UI. The classic
screens remain the fallback ("Classic UI" link, top-right of the SPA); the two
render identical numbers. The SPA shell is cookie-auth-gated (302 → `/signin`
when logged out).

> **Honest label (master v7 §6):** every figure on these screens while the app
> runs in mock mode is **demo data** (seed fixtures + mock Meta pull). A yellow
> **"Demo data — the live pilot will show real numbers"** band shows on every
> screen in both UIs; it disappears automatically the moment `XACQORA_LIVE=1`
> is set (the band is driven by `liveapi.liveMode()`, surfaced via
> `security.keySecure()`-style mode flags — the API's `me.demo` flag on the SPA
> side and `layoutDemoBand()` on the classic side). Never present a screenshot
> as real performance without that label.

## Open it

```bash
# SQLite (zero-dep default)
node scripts/seed.js && node server/index.js
# -> http://localhost:4100/app  (sign in: owner@xacqora.local / xacqora)
# Postgres engine
DATABASE_URL=postgresql://xacq_app@127.0.0.1:5433/xacqora node server/index.js
```

Fresh seed → **every screen is populated on first open** (no empty states):
26 leads across all stages, 8 deals (incl. refunds + a failed payment),
ad-click touchpoints, Meta campaigns/adsets/ads for 2 ad accounts, 14 days of
per-ad spend, CAPI log, webhook log, and a duplicate pair — deterministic
(`rnd(seed)` in `seed.js`) so both engines show identical numbers.

**Demo logins** (password `xacqora`): `owner@xacqora.local` (owner),
`arpit@xacqora.local` (media_buyer), `rep@xacqora.local` (sales_rep),
`client@xacqora.local` (client-1, read-only portal).

## Walk-through, dashboard → portal

Screenshots: `docs/screenshots/shot-*.png` (captured by
`node scripts/screenshots.js`, CDP-driven headless Chrome, zero-dep).

### 1. Dashboard (`#/dashboard`, team) — `shot-dashboard.png`
KPI strip (leads, net revenue, ad spend, ROAS, show-up, close, cost/sale,
profit, each with sparkline/sub-line), **Sales funnel** card (Leads → Paid with
step conversion + refunded/attribution counts), **Ad spend 14-day** area chart
(spend + clicks, dual series), **Lead source mix** donut, **Top ads — spend vs
revenue** dual-bar card (red = spend, green = attributed revenue, ROAS
multiplier on the right), **Recent leads** table. The banner states the active
attribution model + window; every number links into the leads behind it.

### 2. Lead timeline (`#/lead/101`, Ravi) — `shot-lead-timeline.png`
Header card: name, stage pill, masked-or-full contact chips (role-dependent),
owner + total paid. **First / Last ad clicked** cards with ad thumbnails,
KPI strip (ad clicks, touchpoints, events), payments table with **CAPI match
quality badges** (MQ 7/8/9 green, <7 orange), a platform-icon event feed with
IST timestamps, and the attribution callout (first-touch / last-touch /
attribution-credit per model). This is the "does attribution hold up on one
person" proof.

### 3. Reports — funnel (`#/reports`, top) — `shot-funnel-report.png`
Filters (client / model / window + Apply), 8 report KPIs (Leads, Net revenue,
Ad spend, ROAS, Show-up, Close rate, Cost/sale, Profit — all net of refunds),
then **Spend vs revenue — per ad** dual bars.

### 4. Reports — ad performance (`#/reports`, lower) — `shot-ad-performance.png`
**ROAS ranking** (attribution revenue vs spend, worst first), **Wasted spend**
table (spend ≥ threshold, 0 sales), **Lead source mix** donut, the full **Ad
performance** table, and **Meta vs Xacqora Track** (Meta-reported conversions
vs our counted leads, per ad, with the Δ column — PRD §5.7).

### 5. Client portal (`#/dashboard` as the client role) — `shot-client-portal.png`
Read-only client view: a banner stating exports are audit-logged, the
**Weekly client summary** card (auto every Monday 9 AM IST, `Download PDF` via
`/weekly.pdf`), and **My leads**. Phones show masked (`+91 •••• 0117`) — the
client role never sees full digits (S.4), enforced in the API layer, not just
the UI.

### The rest of the SPA
`#/leads` (filterable + `?ids=` drill-in banner), `#/pipeline` (drag-drop
kanban; disabled for read-only roles), `#/meta` hub (accounts, entity tree,
spend + CAPI log, live pull), `#/integrations` (14 adapters + webhook test),
`#/duplicates` (likely-dupes + merge), `#/admin` (users/2FA/settings/prune),
`#/pilot` (Phase G gates + accuracy checkers), `#/alerts` (Phase H monitoring
board + prod toggles). Role-gating hides team-only screens from the client
role entirely.

## What makes it "polished but honest"

- **Role-aware rendering** lives in `server/lib/api.js`
  (`maskContacts(user)`, `scopeOf(user, p)`), so masking/scoping happen in one
  place and the SPA can't bypass them. A client login gets only its own
  client's rows on either engine (RLS backstop on Postgres; query scoping on
  SQLite). `test/spa.js` (42 assertions) proves the masking + isolation +
  403-on-team-only contract headlessly on both engines.
- **Demo-populated, zero empty states** — the seed (not the UI) is what
  guarantees this; see "Open it" above.
- **Zero regression** — the SPA reads the same report functions
  (`server/lib/shared.js`) the classic screens render, so Phase R's exports,
  drill-down, net-of-refunds and Meta-vs-Track all carry over unchanged. The
  backend suite (7 suites + replay + sweep) stays green on both engines
  independently of the frontend.

## Files

| File | Role |
|---|---|
| `public/app/{index.html,app.js,ui.js,app.css}` | the SPA shell + screens + design system |
| `server/lib/api.js` | the JSON API (`/api/app/*`), role-aware + RLS-scoped |
| `server/index.js` | serves `/app` + `/app/*` assets and routes `/api/app/*` |
| `test/spa.js` | headless API-contract test (masking / scoping / 403), both engines |
| `scripts/screenshots.js` | CDP-driven capture of the 5 tour screens → `docs/screenshots/` |
| `docs/screenshots/shot-*.png` | the tour images (demo data, labelled as such) |
