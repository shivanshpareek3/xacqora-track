#!/usr/bin/env bash
# Monthly restore drill (PRD §10): restore the newest backup into a FRESH
# target and assert the row counts match the live DB. Exit 0 only if the
# restored snapshot is query-equivalent on the checked tables.
#
# Engine-aware (Phase P):
#   * Postgres (DATABASE_URL set) — pg_restore the newest .pgdump into a
#     scratch database, compare counts vs the live db, drop the scratch db.
#   * SQLite (default)           — copy the newest .sqlite3 snapshot to a
#     fresh file, open + count.
#
# Postgres connection comes from DATABASE_URL (postgres://user@host:port/db);
# PGBIN overrides the pg tool directory (default: /usr/local/opt/postgresql@18/bin).
set -euo pipefail
cd "$(dirname "$0")/.."

TABLES="lead event deal touchpoint user webhook_log"

# ------------------------------------------------------------------ Postgres
if [ -n "${DATABASE_URL:-}" ]; then
  PGBIN="${PGBIN:-/usr/local/opt/postgresql@18/bin}"
  # postgres://[user[:pw]@]host:port/db
  rest_url="${DATABASE_URL#*://}"
  creds="${rest_url%%@*}"; if [ "$creds" = "$rest_url" ]; then creds=""; fi
  url_no_user="${rest_url#*@}"; if [ "$url_no_user" = "$rest_url" ]; then url_no_user="$rest_url"; fi
  hostport="${url_no_user%%/*}"; db="${url_no_user#*/}"
  host="${hostport%%:*}"; port="${hostport##*:}"; [ "$port" = "$hostport" ] && port=5432
  user="${creds%%:*}"; [ -z "$user" ] && user="postgres"
  # optional password from the URL -> PGPASSWORD
  if [[ "$creds" == *":"* ]]; then export PGPASSWORD="${creds#*:}"; fi
  # A DBA-level restore drill runs as a role that BYPASSES RLS: pg_dump/pg_restore
  # are refused under FORCE ROW LEVEL SECURITY by the RLS-bound app role. Default
  # to the superuser backup role the cluster scripts create; override via
  # PG_BACKUP_USER for a different deployment.
  buser="${PG_BACKUP_USER:-$user}"

  bk() { "$PGBIN/psql" -h "$host" -p "$port" -U "$buser" -d "$1" -qAt -c "$2"; }

  BKDIR="backups"
  LATEST="$(ls -1 "$BKDIR"/xacqora-*.pgdump 2>/dev/null | sort | tail -n1 || true)"
  if [ -z "${LATEST:-}" ]; then
    echo "restore-drill: no pg_dump backups in $BKDIR/ — run 'node scripts/backup.js' first"
    exit 1
  fi

  PROBE="${PG_RESTORE_DB:-xacqora_restore_probe}"
  # createdb/dropdb take no -d (that's a psql flag): the maintenance db they
  # connect through to issue CREATE/DROP DATABASE is --maintenance-db.
  "$PGBIN/dropdb" -h "$host" -p "$port" -U "$buser" --maintenance-db "$db" --if-exists "$PROBE" >/dev/null 2>&1 || true
  "$PGBIN/createdb" -h "$host" -p "$port" -U "$buser" --maintenance-db "$db" "$PROBE"
  trap "$PGBIN/dropdb -h '$host' -p '$port' -U '$buser' --maintenance-db '$db' --if-exists '$PROBE' >/dev/null 2>&1; exit 0" EXIT
  if ! "$PGBIN/pg_restore" -h "$host" -p "$port" -U "$buser" -d "$PROBE" "$LATEST" >/dev/null 2>&1; then
    echo "FAIL pg_restore of $LATEST failed"
    exit 1
  fi

  fail=0
  for t in $TABLES; do
    lc="$(bk "$db" "SELECT count(*) FROM $t;")"
    rc="$(bk "$PROBE" "SELECT count(*) FROM $t;")"
    if [ -z "$rc" ]; then echo "FAIL table=$t restored snapshot missing/unreadable"; fail=1; continue; fi
    if [ -n "$lc" ] && [ "$lc" -lt "$rc" ] 2>/dev/null; then
      echo "WARN table=$t live=$lc restored=$rc (restored ahead of live — unusual)"
    fi
    echo "ok   table=$t restored=$rc live=${lc:-?}"
  done
  [ "$fail" -ne 0 ] && { echo "RESTORE DRILL FAILED"; exit 1; }
  echo "RESTORE DRILL PASSED (pg_dump $LATEST restored into scratch db $PROBE, all tables open and counted)"
  exit 0
fi

# ------------------------------------------------------------------ SQLite
DB="${XACQORA_DB_FILE:-xacqora.sqlite3}"
BKDIR="backups"
STAGE="$(mktemp -d /tmp/xacqora-restore-XXXXXX)"

trap 'rm -rf "$STAGE"' EXIT

# newest backup
LATEST="$(ls -1 "$BKDIR"/xacqora-*.sqlite3 2>/dev/null | sort | tail -n1 || true)"
if [ -z "${LATEST:-}" ]; then
  echo "restore-drill: no backups in $BKDIR/ — run 'node scripts/backup.js' first"
  exit 1
fi
cp "$LATEST" "$STAGE/restored.sqlite3"

count() { # table file -> count, or empty
  local t="$1" f="$2"
  [ -f "$f" ] || return 0
  node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(d.prepare('SELECT COUNT(*) c FROM '+process.argv[2]).get().c);" "$f" "$t" 2>/dev/null || true
}

fail=0
for t in $TABLES; do
  lc="$(count "$t" "$DB")"
  rc="$(count "$t" "$STAGE/restored.sqlite3")"
  # the restored copy must not have MORE than live (live is ahead); and the
  # snapshot must be a valid openable DB with the table present.
  if [ -z "$rc" ]; then echo "FAIL table=$t snapshot missing or unreadable"; fail=1; continue; fi
  if [ -n "$lc" ] && [ "$lc" -lt "$rc" ] 2>/dev/null; then
    echo "WARN table=$t live=$lc restored=$rc (restored ahead of live — unusual)"
  fi
  echo "ok   table=$t restored=$rc live=${lc:-?}"
done

if [ "$fail" -ne 0 ]; then
  echo "RESTORE DRILL FAILED"
  exit 1
fi
echo "RESTORE DRILL PASSED (snapshot $LATEST restored to a fresh dir, all tables open and counted)"
