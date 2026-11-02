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
role, zero full phone/email visible to the client role, client-1 sees no
client-2 data, CSV exports are masked + audit-logged, ingest returns 429 on
flood, backup/restore-drill passes, and the 2FA enroll→OTP→session flow works.
`node test/isolation.js` is the DB-layer isolation proof (S.1); `node
test/security.js` covers the AES-GCM / TOTP / rate-limit primitives.

**Phase S (done)** — client isolation enforced at the app data layer
(`WHERE client_id IN (...)` scoping in `screens.js` / `shared.js`, proven by
`test/isolation.js`). Secrets at rest: AES-256-GCM via `server/lib/security.js`
(master key from `XACQORA_SECRET_KEY`; the no-key dev fallback is flagged
insecure). 2FA: TOTP on team logins (enroll/disable from the Admin screen,
`two_factor_enforced` setting to mandate it org-wide). Exports: role-masked CSV
+ audit log. Backups: daily `VACUUM INTO` snapshot (keep-7) + monthly restore
drill (Postgres path: `pg_dump`/`pg_restore` as `xacq_backup`). Rate limits:
per-IP + per-endpoint sliding windows on the public ingest API.

**Phase P (done) — DB-level backstop: Postgres row-level security.** On the
Postgres engine (`DATABASE_URL` set) every client-bearing table carries
`ENABLE` + `FORCE ROW LEVEL SECURITY` policies keyed on two session GUCs
(`app.unrestricted`, `app.client_ids`); `makeTx(db, user)` pins each client
role to its own `client_ids` on a dedicated connection so the database itself
hides other clients' rows even from a bare `SELECT`. The default-open model
keeps unscoped system connections (ticker, queue, `pg_dump`, bare `psql`)
seeing all rows. `test/isolation.js` proves it on Postgres: a bare scan under
a client-2 scope returns only client-2 rows and a cross-client write is
rejected by the DB. See `server/pg.js`, `server/schema.pg.sql`,
`docs/auth-security.md` RLS note, and `CHANGELOG.md` (Phase P).
