#!/usr/bin/env bash
# Phase P — provision the live-Postgres side of the demo. Idempotent: re-runs
# are safe. Creates a non-superuser app role that OWNS the database, loads
# server/schema.pg.sql as that role (so RLS FORCE binds it), and grants the
# working privileges. Afterwards run the app with:
#   DATABASE_URL=postgresql://xacq_app@127.0.0.1:5433/xacqora node server/index.js
#
# Requires a running dev cluster (scripts/pg-dev.sh creates /tmp/xt-pg on
# 127.0.0.1:5433 with superuser 'xacqora'). PSQL_HOST/PSQL_PORT/PSQL_SUPER
# env vars override the defaults.
set -euo pipefail
HOST="${PSQL_HOST:-127.0.0.1}"
PORT="${PSQL_PORT:-5433}"
SUPER="${PSQL_SUPER:-xacqora}"
APP_ROLE="xacq_app"
APP_DB="xacqora"
# FORCE ROW LEVEL SECURITY makes Postgres refuse a table export by any
# non-superuser, so the pg_dump/pg_restore backup path runs as this dedicated
# superuser role. The app keeps connecting as $APP_ROLE (RLS-bound), so the
# isolation proof stays intact; backups just point at this role (PG_BACKUP_USER).
BACKUP_ROLE="${PG_BACKUP_ROLE:-xacq_backup}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"

PSQL_SUPER=(psql -h "$HOST" -p "$PORT" -U "$SUPER")

echo "=> roles + database"
# app role: LOGIN, NOT a superuser (superusers bypass RLS entirely).
# Idempotent rebuild: drop every xacqora* database (force past stale
# connections), clear owned objects, drop the role, recreate.
for dbname in $(psql -h "$HOST" -p "$PORT" -U "$SUPER" -d postgres -Atc \
  "SELECT datname FROM pg_database WHERE datistemplate=false AND datname LIKE 'xacqora%';" 2>/dev/null); do
  psql -h "$HOST" -p "$PORT" -U "$SUPER" -d "$dbname" -v ON_ERROR_STOP=0 -Atc \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$dbname' AND pid<>pg_backend_pid();" >/dev/null 2>&1 || true
  psql -h "$HOST" -p "$PORT" -U "$SUPER" -d "$dbname" -v ON_ERROR_STOP=0 -Atc "DROP OWNED BY $APP_ROLE;" >/dev/null 2>&1 || true
  dropdb -h "$HOST" -p "$PORT" -U "$SUPER" --force "$dbname" >/dev/null 2>&1 || true
done
"${PSQL_SUPER[@]}" -d postgres -v ON_ERROR_STOP=0 -c "DROP OWNED BY $APP_ROLE;" >/dev/null 2>&1 || true
"${PSQL_SUPER[@]}" -d postgres -v ON_ERROR_STOP=0 -c "DROP ROLE IF EXISTS $APP_ROLE;" >/dev/null
# CREATEDB so the backup's restore-verify can create a scratch probe database.
# Still not a superuser, so the RLS + FORCE policies keep binding the app.
"${PSQL_SUPER[@]}" -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE $APP_ROLE LOGIN CREATEDB;" >/dev/null
"${PSQL_SUPER[@]}" -d postgres -v ON_ERROR_STOP=1 -Atc "CREATE DATABASE $APP_DB OWNER $APP_ROLE;" >/dev/null
# Superuser backup role: pg_dump/pg_restore must bypass RLS to export the
# forced-RLS tables, so the backup path connects as this role only.
# CREATE ROLE has no IF NOT EXISTS clause; the role survives the db drop above
# on a re-run, so drop-then-create keeps the provision idempotent (the role is
# dump-only and holds nothing of its own, so dropping it is always safe).
"${PSQL_SUPER[@]}" -d postgres -v ON_ERROR_STOP=0 -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='$BACKUP_ROLE' AND pid<>pg_backend_pid();" >/dev/null
"${PSQL_SUPER[@]}" -d postgres -v ON_ERROR_STOP=0 -c "DROP ROLE IF EXISTS $BACKUP_ROLE;" >/dev/null
"${PSQL_SUPER[@]}" -d postgres -v ON_ERROR_STOP=1 -c "CREATE ROLE $BACKUP_ROLE LOGIN SUPERUSER;" >/dev/null
echo "created db $APP_DB owned by $APP_ROLE (non-superuser); backup role $BACKUP_ROLE (superuser, dump-only)"

echo "=> load schema + grants as $APP_ROLE (owner: RLS FORCE binds it)"
psql -h "$HOST" -p "$PORT" -U "$APP_ROLE" -d "$APP_DB" -v ON_ERROR_STOP=1 -f "$HERE/server/schema.pg.sql" >/dev/null
# owner-granted privileges (legal because $APP_ROLE owns the database)
psql -h "$HOST" -p "$PORT" -U "$APP_ROLE" -d "$APP_DB" -v ON_ERROR_STOP=1 -Atc \
  "GRANT USAGE, CREATE ON SCHEMA public TO PUBLIC;
   GRANT ALL ON ALL TABLES IN SCHEMA public TO PUBLIC;
   GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO PUBLIC;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO PUBLIC;" >/dev/null
echo "schema + grants loaded"

echo "=> verify RLS scoping as $APP_ROLE"
# Seed (a system connection with no scope set sees everything — the
# default-open model), then assert the scoped behaviour:
psql -h "$HOST" -p "$PORT" -U "$APP_ROLE" -d "$APP_DB" -Atc \
  "SELECT set_config('app.unrestricted','true',false);
   INSERT INTO workspace(id,name) VALUES (1,'W') ON CONFLICT DO NOTHING;
   INSERT INTO client(id,workspace_id,name) VALUES (1,1,'A'),(2,1,'B') ON CONFLICT DO NOTHING;
   DELETE FROM lead; INSERT INTO lead(client_id,phone) VALUES (1,'p1'),(2,'p2');" >/dev/null
unrestricted="$(psql -h "$HOST" -p "$PORT" -U "$APP_ROLE" -d "$APP_DB" -Atc \
  "SELECT set_config('app.unrestricted','true',false); SELECT count(*) FROM lead;")"
scoped="$(psql -h "$HOST" -p "$PORT" -U "$APP_ROLE" -d "$APP_DB" -Atc \
  "SELECT set_config('app.unrestricted','false',false), set_config('app.client_ids','2',false); SELECT count(*) FROM lead;")"
unscoped="$(psql -h "$HOST" -p "$PORT" -U "$APP_ROLE" -d "$APP_DB" -Atc \
  "SELECT count(*) FROM lead;")"   # fresh conn, no GUCs: system/maintenance -> sees all
echo "   unrestricted=$unrestricted (expect 2) scoped-client-2=$scoped (expect 1) no-scope(system)=$unscoped (expect 2, default-open)"
[ "${unrestricted##*$'\n'}" = "2" ] && [ "${scoped##*$'\n'}" = "1" ] && [ "${unscoped}" = "2" ] \
  || { echo "RLS verification FAILED — aborting"; exit 1; }
echo "PROVISION OK — DATABASE_URL=postgresql://$APP_ROLE@$HOST:$PORT/$APP_DB"
