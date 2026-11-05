#!/usr/bin/env node
// v10 one-shot: fetch each REAL ad account's Meta display name (+ billing
// currency) and persist it onto meta_ad_account. The env->DB bootstrap
// (server/lib/metalive.js) created accounts with `name = ad_account_id`
// (the raw id) because META_AD_ACCOUNT_NAME was unset, and the pull only
// started storing the real name in v10 — so pre-existing rows still show the
// id on the dashboard switcher + Meta hub. This script reads each account's
// own encrypted token, calls AdAccount?fields=name,currency, and writes the
// real name back. Idempotent + offline-safe: no token / no network = it
// prints and skips, never touches the row. The token is never printed.
//
//   node scripts/meta-name-sync.js                 # SQLite dev DB
//   DATABASE_URL=... node scripts/meta-name-sync.js  # Postgres
const { open, makeTx } = require('../server/db');
const sec = require('../server/lib/security');
require('../server/lib/env').loadEnvFile(); // same key resolution as the server

(async () => {
  const db = open();
  const tx = makeTx(db);
  const accounts = tx.all(`SELECT id, ad_account_id, name, token, currency
    FROM meta_ad_account WHERE ad_account_id LIKE 'act_%' ORDER BY ad_account_id`);
  if (!accounts.length) { console.log('[meta-name-sync] no real (act_) ad accounts found — nothing to do.'); if (db.close) db.close(); return; }

  console.log(`[meta-name-sync] ${accounts.length} real ad account(s); fetching AdAccount name+currency per account`);
  let changed = 0, skipped = 0, failed = 0;
  for (const a of accounts) {
    const token = sec.decryptSecret(a.token || '');
    if (!token || token === 'MOCK') { console.log(`  skip ${a.ad_account_id} (no usable encrypted token)`); skipped++; continue; }
    try {
      const r = await fetch(`https://graph.facebook.com/v19.0/${a.ad_account_id}?fields=name,currency&access_token=${encodeURIComponent(token)}`);
      const b = await r.json().catch(() => ({}));
      if (!r.ok) { console.log(`  FAIL ${a.ad_account_id}: meta ${r.status} ${b.error && b.error.message || ''}`); failed++; continue; }
      const name = b.name ? String(b.name).trim() : '';
      const cur = b.currency ? String(b.currency).toUpperCase() : null;
      if (name && name !== a.ad_account_id) {
        tx.run(`UPDATE meta_ad_account SET name=? WHERE id=?`, name, a.id);
        changed++;
        console.log(`  ${a.ad_account_id}: "${a.name}" -> "${name}"` + (cur && !a.currency ? `  currency -> ${cur}` : ''));
      } else {
        skipped++;
        console.log(`  ${a.ad_account_id}: name already set ("${a.name}")`);
      }
      if (cur && !a.currency) tx.run(`UPDATE meta_ad_account SET currency=? WHERE id=?`, cur, a.id);
    } catch (e) {
      failed++;
      console.log(`  ERROR ${a.ad_account_id}: ${e.message}`);
    }
  }
  if (db.close) db.close();
  console.log(`[meta-name-sync] done: ${changed} renamed, ${skipped} unchanged, ${failed} failed`);
})();
