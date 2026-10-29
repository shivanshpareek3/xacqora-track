# CHANGELOG

Every completed task lands here so the next AI session has context. Newest first.

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
