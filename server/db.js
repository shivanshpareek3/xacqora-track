// Storage layer. Two engines, one API:
//   * SQLite (default, zero-dep) — node:sqlite built into Node 24. Used for
//     local dev + tests.
//   * Postgres (live) — when DATABASE_URL is set, the synchronous pg facade
//     (server/pg.js, backed by pg-native/libpq) is used instead, so the whole
//     app stays synchronous on either engine. Postgres adds ROW LEVEL SECURITY
//     on every client_id-bearing table (schema.pg.sql) as a DB-level backstop
//     to the JS scoping the app already does.
//
// The handle returned by open() exposes .prepare/.exec (node:sqlite shape);
// makeTx(db) returns { db, run, get, all } where run() -> { changes,
// lastInsertRowid } — the sync shape every call site was written against.
const fs = require('node:fs');
const path = require('node:path');

function engine() {
  return process.env.DATABASE_URL ? 'pg' : 'sqlite';
}

function open() {
  if (process.env.DATABASE_URL) {
    // Live engine: Postgres. Load the PG DDL + RLS DDL on a system connection
    // (unrestricted scope), and hand back a handle. The app role must be a
    // non-superuser, or RLS is bypassed entirely.
    //
    // handle structure:
    //   .prepare / .exec  — the SYSTEM connection (team roles, ingest, queue,
    //                       backup). One shared libpq connection; the app is
    //                       single-process so shared sync state is safe.
    //   .scoped(user)    — a dedicated connection pinned to that user's RLS
    //                       scope (client role -> its own client_ids; team ->
    //                       unrestricted). Cached per scope signature so
    //                       concurrent requests never share a client's session.
    //   .close()
    const { PgConn, setScope, userScope } = require('./pg');
    const sys = new PgConn(process.env.DATABASE_URL);
    sys.exec(fs.readFileSync(path.join(__dirname, 'schema.pg.sql'), 'utf8'));
    // Phase R: Meta-reported conversions for the Meta-vs-Track report.
    // schema.pg.sql already declares the column; this ADD COLUMN IF NOT EXISTS
    // covers a live db created before it. (DDL is not subject to the FORCE RLS
    // row policies, so the owner role can alter its own table.)
    sys.exec(`ALTER TABLE spend_daily ADD COLUMN IF NOT EXISTS conversions INTEGER DEFAULT 0`);
    // Meta token-expiry (live connect): where the last /debug_token check noted
    // when the per-account system-user token expires, for the /alerts warning.
    sys.exec(`ALTER TABLE meta_ad_account ADD COLUMN IF NOT EXISTS token_expires_at TEXT`);
    // v9: the account's billing currency (the adaccount `currency` field —
    // live-verified; `currency_code` does not exist and 400s with #100).
    // Recorded so the dashboard KPIs can show billing currency + INR together.
    sys.exec(`ALTER TABLE meta_ad_account ADD COLUMN IF NOT EXISTS currency TEXT`);
    // v11: mark a seed/demo client so its whole dataset hides in DATA_MODE=live.
    sys.exec(`ALTER TABLE client ADD COLUMN IF NOT EXISTS demo INTEGER DEFAULT 0`);
    // v13 spend-accuracy: meta_accuracy_check shipped first on the INR-basis
    // shape (app_spend_inr/meta_spend_inr, no currency); v11 re-shaped it to
    // NATIVE currency units (app_spend/meta_spend/currency). CREATE TABLE IF
    // NOT EXISTS cannot extend an existing table, so pre-v11 DBs are missing
    // the new columns and every /meta/check upsert fails ("no column named
    // app_spend"). Add them idempotently; the old _inr columns are left
    // unused (the table holds only completed checks, which re-checks overwrite).
    sys.exec(`ALTER TABLE meta_accuracy_check ADD COLUMN IF NOT EXISTS app_spend DOUBLE PRECISION NOT NULL DEFAULT 0`);
    sys.exec(`ALTER TABLE meta_accuracy_check ADD COLUMN IF NOT EXISTS meta_spend DOUBLE PRECISION NOT NULL DEFAULT 0`);
    sys.exec(`ALTER TABLE meta_accuracy_check ADD COLUMN IF NOT EXISTS currency TEXT`);
    // v14 (Webhooks & API Keys): token-in-URL inbound endpoint columns +
    // lifecycle fields. Pre-v14 DBs only have client_id/platform/url/secret.
    for (const c of [
      `ALTER TABLE webhook_endpoint ADD COLUMN IF NOT EXISTS slug TEXT`,
      `ALTER TABLE webhook_endpoint ADD COLUMN IF NOT EXISTS token_hash TEXT`,
      `ALTER TABLE webhook_endpoint ADD COLUMN IF NOT EXISTS description TEXT`,
      `ALTER TABLE webhook_endpoint ADD COLUMN IF NOT EXISTS events TEXT DEFAULT 'all'`,
      `ALTER TABLE webhook_endpoint ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'`,
      `ALTER TABLE webhook_endpoint ADD COLUMN IF NOT EXISTS events_total INTEGER DEFAULT 0`,
      `ALTER TABLE webhook_endpoint ADD COLUMN IF NOT EXISTS last_event_at TEXT`,
      `ALTER TABLE webhook_endpoint ADD COLUMN IF NOT EXISTS created_at TEXT`,
    ]) sys.exec(c);
    setScope(sys, null); // system default: see every row

    const scopedCache = new Map();
    const sigOf = (user) => {
      const s = userScope(user);
      return s.unrestricted ? '*' : ('c:' + (s.clientIds || []).join(','));
    };
    return {
      engine: 'pg',
      prepare: (sql) => sys.prepare(sql),
      exec: (sql) => sys.exec(sql),
      scoped(user) {
        const sig = sigOf(user);
        if (!scopedCache.has(sig)) {
          const c = new PgConn(process.env.DATABASE_URL);
          setScope(c, user);
          scopedCache.set(sig, c);
        }
        return scopedCache.get(sig);
      },
      close() { sys.close(); for (const c of scopedCache.values()) c.close(); },
      _systemConn: sys,
    };
  }

  // Local dev / tests: zero-dependency SQLite.
  //
  // Serverless guard (Vercel, PRD: "Vercel DB = Postgres, SQLite kabhi nahi"):
  // the Vercel function runtime is ephemeral (filesystem resets between
  // invocations) and node:sqlite is NOT part of the Vercel Node runtime — so
  // if DATABASE_URL is missing on a serverless target we must fail LOUDLY at
  // boot rather than silently open a SQLite file that vanishes (losing every
  // lead/event/deal). Vercel sets the VERCEL env var; a local `node`/test
  // never does, so this guard is a no-op for `node server/index.js` + tests.
  if (process.env.VERCEL && !process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required on the serverless target (Vercel). The app stores on Postgres there; the SQLite fallback is local-dev only. Set the DATABASE_URL env var (managed Postgres, sslmode=require).');
  }
  // node:sqlite is required LAZY, inside this SQLite-only branch, so the
  // serverless/Postgres path (DATABASE_URL set) never loads node:sqlite at all.
  const { DatabaseSync } = require('node:sqlite');
  const dbFile = process.env.XACQORA_DB_FILE || path.join(__dirname, '..', 'xacqora.sqlite3');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // lazily add tables that are created later in the codebase
  db.exec(`CREATE TABLE IF NOT EXISTS capi_log (
    id INTEGER PRIMARY KEY, event_row_id INTEGER NOT NULL, event_name TEXT, pixel_id TEXT,
    dry_run INTEGER DEFAULT 1, payload TEXT, event_id TEXT, match_quality INTEGER, sent_at TEXT
  )`);
  // ----------------------------------------------------------------
  // Idempotent migrations for databases created before Phase S.
  // ADD COLUMN fails if the column exists; wrap in try so re-runs are no-ops.
  const cols = (table) => db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((r) => r.name);
  const u = cols('user');
  if (!u.includes('totp_secret')) db.exec(`ALTER TABLE user ADD COLUMN totp_secret TEXT`);
  if (!u.includes('totp_enabled')) db.exec(`ALTER TABLE user ADD COLUMN totp_enabled INTEGER DEFAULT 0`);
  // Phase R: Meta-reported conversions for the Meta-vs-Track report.
  const sd = cols('spend_daily');
  if (!sd.includes('conversions')) db.exec(`ALTER TABLE spend_daily ADD COLUMN conversions INTEGER DEFAULT 0`);
  // Meta token-expiry (live connect): see the PG branch for what it is.
  const ma = cols('meta_ad_account');
  if (!ma.includes('token_expires_at')) db.exec(`ALTER TABLE meta_ad_account ADD COLUMN token_expires_at TEXT`);
  // Master v9: the account's billing currency (from the ad account's
  // `currency` field, recorded on each pull — not `currency_code`) for the
  // dashboard KPI cards.
  const ma2 = cols('meta_ad_account');
  if (!ma2.includes('currency')) db.exec(`ALTER TABLE meta_ad_account ADD COLUMN currency TEXT`);
  // v11: mark a seed/demo client so its whole dataset hides in DATA_MODE=live.
  const cl = cols('client');
  if (!cl.includes('demo')) db.exec(`ALTER TABLE client ADD COLUMN demo INTEGER DEFAULT 0`);
  // v13 spend-accuracy: meta_accuracy_check shipped first on the INR-basis
  // shape (app_spend_inr/meta_spend_inr, no currency) and was re-shaped to
  // NATIVE currency units in v11 (app_spend/meta_spend/currency). CREATE
  // TABLE IF NOT EXISTS cannot extend an existing table, so any DB created
  // before the re-shape is missing the new columns and every /meta/check
  // upsert fails ("no column named app_spend"). Add the missing columns
  // idempotently; the table holds only completed checks (re-checks
  // overwrite), so the old _inr columns are simply left unused.
  const macc = cols('meta_accuracy_check');
  if (!macc.includes('app_spend')) db.exec(`ALTER TABLE meta_accuracy_check ADD COLUMN app_spend REAL NOT NULL DEFAULT 0`);
  if (!macc.includes('meta_spend')) db.exec(`ALTER TABLE meta_accuracy_check ADD COLUMN meta_spend REAL NOT NULL DEFAULT 0`);
  if (!macc.includes('currency')) db.exec(`ALTER TABLE meta_accuracy_check ADD COLUMN currency TEXT`);
  // v14 (Webhooks & API Keys): token-in-URL inbound endpoint columns +
  // lifecycle fields, and the api_keys credential store (hash-only).
  const we = cols('webhook_endpoint');
  const weCols = [
    [`slug`, `ALTER TABLE webhook_endpoint ADD COLUMN slug TEXT`],
    [`token_hash`, `ALTER TABLE webhook_endpoint ADD COLUMN token_hash TEXT`],
    [`description`, `ALTER TABLE webhook_endpoint ADD COLUMN description TEXT`],
    [`events`, `ALTER TABLE webhook_endpoint ADD COLUMN events TEXT DEFAULT 'all'`],
    [`status`, `ALTER TABLE webhook_endpoint ADD COLUMN status TEXT DEFAULT 'active'`],
    [`events_total`, `ALTER TABLE webhook_endpoint ADD COLUMN events_total INTEGER DEFAULT 0`],
    [`last_event_at`, `ALTER TABLE webhook_endpoint ADD COLUMN last_event_at TEXT`],
    [`created_at`, `ALTER TABLE webhook_endpoint ADD COLUMN created_at TEXT`],
  ];
  for (const [name, ddl] of weCols) if (!we.includes(name)) db.exec(ddl);
  db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY, scope_client_id INTEGER, label TEXT,
    permission TEXT DEFAULT 'read_only',
    key_hash TEXT NOT NULL,
    created_by TEXT, created_at TEXT DEFAULT (datetime('now')),
    last_used_at TEXT, revoked_at TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_apikey_hash ON api_keys(key_hash)`);
  db.exec(`CREATE TABLE IF NOT EXISTS tfa_pending (
    user_id INTEGER PRIMARY KEY REFERENCES user(id),
    totp_secret TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  return db;
}

// makeTx(db, user)
//   user undefined -> use the handle's SYSTEM connection as-is (do not touch
//     its RLS scope; for system/ticker/queue work that should already be
//     unrestricted).
//   user null      -> SYSTEM connection, explicitly unrestricted.
//   user (object)  -> a dedicated connection pinned to that user's RLS scope:
//     the client role is locked to its own client_ids, team roles are
//     unrestricted. Concurrent requests for different users never share a
//     session, so their scopes cannot bleed.
// SQLite ignores `user` (no RLS; the app's own query scoping applies).
function makeTx(db, user) {
  let conn = db;
  if (db && db.engine === 'pg') {
    if (user === null) { conn = db._systemConn; }
    else if (user !== undefined) { conn = db.scoped(user); }
  }
  // node:sqlite / pg are both synchronous; "transaction" = run in order.
  // run() returns { changes, lastInsertRowid } (lastInsertRowid populated from
  // the statement's RETURNING id when present — see the RETURNING appends).
  return {
    db: conn,
    run(sql, ...args) {
      const stmt = conn.prepare(sql);
      return args.length ? stmt.run(...args) : stmt.run();
    },
    get(sql, ...args) {
      const stmt = conn.prepare(sql);
      return args.length ? stmt.get(...args) : stmt.get();
    },
    all(sql, ...args) {
      const stmt = conn.prepare(sql);
      return args.length ? stmt.all(...args) : stmt.all();
    },
  };
}

// Postgres only: re-point every *_id_seq to its MAX(id) (setval with
// is_called=true so nextval() yields max+1). Explicit-id bulk loads (the seed,
// test fixtures) never advance SERIAL sequences, so without this the next
// auto-id INSERT collides with the last explicit id (the deal_pkey duplicate
// the replay's razorpay job hit). No-op on SQLite (INTEGER PKs self-manage).
// Idempotent, cheap; run it after any explicit-id load.
const PG_ALIGN_SEQUENCES = `DO $$
DECLARE
  s TEXT; tbl TEXT;
BEGIN
  FOR s IN
    SELECT relname FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'S' AND relname LIKE '%\\_id_seq' ESCAPE '\\'
  LOOP
    tbl := regexp_replace(s, '_id_seq$', '');
    EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(id) FROM %I), 1), true)', s, tbl);
  END LOOP;
END $$;`;

function alignSequences(handle) {
  if (handle && handle.engine === 'pg') handle.exec(PG_ALIGN_SEQUENCES);
}

module.exports = { open, makeTx, engine, alignSequences };
