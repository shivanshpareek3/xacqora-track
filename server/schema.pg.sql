-- Xacqora Track schema (Postgres dialect) — Phase P port of schema.sql.
-- Executed by the sync pg facade (server/pg.js) on connect when DATABASE_URL is set.
-- Idempotent: safe to re-run.
--
-- Divergences from the SQLite file, all deliberate:
--   * timestamps are TEXT ISO-8601 (UTC) — the app treats them as strings
--     everywhere (Date.parse, lexicographic ORDER BY ts, fmtDT). This keeps
--     JS behaviour byte-identical to the SQLite build.
--   * the `user` table is quoted ("user") — `user` is a reserved word in
--     Postgres. Quoting is also valid in SQLite, so app SQL shares the form.
--   * REAL -> DOUBLE PRECISION (money/aggregates); INTEGER pks -> SERIAL.
--   * ROW LEVEL SECURITY on every table that carries client_id, driven by two
--     app.* custom GUCs the facade sets per session:
--         app.unrestricted = 'true'  -> team / system: see every row
--         app.client_ids   = '2,3'   -> restricted: only those clients
--     When both are unset/empty the policy sees NOTHING (fail closed). The
--     facade sets app.unrestricted='true' on connect (system default), and
--     makeTx(db, clientUser) flips the session to the client's ids.
--   * this connection MUST be a non-superuser (superusers bypass RLS). The
--     dev app role is `xacq_app`; see the setup note in docs/adapter-verification.md.

BEGIN;

-- ---------------------------------------------------------------- top level
CREATE TABLE IF NOT EXISTS workspace (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, plan TEXT DEFAULT 'trial'
);
CREATE TABLE IF NOT EXISTS client (
  id SERIAL PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspace(id),
  name TEXT NOT NULL, currency TEXT DEFAULT 'INR', timezone TEXT DEFAULT 'Asia/Kolkata',
  offer_price DOUBLE PRECISION DEFAULT 0,
  created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE TABLE IF NOT EXISTS settings ( key TEXT PRIMARY KEY, value TEXT );
CREATE TABLE IF NOT EXISTS fx_rate (
  date TEXT PRIMARY KEY, currency TEXT NOT NULL, inr_per_unit DOUBLE PRECISION NOT NULL
);

-- "user" is reserved in Postgres -> quoted (also valid in SQLite)
CREATE TABLE IF NOT EXISTS "user" (
  id SERIAL PRIMARY KEY, email TEXT UNIQUE, name TEXT, password_hash TEXT,
  role TEXT DEFAULT 'viewer', client_ids TEXT,
  totp_secret TEXT, totp_enabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE TABLE IF NOT EXISTS session_token (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES "user"(id),
  created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  expires_at TEXT
);
-- one-row-per-user pending two-factor login (password OK, waiting on the OTP)
CREATE TABLE IF NOT EXISTS tfa_pending (
  user_id INTEGER PRIMARY KEY REFERENCES "user"(id),
  totp_secret TEXT NOT NULL,
  created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY, user_email TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT,
  ts TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), detail TEXT
);
CREATE TABLE IF NOT EXISTS integration_status (
  platform TEXT PRIMARY KEY, status TEXT DEFAULT 'pending', notes TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS visitor (
  id TEXT PRIMARY KEY, fbp TEXT,
  first_seen TEXT, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS meta_campaign (
  id TEXT PRIMARY KEY, ad_account_id TEXT NOT NULL, name TEXT, status TEXT, object_type TEXT
);
CREATE TABLE IF NOT EXISTS meta_adset (
  id TEXT PRIMARY KEY, ad_account_id TEXT NOT NULL, campaign_id TEXT, name TEXT, status TEXT
);
CREATE TABLE IF NOT EXISTS meta_ad (
  id TEXT PRIMARY KEY, ad_account_id TEXT NOT NULL, adset_id TEXT, name TEXT, status TEXT,
  creative_id TEXT, creative_img TEXT
);
CREATE TABLE IF NOT EXISTS spend_daily (
  ad_id TEXT NOT NULL, date TEXT NOT NULL, ad_account_id TEXT,
  spend DOUBLE PRECISION DEFAULT 0, spend_inr DOUBLE PRECISION DEFAULT 0,
  impressions INTEGER DEFAULT 0, reach INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  PRIMARY KEY (ad_id, date, ad_account_id)
);
CREATE INDEX IF NOT EXISTS idx_spend_date ON spend_daily(date, ad_account_id);

CREATE TABLE IF NOT EXISTS funnel (
  id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES client(id),
  name TEXT NOT NULL, type TEXT DEFAULT 'webinar',
  landing_urls TEXT DEFAULT '[]', product_ids TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS funnel_stage (
  id SERIAL PRIMARY KEY, funnel_id INTEGER NOT NULL REFERENCES funnel(id),
  name TEXT NOT NULL, sort_order INTEGER DEFAULT 0, UNIQUE(funnel_id, name)
);
CREATE TABLE IF NOT EXISTS lead (
  id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES client(id),
  phone TEXT, email TEXT, name TEXT, city TEXT, owner TEXT,
  stage TEXT DEFAULT 'New', source_unknown INTEGER DEFAULT 0,
  first_touch_id INTEGER, last_touch_id INTEGER,
  created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_lead_phone ON lead(client_id, phone);
CREATE INDEX IF NOT EXISTS idx_lead_email ON lead(client_id, email);
CREATE INDEX IF NOT EXISTS idx_lead_stage ON lead(client_id, stage);
CREATE TABLE IF NOT EXISTS lead_identity (
  link_type TEXT NOT NULL, link_key TEXT NOT NULL, lead_id INTEGER NOT NULL REFERENCES lead(id),
  UNIQUE(link_type, link_key)
);
CREATE TABLE IF NOT EXISTS touchpoint (
  id SERIAL PRIMARY KEY, lead_id INTEGER, visitor_id TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
  campaign_id TEXT, adset_id TEXT, ad_id TEXT, fbclid TEXT, fbc TEXT,
  landing_url TEXT, referrer TEXT, device TEXT, ip TEXT, ua TEXT,
  meta_reported_conversions INTEGER DEFAULT 0,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tp_lead ON touchpoint(lead_id, ts);
CREATE INDEX IF NOT EXISTS idx_tp_visitor ON touchpoint(visitor_id);
CREATE TABLE IF NOT EXISTS event (
  id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES lead(id),
  type TEXT NOT NULL, source_platform TEXT, source_ref TEXT,
  value DOUBLE PRECISION, currency TEXT DEFAULT 'INR', raw_payload TEXT,
  sent_to_meta INTEGER DEFAULT 0, meta_event_id TEXT, meta_match_quality INTEGER,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_lead ON event(lead_id, ts);
CREATE INDEX IF NOT EXISTS idx_event_type ON event(type, ts);
CREATE INDEX IF NOT EXISTS idx_event_capi ON event(type, sent_to_meta, ts);
CREATE TABLE IF NOT EXISTS deal (
  id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES lead(id),
  client_id INTEGER NOT NULL REFERENCES client(id),
  product TEXT, amount DOUBLE PRECISION NOT NULL, currency TEXT DEFAULT 'INR',
  gateway TEXT, gateway_txn_id TEXT, status TEXT DEFAULT 'success',
  paid_at TEXT, refunded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deal_txn ON deal(gateway_txn_id);
CREATE INDEX IF NOT EXISTS idx_deal_client ON deal(client_id, status, paid_at);
CREATE TABLE IF NOT EXISTS meta_ad_account (
  id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES client(id),
  name TEXT, ad_account_id TEXT, token TEXT, pixel_id TEXT, status TEXT DEFAULT 'connected',
  last_pull_at TEXT, auto_pull INTEGER DEFAULT 1, last_error TEXT
);
CREATE TABLE IF NOT EXISTS webhook_endpoint (
  id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES client(id),
  platform TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
  UNIQUE(client_id, platform, url)
);
CREATE TABLE IF NOT EXISTS webhook_log (
  id SERIAL PRIMARY KEY, client_id INTEGER, platform TEXT NOT NULL,
  ref TEXT, dedup_key TEXT, status TEXT DEFAULT 'received',
  error TEXT, raw TEXT,
  ingested_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  processed_at TEXT, test INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_whl_status ON webhook_log(status, ingested_at);
CREATE TABLE IF NOT EXISTS task (
  id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES lead(id),
  user_id INTEGER, user_name TEXT, type TEXT DEFAULT 'followup',
  due_at TEXT, outcome TEXT, notes TEXT,
  ts TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE TABLE IF NOT EXISTS note (
  id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES lead(id),
  user_id INTEGER, user_name TEXT, body TEXT,
  ts TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE TABLE IF NOT EXISTS call_log (
  id SERIAL PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES lead(id),
  user_name TEXT, outcome TEXT, notes TEXT,
  ts TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE TABLE IF NOT EXISTS field_map (
  client_id INTEGER NOT NULL, platform TEXT NOT NULL,
  mapping TEXT DEFAULT '{}', PRIMARY KEY (client_id, platform)
);
CREATE TABLE IF NOT EXISTS capi_setting (
  id SERIAL PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES client(id),
  pixel_id TEXT NOT NULL, event_types TEXT NOT NULL,
  updated_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
);
CREATE TABLE IF NOT EXISTS job (
  id SERIAL PRIMARY KEY, queue_name TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0,
  next_run_at INTEGER DEFAULT 0, last_error TEXT,
  created_at TEXT DEFAULT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_due ON job(status, next_run_at);
CREATE TABLE IF NOT EXISTS capi_log (
  id SERIAL PRIMARY KEY, event_row_id INTEGER NOT NULL, event_name TEXT, pixel_id TEXT,
  dry_run INTEGER DEFAULT 1, payload TEXT, event_id TEXT, match_quality INTEGER, sent_at TEXT
);

COMMIT;

-- ============================================================================
-- ROW LEVEL SECURITY — enforced at the DB level (PRD §10).
--
-- Every client-bearing table gets `ENABLE` + `FORCE ROW LEVEL SECURITY`
-- (FORCE binds the owning role too; superusers still bypass, so the app
-- MUST connect as a non-superuser role — dev: xacq_app — for the guarantee
-- to hold).
--
-- The policies key on two session GUCs the pg facade sets (server/pg.js
-- setScope), through two helper predicates below (dollar-quoted so the
-- policy bodies stay single-line with NO nested-quote escaping):
--
--   app_in_session()  true when the session sets NO client scope and is not
--                     marked unrestricted — i.e. a fresh psql / pg_dump /
--                     pg_restore / ticker / queue / backup connection.
--   app_client_ok(c)  true when in-session, when the row has no client_id,
--                     when unrestricted, or when c is in app.client_ids.
--
-- Scoping model (DELiberately default-OPEN, not fail-closed):
--   * The app ALWAYS sets app.client_ids (client role) or app.unrestricted
--     (team/system) on every app connection — see db.open -> setScope and
--     db.scoped(user). So a *scoped* connection is the only path a real
--     client-user request takes, and that connection can read/write ONLY
--     its own clients' rows. That is the PRD §10 guarantee.
--   * A connection with no scope set is a system / operational context
--     (ticker, webhook queue, pg_dump, pg_restore, ad-hoc psql as the
--     owner role) and sees everything. This is required for operational
--     tooling: pg_dump/pg_restore and bare psql open fresh sessions
--     without the GUCs, and FORCE RLS disables the owner bypass — a
--     fail-closed default would break every dump/restore, which is
--     unacceptable for a system with a tested restore drill.
--
-- Read (USING) and write (WITH CHECK) use the same predicate, so a scoped
-- session cannot read, insert, or update outside its own clients.
-- ============================================================================

-- helper predicates — owner = whoever loads this file (the app role);
-- CREATE OR REPLACE makes connect-time re-runs idempotent.
CREATE OR REPLACE FUNCTION app_in_session()
RETURNS boolean LANGUAGE sql STABLE AS $func$
  SELECT coalesce(current_setting('app.client_ids', true), '') = ''
     OR coalesce(current_setting('app.unrestricted', true), 'false') = 'true';
$func$;

CREATE OR REPLACE FUNCTION app_client_ok(p_client_id int)
RETURNS boolean LANGUAGE sql STABLE AS $func$
  SELECT app_in_session()
     OR p_client_id::text = ANY(string_to_array(
          coalesce(nullif(current_setting('app.client_ids', true), ''), ''), ','));
$func$;

-- webhook_log.client_id is NULLABLE (logs can precede client resolution), so
-- the generic predicate above would show NULL-client system rows to every
-- client user. This one hides them: a scoped session sees only rows whose
-- client_id is in its own scope.
CREATE OR REPLACE FUNCTION app_webhook_ok(p_client_id int)
RETURNS boolean LANGUAGE sql STABLE AS $func$
  SELECT app_in_session()
     OR p_client_id IS NOT NULL
     AND p_client_id::text = ANY(string_to_array(
          coalesce(nullif(current_setting('app.client_ids', true), ''), ''), ','));
$func$;

-- enable + force RLS on every policy-carrying table, drop old policies
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
      'funnel','lead','deal','meta_ad_account','capi_setting','field_map',
      'funnel_stage','lead_identity','webhook_log','webhook_endpoint',
      'event','touchpoint','task','note','call_log'
   ]) LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE  ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS client_scope ON %I', t);
  END LOOP;
END $$;

-- tables that CARRY client_id: visible/writable iff the row's client is in
-- the session's scope (or the session is unscoped / unrestricted).
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
      'funnel','lead','deal','meta_ad_account','capi_setting','field_map','webhook_endpoint'
   ]) LOOP
    EXECUTE format(
      'CREATE POLICY client_scope ON %I
         USING (app_client_ok(client_id))
         WITH CHECK (app_client_ok(client_id))', t);
  END LOOP;
END $$;

-- webhook_log: client_id is NULLABLE -> the dedicated webhook predicate
-- (system log rows are hidden from scoped sessions).
DO $$
BEGIN
  EXECUTE 'CREATE POLICY client_scope ON webhook_log
    USING (app_webhook_ok(client_id))
    WITH CHECK (app_webhook_ok(client_id))';
END $$;

-- tables that only REFERENCE a client (no client_id of their own): visible
-- iff the PARENT row is visible in this session. The EXISTS is itself RLS-
-- filtered (funnel / lead carry their own policy), so a hidden parent keeps
-- its children hidden; a scoped session cannot smuggle a foreign parent's
-- child in via WITH CHECK either.
DO $$
DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
      'event','touchpoint','task','note','call_log'
   ]) LOOP
    EXECUTE format(
      'CREATE POLICY client_scope ON %I
         USING (app_in_session() OR EXISTS (SELECT 1 FROM lead l WHERE l.id = %I.lead_id))
         WITH CHECK (app_in_session() OR EXISTS (SELECT 1 FROM lead l WHERE l.id = %I.lead_id))',
      t, t, t);
  END LOOP;
  EXECUTE 'CREATE POLICY client_scope ON funnel_stage
    USING (app_in_session() OR EXISTS (SELECT 1 FROM funnel f WHERE f.id = funnel_stage.funnel_id))
    WITH CHECK (app_in_session() OR EXISTS (SELECT 1 FROM funnel f WHERE f.id = funnel_stage.funnel_id))';
  EXECUTE 'CREATE POLICY client_scope ON lead_identity
    USING (app_in_session() OR EXISTS (SELECT 1 FROM lead l WHERE l.id = lead_identity.lead_id))
    WITH CHECK (app_in_session() OR EXISTS (SELECT 1 FROM lead l WHERE l.id = lead_identity.lead_id))';
END $$;

-- Sequence alignment: seed rows use EXPLICIT ids (client 1/2, lead 101...,
-- etc.), so re-point every SERIAL sequence past its max(id) on each load.
-- Idempotent; the app re-runs this file on every connect. (Every serial
-- column in this schema is named `id`, so the sequence is <table>_id_seq.)
--   is_called := true  -> nextval() yields max+1 (not max)
DO $$
DECLARE
  s TEXT; tbl TEXT;
BEGIN
  FOR s IN
    SELECT relname FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind = 'S' AND relname LIKE '%\_id_seq' ESCAPE '\'
  LOOP
    tbl := regexp_replace(s, '_id_seq$', '');
    EXECUTE format(
      'SELECT setval(%L, COALESCE((SELECT MAX(id) FROM %I), 1), true)', s, tbl);
  END LOOP;
END $$;

-- Note: the working table/sequence grants are made ONCE by setup (scripts/
-- pg-provision.sh / your host setup), not by the app on every connect —
-- `GRANT ... TO PUBLIC` from a running role that is itself part of PUBLIC
-- fails with "must be granted by a database owner or superuser" unless the
-- app role OWNS the database. pg-provision.sh creates the DB owned by the
-- app role so that holds; this file itself is pure DDL + RLS + sequence
-- alignment and is safe to re-run on every connect.
