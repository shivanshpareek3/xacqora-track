#!/bin/bash
# Page sweep + client-isolation + Phase S security gates. Runs its own server
# on $PORT (default 4123) so it never collides with the dev server on 4100.
cd "/Users/apple/Desktop/Xacora track/xacqora-track"
BASE_DIR="$(pwd)"
PORT="${PORT:-4123}"
BASE="http://localhost:$PORT"
O="$BASE_DIR/tmp/xt-$PORT.txt"; C="$BASE_DIR/tmp/xt-$PORT-c.txt"; rm -rf "$BASE_DIR/tmp"; mkdir -p "$BASE_DIR/tmp"

# ---------------------------------------------------------------------------
# v10 root-cause fix: the sweep runs on a THROWAWAY scratch DB + its own
# server, so a test run can never write to the shared dev/running DB. (The old
# sweep POSTed degenerate `{"client_id":1}` payloads through the live ingest
# pipeline into the dev DB, minting the nameless source_unknown leads that
# had to be scrubbed.) Both engines are covered:
#   * SQLite  -> a scratch file (XACQORA_DB_FILE), created + seeded fresh
#   * Postgres-> a scratch database (DATABASE_URL re-pointed), created + seeded
# The sweep always owns its own server on $PORT and refuses to reuse a
# foreign one (a foreign server would not be pointed at the scratch DB).
# ---------------------------------------------------------------------------
SCRATCH_PID=""; PGU=""; PGH=""; PGP=""; SWEEP_SCRATCH_PG=""
# PGBIN (restore-drill convention) selects the pg tool dir; default = PATH.
PSQL="${PGBIN:+$PGBIN/}psql"
cleanup_scratch() {
  [ -n "$SCRATCH_PID" ] && kill "$SCRATCH_PID" 2>/dev/null
  rm -f "$BASE_DIR/xacqora-sweep-scratch.sqlite3" "$BASE_DIR/xacqora-sweep-scratch.sqlite3-wal" "$BASE_DIR/xacqora-sweep-scratch.sqlite3-shm"
  if [ -n "$SWEEP_SCRATCH_PG" ] && [ -n "$PGU" ]; then
    "$PSQL" -h "$PGH" -p "$PGP" -U "$PGU" -d postgres -v ON_ERROR_STOP=1 \
      -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$SWEEP_SCRATCH_PG' AND pid<>pg_backend_pid();" >/dev/null 2>&1
    "$PSQL" -h "$PGH" -p "$PGP" -U "$PGU" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $SWEEP_SCRATCH_PG;" >/dev/null 2>&1
  fi
}
trap cleanup_scratch EXIT
trap 'exit 130' INT; trap 'exit 143' TERM   # signal -> exit -> EXIT trap does the cleanup

if [ -n "${DATABASE_URL:-}" ]; then
  # Postgres: create a scratch db owned by the app role (has CREATEDB), point
  # the whole sweep + its own server at it, seed it, drop it on exit.
  # Newline-delimited parse so an empty password doesn't shift the fields.
  PGPARSE="$(node -e 'const u=process.env.DATABASE_URL||"";const m=/^postgres(?:ql)?:\/\/([^:]+)(?::([^@]*))?@([^:]+):(\d+)\/(.+)$/.exec(u);if(m)process.stdout.write(m[1]+"\n"+(m[2]||"")+"\n"+m[3]+"\n"+m[4]);' 2>/dev/null)"
  PGU="$(printf '%s' "$PGPARSE" | sed -n '1p')"
  PGPW="$(printf '%s' "$PGPARSE" | sed -n '2p')"
  PGH="$(printf '%s' "$PGPARSE" | sed -n '3p')"
  PGP="$(printf '%s' "$PGPARSE" | sed -n '4p')"
  if [ -z "$PGU" ]; then echo "FAIL: cannot parse DATABASE_URL for the PG scratch db"; exit 2; fi
  [ -n "$PGPW" ] && export PGPASSWORD="$PGPW"
  SWEEP_SCRATCH_PG="xacqora_sweep_$$"
  "$PSQL" -h "$PGH" -p "$PGP" -U "$PGU" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$SWEEP_SCRATCH_PG' AND pid<>pg_backend_pid();" >/dev/null 2>&1
  "$PSQL" -h "$PGH" -p "$PGP" -U "$PGU" -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $SWEEP_SCRATCH_PG;" >/dev/null 2>&1
  "$PSQL" -h "$PGH" -p "$PGP" -U "$PGU" -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $SWEEP_SCRATCH_PG;" >/dev/null 2>&1 \
    || { echo "FAIL: could not create PG scratch db $SWEEP_SCRATCH_PG"; exit 2; }
  export DATABASE_URL="postgres://$PGU${PGPW:+:$PGPW}@${PGH}:${PGP}/${SWEEP_SCRATCH_PG}"
  export PG_BACKUP_USER="${PG_BACKUP_USER:-xacq_backup}"
  echo "sweep: PG scratch db '$SWEEP_SCRATCH_PG' (seeded, dropped on exit)"
elif [ -z "${XACQORA_DB_FILE:-}" ]; then
  # SQLite: a scratch file. (If the caller pinned XACQORA_DB_FILE, respect it.)
  export XACQORA_DB_FILE="$BASE_DIR/xacqora-sweep-scratch.sqlite3"
  echo "sweep: SQLite scratch file $XACQORA_DB_FILE (fresh, removed on exit)"
fi
# Seed the scratch DB (schema + demo data: users, clients, webhook_endpoint
# sec-meta_leadgen, demo leads). idempotent; safe on a brand-new DB.
# Run through the app's env loader in the SAME process so the seed encrypts
# its secrets with the exact key the sweep's server will use to decrypt
# (XACQORA_SECRET_KEY from .env; real shell env vars still win). Without this
# the S.6 secret check 401s instead of reaching the 429.
node -e 'require("./server/lib/env").loadEnvFile(); require("./scripts/seed.js");' >/dev/null 2>&1

# Own the port exclusively: a foreign server would not be on the scratch DB.
if [ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/signin" 2>/dev/null)" = "200" ] || \
   [ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/signin" 2>/dev/null)" = "302" ]; then
  echo "FAIL: port $PORT is busy (a foreign server, not the sweep's scratch one). Stop it or run: PORT=4199 $0"; exit 2
fi
# Low rate limits so the S.6 429 test is quick; the scratch DB overrides the dev .env.
# DATA_MODE=demo pins the sweep to the seed fixture: its masking/isolation/export
# assertions are written against the demo data (owner sees full seed phones/
# emails/leads, client is masked + isolated). Live mode would hide the seed rows
# and those checks would be vacuous — so the sweep always runs on demo data.
PORT="$PORT" XT_RATE_PER_MIN_IP=10 XT_RATE_PER_MIN_ENDPOINT=1000 DATA_MODE=demo node server/index.js &>/tmp/xt-$PORT.log &
SCRATCH_PID=$!
sleep 2
echo "sweeping on $BASE (scratch db, own server pid $SCRATCH_PID; signin -> $(curl -s -o /dev/null -w "%{http_code}" $BASE/signin))"

# sign in as owner + client
curl -s -c "$O" -o /dev/null -X POST -d "email=owner@xacqora.local&password=xacqora" "$BASE/signin"
curl -s -c "$C" -o /dev/null -X POST -d "email=client@xacqora.local&password=xacqora" "$BASE/signin"

FAILS=0
echo '--- owner sweep (14 screens + demo + xt.js) ---'
for p in dashboard.html leads lead/101 pipeline.html "reports.html?model=last_paid_click" "reports.html?model=first_click" "reports.html?model=linear" "reports.html?model=lead_source" meta.html integrations.html duplicates.html admin.html import pilot alerts.html demo xt.js; do
  code=$(curl -s -b "$O" -o /dev/null -w "%{http_code}" "$BASE/$p")
  [ "$code" != "200" ] && { echo "FAIL owner $p -> $code"; FAILS=$((FAILS+1)); }
done
[ "$FAILS" -eq 0 ] && echo "all owner pages -> 200"

echo '--- client must be DENIED team-only screens ---'
for p in admin.html integrations.html duplicates.html pilot alerts.html; do
  code=$(curl -s -b "$C" -o /dev/null -w "%{http_code}" "$BASE/$p")
  if [ "$code" = "200" ]; then echo "FAIL client $p is 200 (should be 403)"; FAILS=$((FAILS+1)); else echo "ok client $p -> $code (denied)"; fi
done

echo '--- v14: Webhooks & API Keys screen (team-only) + public token route ---'
WOK=$(curl -s -b "$O" -o /tmp/xt-wh.json -w "%{http_code}" "$BASE/api/app/webhooks")
[ "$WOK" = "200" ] && grep -q '"apikeys"' /tmp/xt-wh.json && echo "ok owner /api/app/webhooks -> 200 (carries endpoints + apikeys)" || { echo "FAIL owner /api/app/webhooks not 200/apikeys ($WOK)"; FAILS=$((FAILS+1)); }
W403=$(curl -s -b "$C" -o /dev/null -w "%{http_code}" "$BASE/api/app/webhooks")
[ "$W403" = "403" ] && echo "ok client /api/app/webhooks -> 403 (team-only)" || { echo "FAIL client /api/app/webhooks -> $W403 (expect 403)"; FAILS=$((FAILS+1)); }
# public token-in-URL route: a made-up FlexiFunnels token must 404 (FlexiFunnels
# can only reach this URL via a public domain / tunnel — never the sweep host).
T404=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" -d '{"data":{"phone":"+919999000011"}}' "$BASE/webhooks/flexifunnels/demo/$(printf '0%.0s' $(seq 40))")
[ "$T404" = "404" ] && echo "ok unknown webhook token -> 404" || { echo "FAIL unknown webhook token -> $T404 (expect 404)"; FAILS=$((FAILS+1)); }
TGET=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/webhooks/flexifunnels/demo/$(printf '0%.0s' $(seq 40))")
[ "$TGET" = "200" ] && echo "ok GET webhook URL -> 200 (verify probe, no enqueue)" || { echo "FAIL GET webhook URL -> $TGET (expect 200)"; FAILS=$((FAILS+1)); }

echo '--- Phase H: /health JSON + alerts screen ---'
HCODE=$(curl -s -b "$O" -o /tmp/xt-health.json -w "%{http_code}" "$BASE/health")
echo "/health -> $HCODE"; [ "$HCODE" = "200" ] || { echo "FAIL /health not 200"; FAILS=$((FAILS+1)); }
grep -qE '"ok":[[:space:]]*true' /tmp/xt-health.json && echo "ok /health reports ok:true" || { echo "FAIL /health missing ok"; FAILS=$((FAILS+1)); }
grep -q '"webhook_failures"' /tmp/xt-health.json && echo "ok /health carries the 5 alert signals" || { echo "FAIL /health missing alert signals"; FAILS=$((FAILS+1)); }
ACODE=$(curl -s -b "$O" -o /dev/null -w "%{http_code}" "$BASE/alerts.html")
echo "alerts.html owner -> $ACODE"; [ "$ACODE" = "200" ] || { echo "FAIL owner alerts.html not 200"; FAILS=$((FAILS+1)); }

echo '--- phone masking: client role must never see full phone digits ---'
M=$(curl -s -b "$C" "$BASE/leads" | grep -cE "9812345678|9822233344|9777788899")
Ofull=$(curl -s -b "$O" "$BASE/leads" | grep -cE "9812345678|9822233344|9777788899")
echo "full phone digits: client=$M (expect 0), owner=$Ofull (expect >0)"
[ "$M" != "0" ] && { echo "FAIL unmasked phone visible to client"; FAILS=$((FAILS+1)); }
[ "$Ofull" = "0" ] && { echo "FAIL owner should see full phones"; FAILS=$((FAILS+1)); }

echo '--- client isolation: client1 must not see client2 data ---'
# client@ is client 1. Client-2 phone is 9777788899, ad acct ACT-100002, name "Kaya".
for pair in "leads:9777788899" "reports.html:ACT-100002" "dashboard.html:Kaya"; do
  pg="${pair%%:*}"; needle="${pair##*:}"
  hit=$(curl -s -b "$C" "$BASE/$pg" | grep -c "$needle")
  if [ "$hit" != "0" ]; then echo "FAIL client1 sees client2 data on $pg ($needle)"; FAILS=$((FAILS+1)); else echo "ok client1 isolated on $pg"; fi
done

echo '--- xt.js size (must be < 10KB) ---'
SZ=$(wc -c < public/xt.js | tr -d ' ')
echo "xt.js = $SZ bytes"; [ "$SZ" -ge 10240 ] && { echo "FAIL xt.js over 10KB"; FAILS=$((FAILS+1)); } || echo "ok under 10KB"

# ---------------------------------------------------------------- Phase S
echo '--- S.4: email masking (client role must not see full email) ---'
# seed emails: ravi@example.com / meera@example.com / karan@example.com
M2=$(curl -s -b "$C" "$BASE/leads" | grep -cE "ravi@example|meera@example|karan@example")
Ofull2=$(curl -s -b "$O" "$BASE/leads" | grep -cE "ravi@example|meera@example|karan@example")
echo "full emails: client=$M2 (expect 0), owner=$Ofull2 (expect >0)"
[ "$M2" != "0" ] && { echo "FAIL unmasked email visible to client"; FAILS=$((FAILS+1)); }
[ "$Ofull2" = "0" ] && { echo "FAIL owner should see full emails"; FAILS=$((FAILS+1)); }

echo '--- S.4: CSV export + audit log ---'
exported=$(curl -s -b "$O" "$BASE/export/leads")
expHead=$(echo "$exported" | head -1)
echo "export/leads header: $expHead"
[ "$expHead" != "id,name,phone,email,city,stage,owner,client,paid" ] && { echo "FAIL export/leads header wrong"; FAILS=$((FAILS+1)); }
# owner export = unmasked; client export = masked
fullInClientExport=$(curl -s -b "$C" "$BASE/export/leads" | grep -cE "ravi@example|meera@example")
echo "client export full-email leak: $fullInClientExport (expect 0)"
[ "$fullInClientExport" != "0" ] && { echo "FAIL client CSV export leaks full emails"; FAILS=$((FAILS+1)); }
# every export writes an audit_log row
sleep 0.2
if [ -n "${DATABASE_URL:-}" ]; then
  auditCount=$(node scripts/dbq.js "SELECT COUNT(*) c FROM audit_log WHERE action='export.csv'" | tail -1 | tr -d '\r ')
else
  # v10: the sweep's SQLite scratch db (XACQORA_DB_FILE), never the dev db
  auditCount=$(node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.env.XACQORA_DB_FILE||'xacqora.sqlite3',({readOnly:true}));console.log(d.prepare(\"SELECT COUNT(*) c FROM audit_log WHERE action='export.csv'\").get().c);" 2>/dev/null)
fi
echo "audit_log export.csv rows: $auditCount (expect >0)"
[ "${auditCount:-0}" = "0" ] && { echo "FAIL exports not written to audit log"; FAILS=$((FAILS+1)); }

echo '--- S.6: per-IP + per-endpoint rate limit (429) ---'
rl429=0
for i in $(seq 1 40); do
  # __sweep_test: the ingest layer logs these as test + does NOT mint a lead
  # (v10 guard). Defense-in-depth — the sweep also runs on a scratch DB.
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
    -H "X-Forwarded-For: 1.2.3.4" -d '{"client_id":1,"__sweep_test":true}' "$BASE/api/ingest/meta_leadgen?secret=sec-meta_leadgen")
  [ "$code" = "429" ] && { rl429=$i; break; }
done
echo "rate-limited after request #$rl429"
[ -z "$rl429" ] && { echo "FAIL per-IP limit never returned 429 in 40 reqs"; FAILS=$((FAILS+1)); }

echo '--- S.5: backup + restore drill ---'
# FORCE RLS makes pg_dump refuse an export by the RLS-bound app role; on a
# Postgres cluster the backup/restore path runs as the superuser backup role
# (created by scripts/pg-dev.sh + pg-provision.sh). Override with PG_BACKUP_USER.
[ -n "${DATABASE_URL:-}" ] && export PG_BACKUP_USER="${PG_BACKUP_USER:-xacq_backup}"
bkout=$(node scripts/backup.js 2>&1); bk="${bkout##*$'\n'}"
echo "backup: $bk"
echo "$bkout" | grep -q "backup OK" || { echo "FAIL backup.js did not report OK"; echo "$bkout"; FAILS=$((FAILS+1)); }
rd=$(bash scripts/restore-drill.sh 2>&1 | tail -1); echo "restore: $rd"
echo "$rd" | grep -q "PASSED" || { echo "FAIL restore-drill did not pass"; FAILS=$((FAILS+1)); }

echo '--- S.3: 2FA flow (enroll -> OTP verify -> session; wrong code denied) ---'
T="$BASE_DIR"/tmp/xt-$PORT-tfa.txt
setup=$(curl -s -b "$O" -c "$O" -X POST -d "action=enroll" "$BASE/admin/2fa" -o /dev/null -w "%{redirect_url}")
# The sweep's own server auto-loads the repo .env (server/lib/env.js), where a
# real XACQORA_SECRET_KEY may live; this standalone decrypt MUST resolve the key
# the same way or the GCM tag check fails against the dev-fallback key.
secret=$(node scripts/dbq.js "SELECT totp_secret FROM \"user\" WHERE lower(email)='owner@xacqora.local'" 2>/dev/null | tail -1 | tr -d '\r' | node -e "require('./server/lib/env').loadEnvFile();const s=require('fs').readFileSync(0,'utf8').trim();const sec=require('./server/lib/security');if(!s){console.log('');process.exit(0)}console.log(sec.decryptSecret(s));")
[ -z "$secret" ] && { echo "FAIL could not read enrolled 2FA secret"; FAILS=$((FAILS+1)); }
# sign out, sign back in with a FRESH jar so the xt_tfa pending cookie is captured
rm -f "$T"
curl -s -b "$O" -o /dev/null "$BASE/signout"
PENDING_COOKIE=$(curl -s -i -c "$T" -X POST -d "email=owner@xacqora.local&password=xacqora" "$BASE/signin" | grep -ci "set-cookie.*xt_tfa=")
echo "pending 2FA marker set: $PENDING_COOKIE (expect 1)"
[ "$PENDING_COOKIE" != "1" ] && { echo "FAIL sign-in did not enter 2FA-pending state"; FAILS=$((FAILS+1)); }
tcode=$(node -e "const sec=require('./server/lib/security');console.log(sec.totpCode(process.argv[1]));" "$secret")
# wrong code must be rejected (the verify POST must carry the xt_tfa cookie)
wrong=$(curl -s -b "$T" -o /dev/null -w "%{http_code}" -X POST -d "code=000000" "$BASE/2fa/verify")
echo "wrong-code status: $wrong (expect 401)"
[ "$wrong" != "401" ] && { echo "FAIL wrong 2FA code was not rejected"; FAILS=$((FAILS+1)); }
ok=$(curl -s -b "$T" -c "$T" -o /dev/null -w "%{http_code}" -X POST -d "code=$tcode" "$BASE/2fa/verify")
echo "correct-code status: $ok (expect 302)"
[ "$ok" != "302" ] && { echo "FAIL correct 2FA code did not complete sign-in"; FAILS=$((FAILS+1)); }
# the completed login issued a real session cookie
grep -q "xt_session" "$T" 2>/dev/null && echo "ok session cookie issued after 2FA" || { echo "FAIL no session cookie after 2FA verify"; FAILS=$((FAILS+1)); }
# disable 2FA again so the next sweep run starts clean
curl -s -b "$T" -X POST -d "action=disable" "$BASE/admin/2fa" -o /dev/null

echo "=== SWEEP RESULT: $FAILS failure(s) ==="
exit $FAILS
