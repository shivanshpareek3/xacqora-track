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

## v14 — Webhooks & API Keys screen + FlexiFunnels live-lead pipeline

**Token-in-URL inbound endpoints.** The "Webhooks & API Keys" screen
(`#/webhooks`, team-only) generates a public URL per client + platform:
`POST /webhooks/<platform>/<slug>/<token>` (40-hex token = the endpoint's
auth; FlexiFunnels sends no signature header, so the token is its "secret"
per the PRD rule "every inbound webhook verified by signature **or**
secret"). Each endpoint row has: client · platform · description · URL
(copy) · event scope (`all` / `leads` / `purchases`) · status
(active/paused/revoked) · last event · total events · Rotate. Paused
endpoints accept-and-ignore; revoked ones return 410. Multiple endpoints
per client + platform are supported (e.g. a form webhook scoped to `leads`
and a purchase webhook scoped to `purchases` — out-of-scope events are
logged + skipped, never cross-posted).

**FlexiFunnels adapter (live leads).** Two paste points in FlexiFunnels:
Forms → Webhook (lead-creating) and Products/Purchases → Webhook
(deal-creating). The adapter maps both: `form_submit` (or `registered` when
the client's field_map sets `event_type`), `checkout_started` (pending
order), `payment_success` (paid order). Phone is normalised to E.164;
a purchase with no matching lead creates a `source_unknown` lead that
still counts in revenue (existing rule). Duplicates are blocked on
`gateway_txn_id` (order id). Because FlexiFunnels pages don't run `xt.js`,
`utm_*` hidden form fields + `page_url` are captured onto a touchpoint so
ad attribution works without the pixel; the lead timeline shows a
"UTM attribution" source card, and the dashboard's "New leads" card lists
the real incoming leads (name masked per role · source · form title ·
phone · when). Every event lands in `webhook_log`
(processed/queued/failed/duplicate/paused/skipped_scope + payload) and is
visible on both the Integrations and the new Webhooks & API Keys screens.

**API keys (`xak_…`).** The screen's second section creates Bearer API
keys for script access to `/api/app/*`: `Authorization: Bearer xak_…`
(or `X-API-Key: xak_…`). Keys are scoped to a client (or workspace-level)
× permission (read-only is GET-only; read-write allows POST). The
plaintext is shown **once** at creation; only the sha256 hash is stored
(`api_keys.key_hash`), and `last_used_at` / `revoked_at` are tracked.

**Public-URL requirement.** A generated URL only works when FlexiFunnels
can actually reach it:
- Production: the app's public domain (Vercel) — set `APP_URL`
  (or `XACQORA_PUBLIC_URL`) to it and the screen generates URLs on that
  base. The screen shows a "prod domain in use" state (no dev notice).
- Dev: without `APP_URL` the URLs use the local host, which FlexiFunnels
  cannot reach. Two options: a tunnel (`cloudflared tunnel --url
  http://localhost:<PORT>`, or `ngrok http <PORT>`) and paste the tunnel
  URL into FlexiFunnels, or deploy (docs/deploy.md — Arpit's hosting
  decision). The screen warns this in a dev-notice band.
