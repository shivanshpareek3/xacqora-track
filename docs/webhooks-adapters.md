# Module: Ingest API + platform adapters

**What it does** — one public ingest API (`POST /api/ingest/<platform>`) with a
per-endpoint shared secret and a rate limit; every inbound payload is logged to
`webhook_log` (received / queued / processed / failed / test) so nothing disappears
silently. Payloads go through the in-process job queue (`server/lib/queue.js`,
backed by the `job` table) so a spike of 5,000 webinar joins never drops events.
Adapters normalise each platform into one shape:
`{ client_id, event_type, phone, email, name, city, amount, currency, product,
gateway_txn_id, status, ts, raw_payload }`. The router finds-or-creates the lead,
records an ad touchpoint for ad-driven events, creates the event (with dedup on
`gateway_txn_id` / `source_ref`), writes the `deal` row (idempotent on gateway txn
id), and auto-moves the pipeline stage.

**14 adapters** (all in `server/lib/adapters.js`):
meta_leadgen, tagmango, razorpay, cashfree, cosmofeed, aevent, zoom, calendly,
flexifunnels, pabbly, whatsapp, google_sheets (+ razorpay/cashfree refund
handling). Event type mapping and match key per platform follow the PRD table.

**Rules kept** — gateway transaction ID stops double-counting; a payment with no
matching lead creates a `source_unknown` lead that still counts in revenue; every
platform has a test button (Integrations screen) that POSTs a fake event and shows
where it landed in the webhook log.

**How to test** — `node test/replay.js` posts every sample payload through the
running server and asserts leads / events / deals / CAPI / dedup. Sample payloads
live in `test-samples/`. Add a platform = add one function to `ADAPTERS` + one
sample JSON + one assertion in replay.js.

**Open (Phase L)** — swap mock/dry-run for real signed webhooks; Razorpay/Cashfree
signature verification (HMAC) is the next task.
