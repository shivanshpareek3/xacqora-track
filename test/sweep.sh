#!/bin/bash
# Page sweep + client-isolation + Phase S security gates. Runs its own server
# on $PORT (default 4123) so it never collides with the dev server on 4100.
cd "/Users/apple/Desktop/Xacora track/xacqora-track"
BASE_DIR="$(pwd)"
PORT="${PORT:-4123}"
BASE="http://localhost:$PORT"
O="$BASE_DIR/tmp/xt-$PORT.txt"; C="$BASE_DIR/tmp/xt-$PORT-c.txt"; rm -rf "$BASE_DIR/tmp"; mkdir -p "$BASE_DIR/tmp"

# start a dedicated server on PORT (low rate limits so the S.6 429 test is quick)
EXIST_ON_PORT=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/signin" 2>/dev/null)
if [ "$EXIST_ON_PORT" != "200" ] && [ "$EXIST_ON_PORT" != "302" ]; then
  # Phase P: on Postgres the dev db must be seeded first (users/leads/deals)
  [ -n "${DATABASE_URL:-}" ] && node scripts/seed.js >/dev/null 2>&1
  ( PORT="$PORT" XT_RATE_PER_MIN_IP=10 XT_RATE_PER_MIN_ENDPOINT=1000 node server/index.js &>/tmp/xt-$PORT.log & )
  sleep 2
fi
echo "sweeping on $BASE (signin -> $(curl -s -o /dev/null -w "%{http_code}" $BASE/signin))"

# sign in as owner + client
curl -s -c "$O" -o /dev/null -X POST -d "email=owner@xacqora.local&password=xacqora" "$BASE/signin"
curl -s -c "$C" -o /dev/null -X POST -d "email=client@xacqora.local&password=xacqora" "$BASE/signin"

FAILS=0
echo '--- owner sweep (14 screens + demo + xt.js) ---'
for p in dashboard.html leads lead/101 pipeline.html "reports.html?model=last_paid_click" "reports.html?model=first_click" "reports.html?model=linear" "reports.html?model=lead_source" meta.html integrations.html duplicates.html admin.html import pilot demo xt.js; do
  code=$(curl -s -b "$O" -o /dev/null -w "%{http_code}" "$BASE/$p")
  [ "$code" != "200" ] && { echo "FAIL owner $p -> $code"; FAILS=$((FAILS+1)); }
done
[ "$FAILS" -eq 0 ] && echo "all owner pages -> 200"

echo '--- client must be DENIED team-only screens ---'
for p in admin.html integrations.html duplicates.html pilot; do
  code=$(curl -s -b "$C" -o /dev/null -w "%{http_code}" "$BASE/$p")
  if [ "$code" = "200" ]; then echo "FAIL client $p is 200 (should be 403)"; FAILS=$((FAILS+1)); else echo "ok client $p -> $code (denied)"; fi
done

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
  auditCount=$(node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('xacqora.sqlite3');console.log(d.prepare(\"SELECT COUNT(*) c FROM audit_log WHERE action='export.csv'\").get().c);" 2>/dev/null)
fi
echo "audit_log export.csv rows: $auditCount (expect >0)"
[ "${auditCount:-0}" = "0" ] && { echo "FAIL exports not written to audit log"; FAILS=$((FAILS+1)); }

echo '--- S.6: per-IP + per-endpoint rate limit (429) ---'
rl429=0
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Type: application/json" \
    -H "X-Forwarded-For: 1.2.3.4" -d '{"client_id":1}' "$BASE/api/ingest/meta_leadgen?secret=sec-meta_leadgen")
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
secret=$(node scripts/dbq.js "SELECT totp_secret FROM \"user\" WHERE lower(email)='owner@xacqora.local'" 2>/dev/null | tail -1 | tr -d '\r' | node -e "const s=require('fs').readFileSync(0,'utf8').trim();const sec=require('./server/lib/security');console.log(sec.decryptSecret(s));")
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
