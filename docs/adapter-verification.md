# Adapter verification log (PRD week-1 rule)

Source of truth: `Xacq-Track.docx` Section 6 — "The developer confirms each
platform's current webhook and API options in week 1 before building."
Every row records what was verified, where, and when. UNVERIFIED rows carry a
reason + a retry date; nothing here is a guess.

Last pass: 2026-10-30 (Phase L, resume).

## VERIFIED

| Platform | What we use | Verified spec | Source (exact) | Verified |
|---|---|---|---|---|
| Razorpay | `payment.captured/failed/refunded` webhooks | Header `X-Razorpay-Signature` = `HMAC-SHA256(rawBody, webhookSecret)`, hex. SDK: `crypto.createHmac('sha256', secret).update(body).digest('hex')`. Secret = dashboard **webhook secret** (Live & Test mode have separate URLs; ports 80/443 only). IP allowlist is a separate control. | `razorpay/razorpay-node` `lib/utils/razorpay-utils.js` → `validateWebhookSignature` (https://github.com/razorpay/razorpay-node/blob/master/lib/utils/razorpay-utils.js); docs confirm header + secret at https://razorpay.com/docs/webhooks/validate-test | 2026-10-30 |
| Cashfree | Payout + PG webhooks | Header `X-Cf-Signature` = `HMAC-SHA256(rawBody, clientSecret)`, hex. SDK: `crypto.createHmac('sha256', clientSecret).update(body).digest('hex')`. Secret = **client secret** from dashboard (payouts flow). | `cashfree/cashfree-sdk-nodejs` `lib/payouts/services/verifySignature.js` (https://github.com/cashfree/cashfree-sdk-nodejs/blob/master/lib/payouts/services/verifySignature.js) | 2026-10-30 |

## BUGS this verification caught (fixed in `server/lib/liveapi.js`)

1. **Algorithm was wrong**: we had HMAC-SHA512; both official SDKs use
   **HMAC-SHA256**. Live mode would have rejected every real gateway delivery.
2. **Cashfree header was wrong**: we read `x-cashfree-signature`; the real
   header is **`X-Cf-Signature`**.
Both regressions are guarded in `test/liveapi.js` (a SHA512 signature must now
be *rejected*; the legacy header must be *ignored*).

## UNVERIFIED (retry on the given date; no code change in the meantime)

| Platform | Status | Reason it is UNVERIFIED | Retry |
|---|---|---|---|
| Aevent | UNVERIFIED | Help-center pages are JS SPAs — no webhook/signature text in the served HTML from this environment. | 2026-11-06 |
| Zoom | UNVERIFIED | Doc paths found in 2025 (`marketplace.zoom.us/docs/guides/webhooks/...`) now serve a 404 SPA shell; security spec (`X-Zm-Verification-Request` / `X-Zm-Signature`, HMAC-SHA256 with secret + token) could not be re-confirmed. | 2026-11-06 |
| Calendly | UNVERIFIED | API docs require auth (401); webhook security (shared API key vs. signature) not confirmable unauthenticated. | 2026-11-06 |
| Pabbly | UNVERIFIED | Pabbly docs pages serve an empty shell (2.8 KB, no content). Pabbly is also our fallback router (PRD §6), so its inbound spec only matters when used. | 2026-11-13 |
| FlexiFunnels | UNVERIFIED | No public docs page found for webhooks (404 shell). Likely "form webhook + CAPI links" per PRD table. | 2026-11-13 |

Current safe defaults (unchanged, documented): unverified platforms fall back
to the per-endpoint shared-secret check already enforced in the ingest API
(`server/index.js` → `handleIngest`). So a spoofed Aevent/Zoom/Calendly/Pabbly
payload is rejected by the endpoint secret until each platform's native
verification is wired.

## How to re-run the verification

```bash
node test/liveapi.js          # regression: gateway signatures
# to re-probe platform docs (network needed):
node test/spec-research.js    # kept as a scratch probe
```
