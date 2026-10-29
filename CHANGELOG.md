# CHANGELOG

Every completed task lands here so the next AI session has context. Newest first.

## 2026-10-30 (Phase S)

### Phase S — Security checklist (PRD §10)
- **S.1 Client isolation at the data layer** — `test/isolation.js` proof: (a) canary
  leads/revenue/ads in two clients, rendered through every screen + every report
  function as client-2's user; no client-1 marker leaks anywhere; `?client=` filters
  cannot widen a client login's scope; cross-client lead routes are refused.
  (b) query-dump: wraps the tx API, captures every data-table statement in the
  scoped reports, asserts lead-table reads carry a client filter, no unscoped
  top-level aggregation, and no FK child lookup touches a foreign client's key.
- **S.2 Secrets encrypted at rest (AES-256-GCM)** — new `server/lib/security.js`
  (`encryptSecret`/`decryptSecret`, master key from `XACQORA_SECRET_KEY`; the
  no-env-key dev fallback is flagged insecure). Meta tokens, webhook endpoint
  secrets and TOTP secrets are now stored encrypted; decrypt-at-read is wired
  in `server/lib/meta.js` (pull + CAPI) and `server/index.js` (ingest secret
  check + live gateway signature verify). Seed writes encrypted blobs.
- **S.3 2FA for team logins (TOTP, RFC 6238)** — `user.totp_secret`/`totp_enabled`
  + a short-lived `tfa_pending` row. Sign-in for a 2FA-enabled account (or a
  team account when `settings.two_factor_enforced=1`) redirects to `/2fa/verify`;
  a correct 6-digit code (±1 step drift, timing-safe, 5-strike lockout) issues
  the session; wrong codes are rejected and audited. Admin screen: enroll /
  disable with an on-screen authenticator-app secret (never in the URL).
- **S.4 Masking + export audit** — `maskEmail`/`roleSeesFullContacts` in
  `shared.js`; phone AND email are masked in every role-conditional view
  (leads, lead timeline, pipeline, portal) for roles without full-contact
  access. New `GET /export/leads` and `GET /export/ report` (CSV, client- and
  role-scoped, phone/email masked for the caller's role) — every export writes
  an `audit_log` row (`export.csv`).
- **S.5 Backups + restore drill** — `scripts/backup.js` (WAL-safe `VACUUM INTO`
  snapshot into `backups/`, keep-7 retention), `server/lib/backup.js` invoked
  once per IST calendar day by the ticker; `scripts/restore-drill.sh` restores
  the newest snapshot into a fresh temp dir and asserts every table opens and
  its counts are sane (exit non-zero on failure).
- **S.6 Ingest rate limits (per-IP + per-endpoint)** — `security.js rateLimit()`
  sliding-window limiter; the public ingest API now 429s a per-IP flood
  (`XT_RATE_PER_MIN_IP`, default 600/min) and a per-endpoint window
  (`XT_RATE_PER_MIN_ENDPOINT`, default 300/min), with `Retry-After`.
- **Tests** — `test/security.js` (AES round-trip + tamper-fail, RFC 6238 TOTP
  vectors + drift window, rate-limit buckets, client-access rules) and
  `test/isolation.js` (S.1 proof). `test/sweep.sh` gains S.4/S.5/S.6/S.3 gates.
- **Bug fixed** — `shared.js adPerformance` scoped path: `meta_adset` has no
  `client_id` column, so ad scoping now goes through `meta_ad.ad_account_id →
  meta_ad_account.client_id`; the unscoped all-ads spend fallback no longer
  runs when a client scope is active (spend could otherwise leak across clients).

## 2026-10-30 (Phase L)

### Phase L (close): gateway signature specs VERIFIED + 2 real bugs fixed
- Verified Razorpay + Cashfree signature specs against **official SDK source**
  (not just docs): both use **HMAC-SHA256** over the raw body, hex-encoded.
  - Razorpay: header `X-Razorpay-Signature`, key = webhook secret
    (`razorpay/razorpay-node` → `validateWebhookSignature`).
  - Cashfree: header `X-Cf-Signature`, key = client secret
    (`cashfree/cashfree-sdk-nodejs` → `verifySignature`).
- **Bug 1 (would have broken all live gateway deliveries):** `liveapi.js` used
  HMAC-SHA512; now SHA256, matching both SDKs.
- **Bug 2:** Cashfree header read as `x-cashfree-signature`; the real header is
  `X-Cf-Signature`.
- `test/liveapi.js` now uses a **real sample-signed payload** per gateway +
  negative cases (tampered body, wrong secret, missing header) + regression
  guards (SHA512 must be rejected; legacy Cashfree header ignored).
- `docs/adapter-verification.md`: VERIFIED vs UNVERIFIED log with source URLs +
  dates. UNVERIFIED (docs not reachable/SPA): Aevent, Zoom, Calendly, Pabbly,
  FlexiFunnels — each with a retry date. They stay on the shared-secret
  endpoint check until wired.
- Scratch probe `test/spec-research.js` kept for re-running the week-1 check.

## 2026-10-29 (later)

### Phase L — opt-in live integration layer
- Added `server/lib/liveapi.js`: `MOCK=1` (dev default) forces mock;
  `XACQORA_LIVE=1` opts into real API calls. Inbound gateway signature check
  (Razorpay/Cashfree HMAC-SHA512, shared-secret for the rest), batched Meta
  Marketing API pull, and a real CAPI POST.
- `runMetaPull` / `pushCapiEvent` now take the live path only when a real
  (non-MOCK) token is configured; failures alert + back off instead of dropping
  the queue (PRD risk rule).
- Ingest rejects unsigned gateway payloads at the edge in live mode.
- New test `test/liveapi.js` (3 checks) — mock skips signatures, live validates
  a correct HMAC and rejects invalid/missing.
- Wrote the 6 module READMEs under `docs/` so the next session has context.

## 2026-10-29

### Verification gate (phase-0 skeleton verified)
- Full page sweep: all 14 screens + demo page + xt.js return 200 as owner; team-only screens 403 for the client role.
- Phone masking verified: client role sees 0 full phone numbers; owner sees all.
- xt.js confirmed 5,894 bytes (< 10 KB limit).
- xt-queue harness (`test/xt-queue.js`): proves events are held in localStorage when the API is down and flush when it returns — nothing lost.
- Replay suite (`test/replay.js`): 15/15 assertions on a fresh DB, including duplicate-payload safety.

### Client data isolation
- Reports, dashboard, leads list and funnel/attribution math now scope by the logged-in user's allowed clients. Client logins can only see their own client's numbers; team roles see all internal clients (filterable).
- Client-1 login verified to see no client-2 leads, ad accounts, or spend.

### Bugs fixed
- Razorpay adapter: was mis-reading nested webhook payload (`payload.event` is a string; entity lives under `payload.payload.payment.entity`). Fix stopped null gateway_txn_ids.
- `getOrCreateLead`: `const p` was re-assigned; lead INSERT had one too few placeholders.
- Touchpoint INSERT had 20 placeholders for 19 columns.
- Meta pixel lookup used the wrong column.
- CAPI push: job payload was missing `client_id`.
- `funnelReport(null)` matched zero leads; now null = all clients, number = one client.
- Seed INSERTs: placeholder/arg count mismatches.

## 2026-10-28

### Initial build (from Xacq-Track.docx PRD)
- Zero-dependency Node 24 + built-in SQLite demo build.
- 13+ table schema, identity rules, 14 platform adapters, webhook queue,
  auto stage moves, Meta spend pull + CAPI push (mock/dry-run), 4 attribution
  models, 7 reports, 5-role auth with masking + audit log, 14 demo screens,
  xt.js tracking script, CSV import, seed + replay tests.
