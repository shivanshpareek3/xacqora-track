#!/usr/bin/env node
// Meta token validation (before you fill .env). Offline-safe: with no network
// it prints what to grab from Meta Business Suite and exits 0. With a token
// it checks /me + /me/adaccounts (list of accessible ACT_ ids) + /debug_token
// (expiry), then writes token_expires_at onto the matching meta_ad_account
// rows so /alerts can warn "token expires on X".
//
//   node scripts/meta-validate.js                     # reads .env (fill it first)
//   node scripts/meta-validate.js META_ACCESS_TOKEN=EAAB...   # CLI override
// Exit codes: 0 = ok/offline, 1 = token invalid/expired/insufficient.
process.env.XACQORA_LIVE = process.env.XACQORA_LIVE; // don't force mock
require('../server/lib/env').loadEnvFile();
const { open, makeTx } = require('../server/db');
const ml = require('../server/lib/metalive');

const token = process.argv[2] && process.argv[2].startsWith('META_ACCESS_TOKEN=')
  ? process.argv[2].slice('META_ACCESS_TOKEN='.length).trim()
  : (process.env.META_ACCESS_TOKEN || '').trim();
const wantIds = (process.env.META_AD_ACCOUNT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

const graph = (suffix) => `https://graph.facebook.com/v19.0${suffix}`;
const showOfflineHelp = () => {
  console.log('No META_ACCESS_TOKEN set (or offline). Grab it from Meta, then re-run:');
  console.log('  1. Business Suite > System Users > your user > Generate Token > 60-day token');
  console.log('  2. Permissions: ads_read (spend pull) + pages_read_engagement (later, lead forms)');
  console.log('  3. Business Settings > System Users > your user > assign the ad account(s)');
  console.log('  4. Fill META_ACCESS_TOKEN + META_AD_ACCOUNT_IDS in .env, restart the server');
};

(async () => {
  if (!token) { showOfflineHelp(); process.exit(0); }
  let me, accts, dbg;
  try {
    const rMe = await fetch(graph('/me'), { headers: { Authorization: 'Bearer ' + token } });
    me = await rMe.json().catch(() => ({}));
  } catch { showOfflineHelp(); process.exit(0); } // offline
  if (!me.id) {
    console.log('✗ token rejected by /me (' + me.error && me.error.message + '). Regenerate it in Business Suite.');
    process.exit(1);
  }
  console.log('✓ token valid — system user: ' + (me.name || me.type || me.id));
  try {
    const rA = await fetch(graph('/me/adaccounts?limit=100'), { headers: { Authorization: 'Bearer ' + token } });
    accts = await rA.json().catch(() => ({}));
    const list = (accts.data || []).map((a) => a.id);
    console.log('✓ accessible ad accounts (' + list.length + '): ' + (list.join(', ') || 'NONE — assign accounts in Business Settings > System Users'));
    for (const id of wantIds) {
      if (!list.includes(id)) console.log('✗ ' + id + ' is NOT accessible to this token — assign it, or drop it from META_AD_ACCOUNT_IDS');
    }
  } catch { console.log('(!) /me/adaccounts unreachable (offline?) — skip account check'); }
  try {
    const rD = await fetch(graph('/debug_token?input_token=' + encodeURIComponent(token)), { headers: { Authorization: 'Bearer ' + token } });
    dbg = await rD.json().catch(() => ({}));
    const d = dbg.data || {};
    const exp = d.expiration == null ? null : (d.expiration === -1 ? 'never (long-lived system user token)' : new Date(d.expiration * 1000).toISOString());
    console.log('✓ token expires: ' + exp + (d.app && d.app.name ? '  (app: ' + d.app.name + ')' : ''));
    // record the expiry on the matching rows so /alerts can warn
    if (exp && exp !== 'never (long-lived system user token)' && !isNaN(Date.parse(exp))) {
      const db = open();
      const tx = makeTx(db, null);
      const ids = wantIds.length ? wantIds : ((accts.data || []).map((a) => a.id));
      // ensure the rows exist (same idempotent upsert the server bootstrap uses),
      // then stamp the expiry so /alerts can warn 48h ahead
      ml.syncMetaAccountsFromEnv(tx, { token, adAccountIds: ids, pixelId: process.env.META_PIXEL_ID || null, name: process.env.META_AD_ACCOUNT_NAME, clientId: process.env.META_CLIENT_ID });
      for (const id of ids) {
        tx.run(`UPDATE meta_ad_account SET token_expires_at=? WHERE ad_account_id=?`, exp, id);
      }
      console.log('✓ recorded token_expires_at=' + exp + ' on ' + ids.length + ' account row(s); /alerts will warn 48h before');
      db.close ? db.close() : null;
    }
  } catch { console.log('(!) /debug_token unreachable — cannot record expiry (pull will still work)'); }
  process.exit(0);
})().catch((e) => { console.error('meta-validate failed:', e.message); process.exit(1); });
