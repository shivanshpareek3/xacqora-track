#!/bin/bash
# Page sweep + client-isolation gate. Runs its own server on $PORT (default 4123)
# so it never collides with the dev server on 4100.
cd "/Users/apple/Desktop/Xacora track/xacqora-track"
PORT="${PORT:-4123}"
BASE="http://localhost:$PORT"
O="/tmp/xt-$PORT.txt"; C="/tmp/xt-$PORT-c.txt"

# start a dedicated server on PORT
pgrep -f "node server/index.js" >/dev/null 2>&1 && PORT_PID=$(pgrep -f "node server/index.js" | head -1)
EXIST_ON_PORT=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/signin" 2>/dev/null)
if [ "$EXIST_ON_PORT" != "200" ] && [ "$EXIST_ON_PORT" != "302" ]; then
  ( PORT="$PORT" node server/index.js &>/tmp/xt-$PORT.log & )
  sleep 2
fi
echo "sweeping on $BASE (signin -> $(curl -s -o /dev/null -w "%{http_code}" $BASE/signin))"

# sign in as owner + client
curl -s -c "$O" -o /dev/null -X POST -d "email=owner@xacqora.local&password=xacqora" "$BASE/signin"
curl -s -c "$C" -o /dev/null -X POST -d "email=client@xacqora.local&password=xacqora" "$BASE/signin"

FAILS=0
echo '--- owner sweep (14 screens + demo + xt.js) ---'
for p in dashboard.html leads lead/101 pipeline.html "reports.html?model=last_paid_click" "reports.html?model=first_click" "reports.html?model=linear" "reports.html?model=lead_source" meta.html integrations.html duplicates.html admin.html import demo xt.js; do
  code=$(curl -s -b "$O" -o /dev/null -w "%{http_code}" "$BASE/$p")
  [ "$code" != "200" ] && { echo "FAIL owner $p -> $code"; FAILS=$((FAILS+1)); }
done
[ "$FAILS" -eq 0 ] && echo "all owner pages -> 200"

echo '--- client must be DENIED team-only screens ---'
for p in admin.html integrations.html duplicates.html; do
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

echo "=== SWEEP RESULT: $FAILS failure(s) ==="
exit $FAILS
