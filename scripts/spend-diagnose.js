#!/usr/bin/env node
// Spend-accuracy diagnosis (read-only) — v13 spend-accuracy task, §1.
//
// For every real `act_` ad account it prints THREE spend numbers over the
// dashboard's 7-day window + the Ads-Manager "last 7 days" window:
//   (a) app DB   : SUM(spend_daily.spend / spend_inr) per window
//   (b) Meta live: ACCOUNT-LEVEL insights aggregate for the same window
//   (c) Meta live: AD-LEVEL daily rows summed for the same window (what the
//       pipeline actually stores — level=ad, time_increment=1)
// plus drift % (a vs b, b vs c), the exact date ranges (incl. whether "today"
// is in), last_pull_at, the fx_rate table, and per-account notes (AED
// currency, near-zero accounts).
//
// Read-only: it fetches Meta insights + reads the DB. It does NOT upsert
// spend_daily, NOT record a check, NOT touch any table. Tokens are read
// from meta_ad_account (encrypted; decrypted in-memory with the .env key)
// and are NEVER printed.
//
// Run:  node scripts/spend-diagnose.js            (SQLite dev DB)
//       DATABASE_URL=... node scripts/spend-diagnose.js   (PG)
// Live Meta numbers require live mode: the script sets the same rules as
// lib/liveapi (XACQORA_LIVE=1 + a non-MOCK token), which the dev .env has.
'use strict';
const { open, makeTx } = require('../server/db');
const env = require('../server/lib/env');
const sec = require('../server/lib/security');

env.loadEnvFile(); // .env: XACQORA_SECRET_KEY (decrypt tokens), XACQORA_LIVE, DATA_MODE

const db = open();
const tx = makeTx(db, null);
const L = { engine: db.engine, live: process.env.XACQORA_LIVE === '1' && process.env.MOCK !== '1' };

// ---------------------------------------------------------------- dates
// The app's window (shared.js since(7)): today (UTC calendar day) minus 6 -> today.
const day = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
const TODAY = day(0), W7_FROM = day(6);              // app 7d: N-6 .. N (today IN)
const AM_FROM = day(7), AM_TO = day(1);              // Ads Manager "last 7 days": N-7 .. N-1 (today OUT)

// ---------------------------------------------------------------- live fetch
const graphGet = async (path, params, token) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) q.set(k, String(v));
  q.set('access_token', token);
  const r = await fetch(`https://graph.facebook.com/v19.0${path}?` + q.toString(), { signal: AbortSignal.timeout(60000) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`meta ${path} ${r.status}: ${String(body.error && body.error.message || '').slice(0, 160)}`);
  return body;
};
// account-level aggregate insights for [from,to]. NOTE: v19.0 rejects
// `link_clicks`/`currency` as insights fields (#100) — the pipeline stores
// `clicks` (all clicks), so the diagnosis asks for the same valid set.
async function accountLevel(accId, from, to, token) {
  const b = await graphGet(`/${accId}/insights`,
    { fields: 'spend,impressions,reach,clicks,conversions', time_range: JSON.stringify({ since: from, until: to }) }, token);
  const rows = b.data || [];
  return rows.length ? {
    spend: +(rows[0].spend ?? 0), impressions: Number(rows[0].impressions ?? 0),
    reach: Number(rows[0].reach ?? 0), clicks: Number(rows[0].clicks ?? 0),
    conversions: Number(rows[0].conversions ?? 0),
  } : null;
}
// ad-level daily rows summed (what runLiveMetaPull stores) for [from,to]
async function adLevelSum(accId, from, to, token) {
  const fields = 'ad_id,spend,impressions,reach,clicks,date_start';
  const timeRange = JSON.stringify({ since: from, until: to });
  const first = await graphGet(`/${accId}/insights`,
    { level: 'ad', fields, time_range: timeRange, time_increment: 1, limit: 250 }, token);
  const rows = [...(first.data || [])];
  let p = first.paging; let i = 1;
  while (p && p.next && i < 5) {
    const r = await fetch(p.next, { signal: AbortSignal.timeout(60000) });
    if (!r.ok) break;
    const j = await r.json().catch(() => ({}));
    rows.push(...(j.data || [])); p = j.paging; i++;
  }
  const s = rows.reduce((a, r) => {
    a.spend += Number(r.spend ?? 0); a.impressions += Number(r.impressions ?? 0);
    a.reach += Number(r.reach ?? 0); a.clicks += Number(r.clicks ?? 0); return a;
  }, { spend: 0, impressions: 0, reach: 0, clicks: 0 });
  return { ...s, rows: rows.length };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const drift = (a, b) => (b ? Math.abs(a - b) / Math.abs(b) * 100 : null);
const fmt = (n, d = 2) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }));

// ---------------------------------------------------------------- app side
const accounts = tx.all(`
  SELECT a.ad_account_id, a.name, a.currency, a.status, a.last_pull_at, a.last_error
  FROM meta_ad_account a
  WHERE a.ad_account_id NOT LIKE 'ACT-%'
    AND NOT EXISTS (SELECT 1 FROM client c WHERE c.id = a.client_id AND c.demo = 1)
  ORDER BY a.client_id, a.ad_account_id`);

const appWindow = (from, to, acc) => tx.get(`
  SELECT COALESCE(SUM(spend),0) spend, COALESCE(SUM(spend_inr),0) spend_inr,
    COALESCE(SUM(impressions),0) imp, COALESCE(SUM(reach),0) reach, COALESCE(SUM(clicks),0) clicks,
    MIN(date) dmin, MAX(date) dmax, COUNT(*) rows
  FROM spend_daily s WHERE s.ad_account_id=? AND s.date >= ? AND s.date <= ?`, acc, from, to);
const appAllTime = (acc) => tx.get(`SELECT COALESCE(SUM(spend),0) spend, MIN(date) dmin, MAX(date) dmax, COUNT(*) n FROM spend_daily WHERE ad_account_id=?`, acc) || { spend: 0, n: 0 };

const fx = tx.all(`SELECT date, currency, inr_per_unit FROM fx_rate ORDER BY date DESC, currency LIMIT 8`);

// ---------------------------------------------------------------- per-account
(async () => {
console.log('# spend-diagnose  engine=' + L.engine + '  live-fetch=' + (L.live ? 'ON' : 'OFF (mock — live numbers will be n/a)'));
console.log('app 7d window        : ' + W7_FROM + ' → ' + TODAY + '   (today IN, UTC calendar day)');
console.log('Ads Manager window   : ' + AM_FROM + ' → ' + AM_TO + '   (today OUT — 7 complete days)');
console.log('fx_rate rows (dev DB): ' + JSON.stringify(fx));
console.log('');
const table = [];
for (const a of accounts) {
  const app7 = appWindow(W7_FROM, TODAY, a.ad_account_id);
  const appAM = appWindow(AM_FROM, AM_TO, a.ad_account_id);
  const alltime = appAllTime(a.ad_account_id);
  const row = { acc: a, app7, appAM, alltime, last_pull_at: a.last_pull_at, last_error: a.last_error };

  if (L.live && a.status === 'connected') {
    const token = sec.decryptSecret(tx.get(`SELECT token FROM meta_ad_account WHERE ad_account_id=?`, a.ad_account_id)?.token || '');
    row.tokenPresent = !!(token && token !== 'MOCK');
    if (row.tokenPresent) {
      try {
        row.b = await accountLevel(a.ad_account_id, W7_FROM, TODAY, token); await sleep(250);
        row.b2 = await accountLevel(a.ad_account_id, AM_FROM, AM_TO, token); await sleep(250);
        row.c = await adLevelSum(a.ad_account_id, W7_FROM, TODAY, token); await sleep(250);
      } catch (e) { row.liveErr = e.message; }
    }
  }
  row.dAppVsLive = drift(row.app7?.spend, row.b?.spend);           // (a) vs (b), same N-6..N window
  row.dAppAmVsLive = drift(row.appAM?.spend, row.b2?.spend);       // (a over AM window) vs (b2)
  row.dLiveVsAdSum = drift(row.b?.spend, row.c?.spend);           // (b) vs (c) — Meta's own level gap
  table.push(row);
}

// ---------------------------------------------------------------- print
console.log('='.repeat(140));
console.log('| account | app 7d (native) | app 7d (INR col) | Meta acct-level 7d | Meta ad-level sum | drift app↔live | drift live↔adsum | last_pull_at |');
console.log('='.repeat(140));
for (const r of table) {
  const cur = r.acc.currency || '?';
  console.log(
    String(r.acc.ad_account_id).slice(0, 26).padEnd(18) + ' ' +
    String(r.acc.name || '').slice(0, 18).padEnd(18) + ' ' +
    fmt(r.app7?.spend).padStart(12) + ' ' + cur.padEnd(6) + ' | ' +
    fmt(r.app7?.spend_inr).padStart(10) + ' | ' +
    fmt(r.b?.spend ?? null, 0).padStart(14) + ' | ' +
    fmt(r.c?.spend ?? null, 0).padStart(14) + ' | ' +
    (r.dAppVsLive == null ? '—' : r.dAppVsLive.toFixed(2) + '%').padStart(8) + ' | ' +
    (r.dLiveVsAdSum == null ? '—' : r.dLiveVsAdSum.toFixed(2) + '%').padStart(8) + ' | ' +
    String(r.last_pull_at || '').slice(0, 19));
}
console.log('');
for (const r of table) {
  console.log('— ' + r.acc.name + ' (' + r.acc.ad_account_id + ') [' + (r.acc.currency || '?') + ']');
  console.log('   app 7d window rows : ' + r.app7?.rows + ' (dates ' + r.app7?.dmin + ' .. ' + r.app7?.dmax + ')');
  console.log('   app AM window      : spend=' + fmt(r.appAM?.spend) + ' imp=' + fmt(r.appAM?.imp, 0) + ' reach=' + fmt(r.appAM?.reach, 0) + ' clicks=' + fmt(r.appAM?.clicks, 0));
  console.log('   live acct-level 7d : spend=' + fmt(r.b?.spend ?? null) + ' imp=' + fmt(r.b?.impressions ?? null, 0) + ' reach=' + fmt(r.b?.reach ?? null, 0) + ' clicks=' + fmt(r.b?.clicks ?? null, 0));
  console.log('   live AM window     : spend=' + fmt(r.b2?.spend ?? null) + '  → app-AM-window vs this drift=' + (r.dAppAmVsLive == null ? '—' : r.dAppAmVsLive.toFixed(2) + '%'));
  console.log('   live ad-level sum  : spend=' + fmt(r.c?.spend ?? null) + ' (' + (r.c?.rows ?? 0) + ' daily ad rows)');
  console.log('   drifts             : app(N-6..N) vs live(N-6..N)=' + (r.dAppVsLive == null ? '—' : r.dAppVsLive.toFixed(2) + '%')
    + ' · live-acct vs ad-sum=' + (r.dLiveVsAdSum == null ? '—' : r.dLiveVsAdSum.toFixed(2) + '%')
    + ' · app(N-7..N-1) vs live(N-7..N-1)=' + (r.dAppAmVsLive == null ? '—' : r.dAppAmVsLive.toFixed(2) + '%'));
  if (r.liveErr) console.log('   LIVE ERROR           : ' + r.liveErr);
  if (!L.live) console.log('   (live fetch off — start with XACQORA_LIVE=1 env to fill the (b)/(c) columns)');
  // per-account notes
  if (String(r.acc.currency || '').toUpperCase() === 'AED') {
    console.log('   NOTE [AED]           : account bills in AED. App stores spend as-is and spend_inr = spend × fx_rate(date,\'INR\') (='
      + (fx.find((x) => x.currency === 'INR')?.inr_per_unit ?? '?') + ') → the "INR" column is actually the AED number, and spend_daily.currency is hardcoded \'INR\'. KPIs labelled ₹ are wrong for this account until an AED→INR rate is in fx_rate.');
  }
  if ((r.app7?.spend ?? 0) < 1 && alltime < 1) console.log('   NOTE [near-zero]     : all-time spend ' + fmt(alltime) + ' over ' + (r.alltime?.n || 0) + ' rows — INACTIVE account, not a pull issue.');
  else if (r.acc.last_error) console.log('   NOTE [pull error]      : last_error = ' + r.acc.last_error);
}

// ---------------------------------------------------------------- window / timezone analysis (task §1.6)
console.log('');
console.log('WINDOW / TIMEZONE ANALYSIS');
console.log('  · app "7d" = ' + W7_FROM + ' → ' + TODAY + ': the DASHBOARD INCLUDES TODAY, and today\'s Meta spend is T+1-mutable (still accruing at pull time; it changes until end of day, then Meta re-attributes a slice).');
console.log('  · Ads Manager "last 7 days" = ' + AM_FROM + ' → ' + AM_TO + ': 7 COMPLETE days, today EXCLUDED. That is the number an operator sees in Ads Manager.');
console.log('  · "today" is computed in the APP\'s UTC calendar day (Date.now().toISOString()); Meta daily rows are in the ACCOUNT\'s timezone (IST for these). Between 00:00–05:30 IST the two "today"s differ by one day.');
console.log('  · drift app↔live over the SAME window isolates staleness; drift app(N-7..N-1)↔live(N-7..N-1) isolates the window/label problem; drift live-acct↔ad-sum isolates Meta\'s own aggregation gap.');
})().catch((e) => { console.error('spend-diagnose failed:', e); process.exit(1); });
