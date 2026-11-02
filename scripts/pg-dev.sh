#!/usr/bin/env bash
# Phase P local-dev Postgres bring-up. Idempotent: wipes /tmp/xt-pg, creates a
# fresh cluster on 127.0.0.1:5433 with:
#   - cluster superuser : xacqora   (owns the cluster)
#   - db xacqora owned by xacq_app
#   - role xacq_app     : LOGIN, non-superuser, DB owner -> RLS binds it
#     (superusers bypass RLS; the app must connect as xacq_app for the
#      isolation proof to be meaningful)
# Also starts Postgres with custom_variable_classes='app' so any role can
# set_config('app.unrestricted'/'app.client_ids') — the RLS scoping GUCs.
# Prints the DATABASE_URL the app should use when done.
#
# NOTE: initdb's bootstrap postmaster needs SysV shared memory (shmget), which
# the in-app Bash sandbox blocks — run this from a real terminal, not a
# sandboxed shell.
set -euo pipefail
DIR=/tmp/xt-pg
LC_ALL=C LANG=C pg_ctl -D "$DIR/data" stop -m immediate >/dev/null 2>&1 || true
rm -rf "$DIR"; mkdir -p "$DIR"

command -v initdb >/dev/null || { echo "initdb not found (brew install postgresql)"; exit 1; }
LC_ALL=C LANG=C initdb -D "$DIR/data" -U xacqora -A trust > "$DIR/init.log" 2>&1
# note: custom GUCs (app.unrestricted / app.client_ids) need no registration
# on PG 18 (custom_variable_classes was removed).
LC_ALL=C LANG=C pg_ctl -D "$DIR/data" -l "$DIR/pg.log" \
  -o "-p 5433 -c listen_addresses='127.0.0.1' -c unix_socket_directories='$DIR'" \
  -w start

psql() { psql -h 127.0.0.1 -p 5433 -U xacqora -d postgres -v ON_ERROR_STOP=1 -c "$1" >/dev/null 2>&1 || true; }
psql "CREATE ROLE xacq_app LOGIN;"
psql "CREATE DATABASE xacqora OWNER xacq_app;"
# dedicated superuser backup role: FORCE ROW LEVEL SECURITY makes Postgres refuse
# a table export by any non-superuser ("query would be affected by row-level
# security policy"), so pg_dump/pg_restore must run as a role that bypasses RLS.
# It is ONLY for the backup/restore path — the app keeps connecting as xacq_app
# (RLS-bound) so the isolation proof is intact. Point backups at it with
# PG_BACKUP_USER=xacq_backup (scripts/backup.js + restore-drill.sh default to it).
psql "CREATE ROLE xacq_backup LOGIN SUPERUSER;"

URL="postgresql://xacq_app@127.0.0.1:5433/xacqora"
echo "PG READY  app-url=$URL"
echo "load schema:  psql -h 127.0.0.1 -p 5433 -U xacq_app -d xacqora -v ON_ERROR_STOP=1 -f server/schema.pg.sql"
echo "run app:      DATABASE_URL=$URL PG_BACKUP_USER=xacq_backup node server/index.js"
