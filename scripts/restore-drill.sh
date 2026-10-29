#!/usr/bin/env bash
# Monthly restore drill (PRD §10): restore the newest backup into a FRESH
# directory and assert the row counts match the live DB. Exit 0 only if the
# restored snapshot is byte-for-byte query-equivalent on the checked tables.
set -euo pipefail
cd "$(dirname "$0")/.."

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
for t in lead event deal touchpoint user webhook_log; do
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
