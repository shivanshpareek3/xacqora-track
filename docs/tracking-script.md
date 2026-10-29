# Module: xt.js tracking script

**What it does** — one line of JS pasted in the head of any landing page
(Lovable, FlexiFunnels, TagMango, WordPress, custom). On load it reads all UTMs
+ fbclid + Meta dynamic params (`campaign_id`, `adset_id`, `ad_id`), creates a
365-day first-party `visitor_id` cookie, creates `fbc` from `fbclid` if missing,
reads `fbp`, and POSTs a touchpoint. It auto-fills hidden fields (`xtm_*`) into
every form on the page so attribution travels with the form submit, and appends
the same values to outgoing links / checkout buttons so attribution survives the
redirect. If our server is down it queues in `localStorage` and retries.

**Constraints met** — 5,894 bytes (< 10 KB), plain TS-style bundle, no external
deps, sendBeacon-first with fetch fallback, no-cors safe.

**Files** — `public/xt.js` (served at `/xt.js` with CORS `*`), the ingest routes
`POST /api/ingest/touchpoint` and `/api/ingest/form` in `server/index.js`,
`processTrackerEvent` in the same file, demo landing page
`public/test-samples/demo-page.html` at `/demo`.

**How to test**
1. `node test/xt-queue.js` — headless: proves queue+retry survives the API being
   down (nothing is lost, flushes when it comes back).
2. Live: start the server, open
   `/demo?utm_source=facebook&fbclid=IWD&ad_id=ACT-100001-3001&campaign_id=CAM-101`,
   fill the form, watch the on-page console; the touchpoint + form_submit +
   lead appear in the DB within a second.

**Open** — bundle with a real build step if it ever grows; keep under 10 KB.
