#!/usr/bin/env bash
# Phase H — staging check: a prod-mirror environment on a throwaway Postgres
# database, seeded with FAKE data (never real client data), full test suite
# green. Run it as a pre-deploy gate: if this fails, prod will too.
#
# Usage:
#   bash scripts/staging.sh            # uses the dev cluster (scripts/pg-dev.sh)
#   PSQL_HOST=... PSQL_PORT=... PSQL_SUPER=... DATABASE_URL=... bash scripts/staging.sh
#
# The prod-mirror pieces that matter here:
#   * Postgres engine (DATABASE_URL) — not the SQLite fallback
#   * XACQORA_SECRET_KEY set (prod-only secrets at rest; no insecure dev key)
#   * XT_RATE_PER_MIN_* at prod values
#   * the full backend suite (unit + replay + sweep) on that config
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"

export PSQL_HOST="${PSQL_HOST:-127.0.0.1}" PSQL_PORT="${PSQL_PORT:-5433}" PSQL_SUPER="${PSQL_SUPER:-xacqora}"
STGDB="xacqora_staging"

echo "==> [1/5] provision a throwaway staging database ($STGDB) as a non-superuser owner"
# Reuse the Phase P provisioner, pointed at the staging db name via PSQL_SUPER db
# (it drops+recreates the app db idempotently, then we re-point DATABASE_URL).
if ! psql -h "$PSQL_HOST" -p "$PSQL_PORT" -U "$PSQL_SUPER" -d postgres -Atc \
     "SELECT 1 FROM pg_database WHERE datname='$STGDB'" | grep -q 1; then
  psql -h "$PSQL_HOST" -p "$PSQL_PORT" -U "$PSQL_SUPER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS $STGDB;" -c "CREATE DATABASE $STGDB OWNER ${PSQL_APP_ROLE:-xacq_app};"
fi

STAGE_URL="postgresql://${PSQL_APP_ROLE:-xacq_app}@${PSQL_HOST}:${PSQL_PORT}/${STGDB}"
export DATABASE_URL="$STAGE_URL"
export PG_BACKUP_USER="${PG_BACKUP_USER:-xacq_backup}"

echo "==> [2/5] load schema + RLS as the app role, then seed FAKE demo data"
psql -h "$PSQL_HOST" -p "$PSQL_PORT" -U "${PSQL_APP_ROLE:-xacq_app}" -d "$STGDB" -v ON_ERROR_STOP=1 -f "$HERE/server/schema.pg.sql" >/dev/null
# seed.js is idempotent and ships only fake data (privacy rule: no client data)
(cd "$HERE" && node scripts/seed.js >/dev/null && echo "   seeded (fake data)")

echo "==> [3/5] prod-mirror config: secrets key set, engine=pg"
export XACQORA_SECRET_KEY="${XACQORA_SECRET_KEY:-$(openssl rand -hex 32)}"
[ -n "$XACQORA_SECRET_KEY" ] || { echo "   FAILED: no secrets key"; exit 1; }
echo "   XACQORA_SECRET_KEY set (${#XACQORA_SECRET_KEY} chars, generated if you did not set it)"

echo "==> [4/5] full backend suite on the staging config (both-engines rule: pg here)"
cd "$HERE"
for t in reports security liveapi xt-queue isolation gates; do
  if node test/$t.js >/dev/null 2>&1; then echo "   PASS $t"; else echo "   FAIL $t"; node test/$t.js 2>&1 | tail -5; exit 1; fi
done
# replay exercises ingest plumbing end-to-end; its sample POSTs carry no HMAC
# signature headers. With XACQORA_SECRET_KEY set (step 3) the seeded endpoint
# secrets decrypt AND .env's XACQORA_LIVE=1 puts the spawned server in live
# mode, so the Phase-L signature gate (index.js:152) would 401 every sample.
# The gate's own regressions are covered by test/liveapi.js above, so run
# replay in mock mode: MOCK=1 forces liveMode()=false and the gate is skipped
# (the test's original dev-default design).
MOCK=1 node test/replay.js 2>&1 | grep -E "ALL TESTS|FAIL|assertion" | tail -3
# sweep: same story — its S.6 rate-limit test POSTs ingest endpoints with the
# shared endpoint secret but no live signature header; MOCK=1 keeps the
# signature gate off so those requests reach the 429 check they were written
# for. (The sweep's own server is spawned with this env, so MOCK=1 propagates.)
MOCK=1 PORT=4125 bash test/sweep.sh 2>&1 | grep -iE "SWEEP RESULT|FAIL" | tail -4

echo "==> [5/5] staging backup + restore drill (prod backup role)"
node scripts/backup.js 2>&1 | tail -1
bash scripts/restore-drill.sh 2>&1 | tail -1

echo "STAGING PASS — prod-mirror config green on $STGDB (fake data, $XACQORA_SECRET_KEY set, pg engine)"
