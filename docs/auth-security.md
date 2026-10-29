# Module: Auth, roles, masking, audit

**What it does** — session-token auth (HttpOnly cookie, 30-day TTL), 5 internal
roles (owner, admin, media_buyer, sales_rep, viewer) + a `client` role that is
locked to its own `client_ids` and is read-only by default. Phone numbers are
masked (last 4 shown) for any role that does not need them; client logins never
see another client's leads, reports, spend, or team screens (403). Every view /
export / change writes to the audit log; a privacy deletion (`POST /admin/prune`)
removes the lead and marks its future CAPI events suppressed.

**Files** — `server/lib/auth.js` (hashPassword, session, `userFromCookie`,
`audit`), role guard `requireUser` + route table in `server/index.js`,
masking in `server/screens.js` (`phoneOf`, `maskPhone` in shared.js),
`user` + `session_token` + `audit_log` tables in `server/schema.sql`.

**Demo logins** (password `xacqora`, seeded by `scripts/seed.js`):
owner@, arpit@ (media_buyer), rep@ (sales_rep), client@ (client, read-only,
client 1 only).

**How to test** — `bash test/sweep.sh` asserts: team screens 403 for the client
role, zero full phone digits visible to the client role, client-1 sees no
client-2 data on leads/reports/dashboard.

**Open (Phase S)** — client isolation is currently enforced at the app layer
(`WHERE client_id IN (...)` scoping in `screens.js` / `shared.js`); move it to
database row-level security in Postgres. Secret storage, 2FA, and backup/restore
drill are still PRD Section 10 items, not wired yet.
