# Adapter verification log (PRD week-1 rule)

Source of truth: `Xacq-Track.docx` Section 6 — "The developer confirms each
platform's current webhook and API options in week 1 before building."
Every row records what was verified, where, and when. UNVERIFIED rows carry a
reason + a retry date; nothing here is a guess.

Last pass: 2026-11-06 (v12 close-out retry). Previous pass: 2026-11-02 (Phase R fast-track).

## VERIFIED

| Platform | What we use | Verified spec | Source (exact) | Verified |
|---|---|---|---|---|
| Razorpay | `payment.captured/failed/refunded` webhooks | Header `X-Razorpay-Signature` = `HMAC-SHA256(rawBody, webhookSecret)`, hex. SDK: `crypto.createHmac('sha256', secret).update(body).digest('hex')`. The message is the RAW, unparsed request body ("do not parse or cast" per the docs). Secret = dashboard **webhook secret** (Live & Test mode have separate URLs; ports 80/443 only). IP allowlist is a separate control. | `razorpay/razorpay-node` `lib/utils/razorpay-utils.js` → `validateWebhookSignature` (https://raw.githubusercontent.com/razorpay/razorpay-node/master/lib/utils/razorpay-utils.js); docs: https://razorpay.com/docs/webhooks/validate-test | **2026-11-02 (re-verified, spec unchanged)** |
| Cashfree | Payout + PG webhooks | Header `X-Cf-Signature` = `HMAC-SHA256(rawBody, clientSecret)`, hex. SDK: `crypto.createHmac('sha256', clientSecret).update(body).digest('hex')` over `body.toString()`. Secret = **client secret** from dashboard (payouts flow). | `cashfree/cashfree-sdk-nodejs` `lib/payouts/services/verifySignature.js` (https://raw.githubusercontent.com/cashfree/cashfree-sdk-nodejs/master/lib/payouts/services/verifySignature.js) | **2026-11-02 (re-verified, spec unchanged)** |
| Calendly | Meeting / booking webhooks | Header `Calendly-Webhook-Signature` = `t=<unixTs>,v1=<hex>` where `v1` = `HMAC-SHA256(secret, String(ts) + "." + rawBody)` — the timestamp is **part of the signed message** (replay guard). Secret = the shared webhook secret Calendly generates. Verified in `server/lib/liveapi.js` via `calendlyVerifySignature` (tolerance 3 min, matching the docs example). | `developer.calendly.com` webhook-signatures guide (https://developer.calendly.com/api-docs/overview/webhooks/webhook-signatures) | **2026-11-06 (first-verified)** |

The gateway specs were re-fetched against the current official SDK source on 2026-11-02 and
match `server/lib/liveapi.js` exactly. Calendly was first-verified on 2026-11-06 against the
official developer docs (previously UNVERIFIED — the auth-gated `/developers/` path the
2026-11-02 pass hit now 404s; the current `developer.calendly.com` API docs are public and
fetchable, so the UNVERIFIED marker was removed and a native HMAC path added in
`server/lib/liveapi.js` + a sample-signed-payload regression in `test/liveapi.js`).
**There are zero pending items for Razorpay, Cashfree, or Calendly.**

## BUGS this verification caught (fixed in `server/lib/liveapi.js`)

1. **Algorithm was wrong**: we had HMAC-SHA512; both official SDKs use
   **HMAC-SHA256**. Live mode would have rejected every real gateway delivery.
2. **Cashfree header was wrong**: we read `x-cashfree-signature`; the real
   header is **`X-Cf-Signature`**.
Both regressions are guarded in `test/liveapi.js` (a SHA512 signature must now
be *rejected*; the legacy header must be *ignored*).

## UNVERIFIED (retry on the given date; no code change in the meantime)

Re-checked **2026-11-06** (v12 close-out) against the live docs. **Calendly has been promoted
to VERIFIED** (its official `developer.calendly.com` API docs are now public and fetchable — the
auth-gated `/developers/` path the 2026-11-02 pass hit now 404s). The remaining four are still
UNVERIFIED by policy: their current docs remain **unreachable from the build environment**
(SPA shells that render no body to a plain fetch, 404s on the canonical paths, auth-gated, or a
hostname that does not resolve) and `web_search` returned no usable official spec. Retry dates
bumped again for the ones still blocked.

| Platform | Status | Reason it is UNVERIFIED (2026-11-06) | Retry |
|---|---|---|---|
| Aevent | UNVERIFIED | Hostname does not resolve (`aevent.io` DNS-fails) and help-center / API pages are JS SPAs with no webhook/signature text; no public API spec found via search. | 2026-11-20 |
| Zoom | UNVERIFIED | Official guide paths (`developers.zoom.us/docs/webhooks/...`) still 404 to a SPA shell, so no first-party source. A **third-party reference** (a webhook-provider's published Zoom skill doc) now states the current security spec as `x-zm-signature` = `v0=<HMAC-SHA256(secret, "v0:"+ts+":"+rawBody)>` + `x-zm-request-timestamp`, i.e. the older token+secret/`method+uri+date+body` form is **not** current. Stays UNVERIFIED until a first-party source confirms; code keeps the shared-secret fallback. | 2026-11-20 |
| Pabbly | UNVERIFIED | `apidocs.pabbly.com` renders no webhook-security content; no public signature spec found via search. Pabbly is also our fallback router (PRD §6), so its inbound spec only matters when used. | 2026-11-27 |
| FlexiFunnels | UNVERIFIED | No public webhook docs page found (404 / empty shell); no spec via search. Likely "form webhook + CAPI links" per PRD table. | 2026-11-27 |

Current safe defaults (updated 2026-11-06): Calendly now has a native
HMAC path (`calendlyVerifySignature` in `server/lib/liveapi.js`) backed by the
verified spec. The remaining unverified platforms (Aevent, Zoom, Pabbly,
FlexiFunnels) fall back to the per-endpoint shared-secret check already enforced
in the ingest API (`server/index.js` → `handleIngest`). So a spoofed payload for
any of those is rejected by the endpoint secret until each platform's native
verification is wired.

## How to re-run the verification

```bash
node test/liveapi.js          # regression: gateway signatures
# to re-probe platform docs (network needed):
node test/spec-research.js    # kept as a scratch probe
```
