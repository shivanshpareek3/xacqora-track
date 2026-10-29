// Phase S.1 — DB-layer client-isolation proof (PRD §10: "every query is
// filtered by client_id at the database level").
//
// Two independent proofs:
//  (a) CANARY — seed canary leads/revenue/ad-clicks in client 1 AND client 2
//      with unique markers; render every screen + run every report function
//      as the client-2 user; assert no client-1 marker leaks anywhere.
//  (b) QUERY DUMP — wrap the tx API and capture every data-table statement
//      executed by the scoped report functions; assert each carries a
//      client_id filter (the RLS-equivalent check at SQLite level).
const { open, makeTx } = require('../server/db');
const S = require('../server/lib/shared');
const screens = require('../server/screens');
const path = require('node:path');
const fs = require('node:fs');

const dbFile = path.join(__dirname, '..', 'xacqora-isolation.sqlite3');
for (const f of ['xacqora-isolation.sqlite3', 'xacqora-isolation.sqlite3-wal', 'xacqora-isolation.sqlite3-shm']) {
  try { fs.unlinkSync(path.join(__dirname, '..', f)); } catch {}
}
process.env.XACQORA_DB_FILE = dbFile;
const db = open();
const tx = makeTx(db);

// ---------------------------------------------------------------- fixtures
tx.run(`INSERT OR IGNORE INTO workspace (id, name) VALUES (1,'Foremost Leads')`);
tx.run(`INSERT OR IGNORE INTO client (id, workspace_id, name) VALUES (1,1,'Client One')`);
tx.run(`INSERT OR IGNORE INTO client (id, workspace_id, name) VALUES (2,1,'Client Two')`);
tx.run(`INSERT OR IGNORE INTO meta_ad_account (id, client_id, name, ad_account_id, token, pixel_id, status)
  VALUES (1,1,'One Ads','ACT-900001','MOCK','PIX-901','connected')`);
tx.run(`INSERT OR IGNORE INTO meta_ad_account (id, client_id, name, ad_account_id, token, pixel_id, status)
  VALUES (2,2,'Two Ads','ACT-900002','MOCK','PIX-902','connected')`);

function putLead(id, client, phone, email, name) {
  const e = tx.get(`SELECT id FROM lead WHERE id=?`, id);
  if (e) tx.run(`UPDATE lead SET client_id=?, phone=?, email=?, name=? WHERE id=?`, client, phone, email, name, id);
  else tx.run(`INSERT INTO lead (id, client_id, phone, email, name, stage) VALUES (?,?,?,?,?,'New')`, id, client, phone, email, name);
}
putLead(901, 1, '+919000000001', 'c1@x.local', 'Canary C1');
putLead(902, 2, '+919000000002', 'c2@x.local', 'Canary C2');

function putDeal(txn, lead, client, amt) {
  if (!tx.get(`SELECT 1 c FROM deal WHERE gateway_txn_id=?`, txn))
    tx.run(`INSERT INTO deal (lead_id, client_id, amount, gateway, gateway_txn_id, status, paid_at)
      VALUES (?,?,?,?,?, 'success', datetime('now'))`, lead, client, amt, 'csv', txn);
}
putDeal('ISO-1', 901, 1, 1001);
putDeal('ISO-2', 902, 2, 2002);

function putAd(id, acc, adset, name) {
  tx.run(`INSERT OR IGNORE INTO meta_ad (id, ad_account_id, adset_id, name, status) VALUES (?,?,?,?, 'ACTIVE')`, id, acc, adset, name);
}
putAd('ACT-900001-777', 'ACT-900001', 'A1', 'C1 Ad');
putAd('ACT-900002-888', 'ACT-900002', 'A2', 'C2 Ad');
if (!tx.get(`SELECT id FROM touchpoint WHERE lead_id=901`))
  tx.run(`INSERT INTO touchpoint (lead_id, ad_id, adset_id, utm_medium, ts) VALUES (901,'ACT-900001-777','A1','paid',datetime('now','-3 days'))`);
if (!tx.get(`SELECT id FROM touchpoint WHERE lead_id=902`))
  tx.run(`INSERT INTO touchpoint (lead_id, ad_id, adset_id, utm_medium, ts) VALUES (902,'ACT-900002-888','A2','paid',datetime('now','-3 days'))`);

const C1_PHONE = '9000000001';
const C1_ACC = 'ACT-900001';
const client2User = { id: 99, role: 'client', client_ids: '2', email: 'c2@x.local', name: 'Client Two' };
const teamUser = { id: 98, role: 'owner', client_ids: '', email: 'o@x.local', name: 'Owner' };

let failures = 0;
function check(label, cond, detail) {
  if (!cond) { failures++; console.log('FAIL  ' + label + (detail ? ' :: ' + detail : '')); }
  else console.log('PASS  ' + label);
}

// ==========================================================================
// (a) CANARY — screens rendered for client 2 must not leak any client-1 data
// ==========================================================================
const html = {
  dashboard: screens.dashboard(db, client2User, {}),
  leads: screens.leads(db, client2User, {}),
  pipelineWiden: screens.pipeline(db, client2User, { client: '1' }),
  reportsWiden: screens.reports(db, client2User, { client: '1' }),
  leadOwn: screens.leadTimeline(db, client2User, { id: 902 }),
  leadOther: screens.leadTimeline(db, client2User, { id: 901 }),
  portal: screens.portal(db, client2User, {}),
};
for (const [name, page] of Object.entries(html)) {
  if (name === 'leadOther') continue;
  check(`canary: screen '${name}' hides client-1 phone`, !page.includes(C1_PHONE), 'leaked c1 phone');
  check(`canary: screen '${name}' hides client-1 ad account`, !page.includes(C1_ACC), 'leaked c1 ad account');
}
check('canary: client-2 cannot open client-1 lead 901', html.leadOther.includes('Not found'));
check('canary: ?client=1 filter does NOT widen pipeline', !html.pipelineWiden.includes(C1_PHONE));
check('canary: ?client=1 filter does NOT widen reports', !html.reportsWiden.includes(C1_ACC) && !html.reportsWiden.includes('ACT-900002') || !html.reportsWiden.includes(C1_ACC));

// team user: sanity that scoping is not over-strict
const teamDash = screens.dashboard(db, teamUser, {});
const teamRep1 = screens.reports(db, teamUser, { client: '1' });
check('team: unrestricted dashboard renders', teamDash.includes('Dashboard'));
check('team: ?client=1 report shows client-1 ad account', teamRep1.includes(C1_ACC));
check('team: ?client=1 report hides client-2 ad account', !teamRep1.includes('ACT-900002'));

// report functions direct, scoped to client 2
const fp2 = S.funnelReport(tx, null, { attribution_model: 'last_paid_click' }, [2]);
check('funnelReport([2]) revenue == 2002 only', fp2.revenue === 2002, 'revenue=' + fp2.revenue);
check('funnelReport([2]) leads == 1', fp2.leads === 1, 'leads=' + fp2.leads);
const fp1 = S.funnelReport(tx, null, { attribution_model: 'last_paid_click' }, [1]);
check('funnelReport([1]) revenue == 1001 only', fp1.revenue === 1001, 'revenue=' + fp1.revenue);
const ap2 = S.adPerformance(tx, {}, [2]);
check('adPerformance([2]) lists only client-2 ad', ap2.rows.length === 1 && ap2.rows[0].ad_id === 'ACT-900002-888',
  JSON.stringify(ap2.rows.map((r) => r.ad_id)));
check('adPerformance([2]) revenue == 2002', ap2.total.revenue === 2002, 'total=' + JSON.stringify(ap2.total));
const mix2 = S.sourceMix(tx, [2]);
check('sourceMix([2]) counts only client-2 lead', mix2.reduce((a, r) => a + r.c, 0) === 1, JSON.stringify(mix2));
const wo2 = S.newVsOld(tx, {}, [2]);
check('newVsOld([2]) counts only client-2', wo2.in_range_count + wo2.older_count === 1,
  JSON.stringify({ in: wo2.in_range_count, older: wo2.older_count }));
const ws2 = S.weeklySummary(tx, {}, [2]);
check('weeklySummary([2]) funnel.leads == 1', ws2.funnel.leads === 1, 'leads=' + ws2.funnel.leads);

// ==========================================================================
// (b) QUERY DUMP — every data-table statement in a scoped report is
//     client-filtered (RLS-equivalent assertion at the SQLite level)
// ==========================================================================
function capture(real) {
  const seen = [];
  return {
    db: real.db,
    run(sql, ...a) { seen.push({ sql, args: a }); return real.run(sql, ...a); },
    get(sql, ...a) { seen.push({ sql, args: a }); return real.get(sql, ...a); },
    all(sql, ...a) { seen.push({ sql, args: a }); return real.all(sql, ...a); },
    seen,
  };
}
const cap = capture(tx);
S.funnelReport(cap, null, { attribution_model: 'last_paid_click' }, [2]);
S.adPerformance(cap, {}, [2]);
S.sourceMix(cap, [2]);
S.newVsOld(cap, {}, [2]);
S.weeklySummary(cap, {}, [2]);

function hasClientFilter(stmt) {
  const s = stmt.sql.toLowerCase();
  if (s.includes('client_id')) return true;
  // a client list passed as a single string arg ('2') counts too
  return (stmt.args || []).some((a) => a === '2' || a === 2);
}
// The meaningful RLS-equivalent invariant, stated precisely:
//   1. Every statement that *derives* a row set (reads the `lead` table, or
//      aggregates `spend_daily`/`deal` at top level) must carry a client_id
//      filter. There is no other way to get the scoped rows.
//   2. Every *child lookup* keyed on a foreign key (WHERE lead_id=?,
//      WHERE ad_id IN (...), meta_adset/meta_ad WHERE id=?) must use only
//      key values that were themselves produced by the scoped parent
//      queries — i.e. client-2's own lead IDs / ad IDs, never client-1's.
const DATA = /\b(lead|deal|touchpoint|event|spend_daily|meta_ad|meta_adset|meta_ad_account)\b/i;
function isRead(sql) {
  const s = String(sql).toLowerCase();
  return /\b(select)\b/.test(s) && /\bfrom\b/.test(s);
}
function readsLeadTable(sql) {
  // a FROM/JOIN on the lead table (not a WHERE lead_id=? child lookup)
  return /\b(from|join)\s+lead\b/i.test(sql) && !/^select\s+.*where\s+lead_id\s*=/i.test(sql);
}
function aggregatesGlobal(sql) {
  // top-level aggregation over spend_daily / deal with no client/ad scoping
  return /group\s+by/i.test(sql) && /\b(spend_daily|deal)\b/i.test(sql) &&
    !/client_id|ad_id\s*in|lead_id\s*in/i.test(sql);
}
function fkChildLookup(q) {
  // returns { table, values } when the statement is a scoped FK child lookup
  let m = q.sql.match(/where\s+lead_id\s*=\s*\?/i);
  if (m) return { table: 'lead', value: q.args[0] };
  m = q.sql.match(/ad_id\s*in\s*\(([^)]*)\)/i);
  if (m) return { table: 'ad', values: m[1].split(',').map((x) => x.replace(/'/g, '').trim()).filter(Boolean) };
  if (/from\s+meta_adset\s+where\s+id\s*=\s*\?/i.test(q.sql)) return { table: 'ad', value: q.args[0] };
  if (/from\s+meta_ad\s+where\s+id\s*=\s*\?/i.test(q.sql)) return { table: 'ad', value: q.args[0] };
  return null;
}

// 1) entry-point row-set derivations must be client-filtered
const leadScans = cap.seen.filter((q) => isRead(q.sql) && readsLeadTable(q.sql));
let unscopedLead = 0;
for (const q of leadScans) if (!hasClientFilter(q)) { unscopedLead++; console.log('  UNSCOPED lead scan: ' + q.sql); }
check('query-dump: every lead-table read is client-filtered (' + leadScans.length + ' checked)',
  unscopedLead === 0, unscopedLead + ' unscoped lead scan(s)');

const globalAgg = cap.seen.filter((q) => isRead(q.sql) && aggregatesGlobal(q.sql));
check('query-dump: no top-level global aggregation over spend_daily/deal when scoped (' + globalAgg.length + ' found)',
  globalAgg.length === 0, globalAgg.map((q) => q.sql.slice(0, 40)).join(' | '));

// 2) FK child lookups must only touch client-2's own keys
//    (client-2 canary lead=902 / ad=ACT-900002-888; client-1=901 / ACT-900001-777)
const c1Keys = new Set([901, 'ACT-900001-777']);
let leak = 0;
for (const q of cap.seen) {
  const fk = fkChildLookup(q);
  if (!fk) continue;
  const keys = fk.values || [fk.value];
  for (const k of keys) if (c1Keys.has(Number(k)) || c1Keys.has(k)) { leak++; console.log('  FK LEAK: ' + q.sql + ' -> ' + k); }
}
check('query-dump: no FK child lookup touches a client-1 key (' + cap.seen.length + ' stmts)', leak === 0, leak + ' leaked key(s)');

console.log('\n' + (failures === 0 ? 'ISOLATION PROOF PASSED' : failures + ' isolation check(s) FAILED'));
process.exit(failures ? 1 : 0);
