#!/usr/bin/env node
// One-time 30-day history backfill for real Meta ad accounts.
//
// WHY: the 3h ticker only refreshes the recent 7 days (older days are final
// and accumulate in spend_daily over time). A freshly-mapped account
// therefore has NO month of history until this runs, and the dashboard's
// "Last 30d" KPI sums only the few days that exist — under-counting spend
// badly (the v13 bug: ~7 days' worth was shown as 30 days). Run this right
// after mapping a new account (or all accounts) so the 30d KPI is real.
//
// Idempotent: runMetaPull upserts spend_daily (ON CONFLICT update), so
// re-running just refreshes. Safe to run any time.
//
// Usage:
//   node scripts/meta-backfill.js               # every real act_ account
//   node scripts/meta-backfill.js act_12345     # one account only
//
// GUARD: refuses to run in mock mode — a mock "backfill" would seed 30 days
// of FAKE spend into the DB. Requires live mode (XACQORA_LIVE=1 + a real
// non-MOCK token for the account).
'use strict';
const env = require('../server/lib/env');
env.loadEnvFile();
const { open, makeTx } = require('../server/db');
const sec = require('../server/lib/security');

const liveMode = process.env.XACQORA_LIVE === '1' && process.env.MOCK !== '1';
if (!liveMode) {
  console.error('REFUSED: live mode is off (set XACQORA_LIVE=1 and clear MOCK=1). A mock backfill would seed 30 days of FAKE spend.');
  process.exit(1);
}

const db = open();
const tx = makeTx(db, null);
const meta = require('../server/lib/meta');
const dayOff = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const DAYS = 30;
const from = dayOff(DAYS), to = dayOff(0); // today-inclusive; the 30d KPI basis is N-30..N-1

const wanted = process.argv[2] ? [process.argv[2]] : null;
const accts = tx.all(`SELECT ad_account_id, name FROM meta_ad_account WHERE ad_account_id NOT LIKE 'ACT-%' ORDER BY client_id, ad_account_id`);
const picks = wanted ? accts.filter((a) => a.ad_account_id === wanted[0]) : accts;
if (!picks.length) { console.error(wanted ? `no account named ${wanted[0]}` : 'no real act_ accounts found'); process.exit(1); }

(async () => {
  for (const a of picks) {
    const token = sec.decryptSecret(tx.get(`SELECT token FROM meta_ad_account WHERE ad_account_id=?`, a.ad_account_id)?.token || '');
    if (!token || token === 'MOCK') { console.log(`SKIP ${a.ad_account_id} [${a.name}] — no live token (mock account)`); continue; }
    try {
      await meta.runMetaPull(tx, { ad_account_id: a.ad_account_id, from, to });
      const r = tx.get(`SELECT COUNT(*) n, MIN(date) mn, MAX(date) mx, COALESCE(SUM(spend),0) s FROM spend_daily WHERE ad_account_id=? AND date>=? AND date<=?`, a.ad_account_id, dayOff(DAYS), dayOff(1));
      console.log(`OK   ${a.ad_account_id} [${a.name}] ${DAYS}d=${Number(r.s).toLocaleString('en-IN', { maximumFractionDigits: 0 })} (${r.n} rows, ${r.mn}..${r.mx})`);
    } catch (e) {
      console.log(`FAIL ${a.ad_account_id} [${a.name}] — ${e.message}`);
    }
  }
  console.log('backfill complete');
})();
