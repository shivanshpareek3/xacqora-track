# Adapter verification log (PRD week-1 rule)

Source of truth: `Xacq-Track.docx` Section 6 — "The developer confirms each
platform's current webhook and API options in week 1 before building."
Every row records what was verified, where, and when. UNVERIFIED rows carry a
reason + a retry date; nothing here is a guess.

Last pass: 2026-11-02 (Phase R fast-track). Previous pass: 2026-10-30 (Phase L).

## VERIFIED

| Platform | What we use | Verified spec | Source (exact) | Verified |
|---|---|---|---|---|
| Razorpay | `payment.captured/failed/refunded` webhooks | Header `X-Razorpay-Signature` = `HMAC-SHA256(rawBody, webhookSecret)`, hex. SDK: `crypto.createHmac('sha256', secret).update(body).digest('hex')`. The message is the RAW, unparsed request body ("do not parse or cast" per the docs). Secret = dashboard **webhook secret** (Live & Test mode have separate URLs; ports 80/443 only). IP allowlist is a separate control. | `razorpay/razorpay-node` `lib/utils/razorpay-utils.js` → `validateWebhookSignature` (https://raw.githubusercontent.com/razorpay/razorpay-node/master/lib/utils/razorpay-utils.js); docs: https://razorpay.com/docs/webhooks/validate-test | **2026-11-02 (re-verified, spec unchanged)** |
| Cashfree | Payout + PG webhooks | Header `X-Cf-Signature` = `HMAC-SHA256(rawBody, clientSecret)`, hex. SDK: `crypto.createHmac('sha256', clientSecret).update(body).digest('hex')` over `body.toString()`. Secret = **client secret** from dashboard (payouts flow). | `cashfree/cashfree-sdk-nodejs` `lib/payouts/services/verifySignature.js` (https://raw.githubusercontent.com/cashfree/cashfree-sdk-nodejs/master/lib/payouts/services/verifySignature.js) | **2026-11-02 (re-verified, spec unchanged)** |

Both specs were re-fetched against the current official SDK source on 2026-11-02 and match
`server/lib/liveapi.js` exactly — no code change. The two "pending" markers that existed
in earlier drafts (algorithm + Cashfree header name) were corrected in Phase L and are now
guarded by `test/liveapi.js` regressions; **there are zero pending items for Razorpay or
Cashfree.**

## BUGS this verification caught (fixed in `server/lib/liveapi.js`)

1. **Algorithm was wrong**: we had HMAC-SHA512; both official SDKs use
   **HMAC-SHA256**. Live mode would have rejected every real gateway delivery.
2. **Cashfree header was wrong**: we read `x-cashfree-signature`; the real
   header is **`X-Cf-Signature`**.
Both regressions are guarded in `test/liveapi.js` (a SHA512 signature must now
be *rejected*; the legacy header must be *ignored*).

## UNVERIFIED (retry on the given date; no code change in the meantime)

Re-checked 2026-11-02 against the live docs: these platforms' current docs are **unreachable
from the build environment** (SPA shells that render no body to a plain fetch, 404s on the
canonical paths, auth-gated, or a hostname that does not resolve — `developer.cashfree.com`
DNS-failed and `developers.zoom.us/docs/guides/webhooks/...` now 404s), and `web_search`
returned no usable results. So they stay UNVERIFIED by policy, with retry dates bumped.

| Platform | Status | Reason it is UNVERIFIED (2026-11-02) | Retry |
|---|---|---|---|
| Aevent | UNVERIFIED | Help-center / API pages are JS SPAs — no webhook/signature text in the served HTML; no public API ref found via search. | 2026-11-09 |
| Zoom | UNVERIFIED | Canonical guide paths 404 to a SPA shell; security spec (`X-Zm-Verification-Request` / `X-Zm-Signature`, HMAC-SHA256 over `method+uri+date+body` keyed on `token+secret`) could not be re-confirmed against a live source. | 2026-11-09 |
| Calendly | UNVERIFIED | Webhook/subscriptions docs paths 404 / auth-gated; whether webhooks use a shared secret vs. an HMAC signature is not confirmable unauthenticated. | 2026-11-09 |
| Pabbly | UNVERIFIED | Pabbly docs pages serve an empty shell (no content). Pabbly is also our fallback router (PRD §6), so its inbound spec only matters when used. | 2026-11-16 |
| FlexiFunnels | UNVERIFIED | No public webhook docs page found (404 shell). Likely "form webhook + CAPI links" per PRD table. | 2026-11-16 |

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
