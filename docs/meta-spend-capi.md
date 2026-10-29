# Module: Meta spend pull + CAPI push

**What it does** — connects ad accounts (system-user token preferred), pulls
campaigns / ad sets / ads / creatives and daily spend, stores spend in billing
currency and INR using a stored daily FX rate. CAPI sends
Lead / CompleteRegistration / Attended / Schedule / Purchase back to Meta with
hashed phone (SHA-256 of E.164 **without** the `+`), hashed email, fbc/fbp, client
IP, user agent and a deterministic `event_id` for dedup with the browser pixel;
records per-event match quality.

**Hard rules (PRD)** — never send an event twice; never send Purchase for a
refunded payment (the refund stays in our records instead); CAPI settings are
per-client (which pixel gets which events).

**Files** — `server/lib/meta.js` (`runMetaPull`, `pushCapiEvent`, `capi_log`
table), `server/lib/shared.js` (`buildCapiPayload`, `mockMetaPull`),
`server/screens.js` → `meta()` (accounts, daily spend, CAPI log), routes
`GET /meta/pull?acc=<id>` and the scheduled pull in `server/index.js`
(every 3h during the day + nightly; auto_pull flag per account).

**Mock mode** — with no live token, the pull uses `mockMetaPull()` synthetic data
so the demo still shows spend/ROAS. The CAPI log records `dry_run=1` rows. To go
live: set the `capi` setting to `live` and fill the `token` column — the fetch
call site is marked in `pushCapiEvent`.

**How to test** — trigger `GET /meta/pull?acc=1` then check the Meta screen's
daily spend table; post any payment webhook and the next queue tick creates a
`capi_log` row + marks the event `sent_to_meta=1` with an `event_id`.
Replay suite asserts `capi_log` rows appear.

**Open (Phase L)** — real Marketing API batches (20-day windows, official SDK
shape), failure alerts, and real CAPI POSTs.
