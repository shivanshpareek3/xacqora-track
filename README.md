# Xacqora Track

Lead tracker & attribution CRM. For every lead it shows which ad brought them in,
every ad they clicked after that, where they stand in the funnel, and whether they paid.
It pulls Meta spend and sends real outcomes back to Meta through the Conversions API.

This repo is a **zero-dependency demo build** (Node 24 + built-in `node:sqlite`), built
from the "Xacqora Track: Product Requirements" doc. Every module in Section 5 of the doc
has a working implementation; the Meta spend pull and CAPI push run in a mock/dry-run
mode so no live tokens are needed. Wire in the real Meta + gateway calls where marked.

## Run it

```bash
npm run seed     # one-time: users, 2 clients, 2 ad accounts, sample leads
npm start        # http://localhost:4100/signin   (password: xacqora)
```

Demo users (all password `xacqora`):

| email | role |
|---|---|
| owner@xacqora.local | owner |
| arpit@xacqora.local | media_buyer |
| rep@xacqora.local | sales_rep |
| client@xacqora.local | client (read-only portal, client 1 only) |

Tracking test target: `http://localhost:4100/demo?utm_source=facebook&utm_medium=paid&utm_campaign=CAM-101&fbclid=IWD&campaign_id=CAM-101&adset_id=ACT-100001-111&ad_id=ACT-100001-3001`

## Screens (all 14 from Section 5.E)

Dashboard, Leads, Lead timeline, Pipeline (kanban + list), Reports, Meta hub,
Integrations, Duplicates, Client portal, Import, Admin (users/roles/audit),
Sign in, Meta spend, Weekly summary.

## What's wired

- **Tracking (`xt.js`)** — `<10 KB`, first-party visitor cookie, fbc from fbclid,
  auto-fills hidden form fields, appends attribution to outgoing links, queue + retry.
- **Ingest API** — `/api/ingest/<platform>` with per-endpoint secret + rate limit.
  Every inbound payload is logged (`webhook_log`) with processed / failed / duplicate status.
- **14 platform adapters** — Meta leadgen, TagMango, Razorpay, Cashfree, Cosmofeed,
  Aevent, Zoom, Calendly, FlexiFunnels, Pabbly, WhatsApp, Google Sheets/CSV.
- **Identity** — phone normalised to `+91…` (E.164), match on phone then email,
  anonymous visitor touchpoints attach to the lead on form fill, never merge across clients.
- **Events + pipeline** — every action is an event on the lead timeline;
  auto stage moves (`webinar_joined -> Attended`, `payment_success -> Paid`, …).
- **Meta pull** — scheduled ad account pull (spend + entities), mock generator when no token.
- **CAPI push** — hashed phone/email, fbc/fbp, deterministic `event_id` for dedup;
  never sends twice, suppresses Purchase on refund, records Event Match Quality.
- **Attribution** — last paid click (default, 30d), first click, linear, lead source;
  window editable per client. Reports: funnel, ad performance, wasted spend,
  new vs old, Meta vs Xacqora Track, source mix, weekly summary.
- **Security** — session auth, roles, masked phones for roles without need,
  audit log, privacy deletion that stops future CAPI.

## Module docs (the context contract for every AI session)

- `docs/tracking-script.md` — xt.js: what it does, size, how to test queue+retry
- `docs/webhooks-adapters.md` — ingest API, all 14 adapters, dedup + log rules
- `docs/identity.md` — phone normalisation, matching, duplicate merge, deletion
- `docs/meta-spend-capi.md` — spend pull + CAPI push (dedup, hashing, PRD rules)
- `docs/reports-attribution.md` — 4 models, 7 reports, settings keys
- `docs/auth-security.md` — roles, masking, client isolation, audit

## Tests

```bash
npm test        # replays each sample payload through the live ingest API on a throwaway DB
npm run tracker # demo landing page target
bash test/sweep.sh   # all 14 screens + client isolation + masking + xt.js size gate
node test/xt-queue.js # xt.js survives the API being down (nothing lost)
```

`test-samples/*.json` are saved sample payloads (fake data — never real client data).

## Notes / open decisions (from the doc)

- Final product name, pilot accounts, product owner / lead dev names, hosting budget,
  attribution default, and whether client sales reps log calls are still Arpit's calls.
- Postgres + row-level security, and the real Meta/gateway SDK calls, are the production
  next step; this build stands in with SQLite + mocks.
