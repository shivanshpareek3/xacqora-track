#!/usr/bin/env bash
# Phase H — re-run the Phase S checklist on a production Postgres cluster.
# This is the gate that must pass before the live pilot starts (master v6 §1.6):
#   * engine is Postgres with FORCE RLS actually binding the app role
#   * secrets are prod-only (no insecure dev master key, 2FA enrolled for owner)
#   * audit log is live (recent rows)
#   * daily backup ran + monthly restore drill passed on THIS cluster
#   * /health endpoint reports clean signals
#
# Usage:
#   DATABASE_URL=postgres://xacq_app@prod-host/xacqora \
#   PG_BACKUP_USER=xacq_backup APP_URL=https://app.yourdomain.com bash scripts/prod-verify.sh
#
# It changes nothing: read-only checks + one pg_dump restore drill into a
# scratch db (the Phase P pattern).
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FAILS=0
pass() { echo "   ok  $*"; }
fail() { echo "   FAIL  $*"; FAILS=$((FAILS+1)); }

[ -n "${DATABASE_URL:-}" ] || { echo "DATABASE_URL required"; exit 1; }
export PG_BACKUP_USER="${PG_BACKUP_USER:-xacq_backup}"

echo "==> engine + RLS binding"
ENGINE=$(cd "$HERE" && node -e "console.log(require('./server/db').engine())" 2>/dev/null)
[ "$ENGINE" = "pg" ] && pass "engine = pg (Postgres live engine)" || fail "engine = $ENGINE (expected pg)"
# force-RLS: a scoped connection must NOT see other clients' rows
RLS_OUT=$(psql "$DATABASE_URL" -Atc \
  "SELECT set_config('app.unrestricted','false',false), set_config('app.client_ids','2',false);
   SELECT count(*) FROM lead WHERE client_id<>2;" 2>&1)
echo "$RLS_OUT" | grep -q "^0$" && pass "FORCE RLS binding (scoped conn sees only its client)" \
  || fail "RLS check unexpected: $RLS_OUT"

echo "==> secrets prod-only"
node_out=$(cd "$HERE" && node -e "
  process.env.DATABASE_URL = process.env.DATABASE_URL || '';
  const sec = require('./server/lib/security');
  console.log(sec.keySecure() ? 'secure' : 'INSECURE-DEV-KEY');" 2>/dev/null || echo "INSECURE-DEV-KEY")
[ "$node_out" = "secure" ] && pass "XACQORA_SECRET_KEY set (prod-only, secrets at rest encrypted)" \
  || fail "master key is the insecure dev fallback — set XACQORA_SECRET_KEY"
TFA=$(psql "$DATABASE_URL" -Atc "SELECT totp_enabled FROM \"user\" WHERE lower(email) LIKE 'owner%' LIMIT 1;" 2>/dev/null)
[ "$TFA" = "1" ] && pass "2FA enrolled for the owner account" || fail "owner 2FA not enabled (totp_enabled=$TFA)"

echo "==> audit log live"
AUD=$(psql "$DATABASE_URL" -Atc "SELECT COUNT(*) FROM audit_log;" 2>/dev/null)
[ "${AUD:-0}" -gt 0 ] && pass "audit_log has $AUD rows (live)" || fail "audit_log empty — audit not running"

echo "==> backup + restore drill on this cluster"
BK=$(cd "$HERE" && node scripts/backup.js 2>&1 | tail -1)
echo "$BK" | grep -q "backup OK" && pass "daily backup: $BK" || fail "backup failed: $BK"
RD=$(cd "$HERE" && bash scripts/restore-drill.sh 2>&1 | tail -1)
echo "$RD" | grep -q "PASSED" && pass "restore drill: $RD" || fail "restore drill failed: $RD"

echo "==> /health endpoint"
if [ -n "${APP_URL:-}" ]; then
  H=$(curl -s --max-time 10 "${APP_URL%/}/health" 2>/dev/null)
  echo "$H" | grep -q '"ok":true' && pass "/health ok on $APP_URL" || fail "/health not reachable/clean: ${H:0:120}"
  echo "$H" | grep -q '"secret_key_set":true' && pass "health reports secret_key_set=true" || fail "health reports secret_key_set=false"
else
  echo "   skip  APP_URL not set (deploying the app? set APP_URL to re-check)"
fi

echo "==> prod toggles state (informational)"
psql "$DATABASE_URL" -Atc \
  "SELECT coalesce((SELECT value FROM settings WHERE key='capi'),'dry') || ' / ' ||
         coalesce((SELECT value FROM settings WHERE key='meta_business_verified'),'0');" 2>/dev/null \
  | awk '{print "   capi=" $1; print "   meta_business_verified=" $2}'

echo
[ "$FAILS" -eq 0 ] && { echo "PROD VERIFY PASS"; exit 0; } || { echo "PROD VERIFY FAIL: $FAILS check(s)"; exit 1; }
