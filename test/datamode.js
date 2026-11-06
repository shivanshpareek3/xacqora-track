// DATA_MODE test (Master v9 Task 2). Verifies on BOTH engines that:
//  1. mode resolution: settings.data_mode > env DATA_MODE > 'demo'
//  2. the admin toggle (setDataMode) writes/deletes the settings row and returns the value
//  3. demo mode: every predicate returns '' (byte-identical SQL, all rows visible)
//  4. live mode: the NOT-predicates hide ONLY the seed's explicit-convention rows
//     (leads 101-126, deals 1-10, ACT-… meta entities + spend, seed webhook refs)
//     and never touch auto-id real rows (leads/deals > seed range, act_… accounts)
//  5. metaAccountReport: live excludes ACT-… spend; demo includes it.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { open, makeTx } = require('../server/db');
const dm = require('../server/lib/datamode');
const S = require('../server/lib/shared');

// ---------------------------------------------------------------- scratch db (mirror test/metalive.js)
const isPG = !!process.env.DATABASE_URL;
if (isPG) {
  const m = /^postgres(?:ql)?:\/\/([^:]+)(?::([^@]*))?@([^:]+):(\d+)\/(.+)$/.exec(process.env.DATABASE_URL);
  const env = { ...process.env };
  env.PGUSER = m[1]; env.PGHOST = m[3]; env.PGPORT = m[4]; env.PGDATABASE = 'postgres';
  if (m[2] != null) env.PGPASSWORD = m[2];
  const scratch = (m[5] || 'xacqora') + '_datamode';
  for (const q of [
    `psql -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${scratch}' AND pid<>pg_backend_pid();"`,
    `psql -d ${scratch} -Atc "DROP OWNED BY ${m[1]};"`,
    `dropdb --force --if-exists ${scratch}`,
  ]) { try { execSync(q, { env }); } catch {} }
  execSync(`createdb ${scratch}`, { env });
  process.env.DATABASE_URL = `postgres://${m[1]}@${m[3]}:${m[4]}/${scratch}`;
} else {
  const f = path.join(__dirname, '..', 'xacqora-datamode.sqlite3');
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(f + s); } catch {} }
  process.env.XACQORA_DB_FILE = f;
  delete process.env.DATA_MODE; // deterministic: the env branch resolves from scratch
}

const db = open();
const tx = makeTx(db, null);

// ---- fixtures: one workspace + client, then seed-convention rows AND real rows
tx.run(`INSERT INTO workspace (id, name) VALUES (1, 'W') ON CONFLICT(id) DO NOTHING`);
tx.run(`INSERT INTO client (id, workspace_id, name) VALUES (1, 1, 'Pilot Client') ON CONFLICT(id) DO NOTHING`);
const lead = `INSERT INTO lead (id, client_id, phone, name, stage) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING`;
for (const id of [101, 126]) tx.run(lead, id, 1, `+91 900000${id}`, `Seed Lead ${id}`, 'Paid'); // seed demo
tx.run(lead, 300, 1, '+91 900000300', 'Real Pilot Lead', 'New');                                // real auto-id
const deal = `INSERT INTO deal (id, lead_id, client_id, amount, status, paid_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`;
for (const id of [1, 10]) tx.run(deal, id, 101, 1, 4999, 'success', '2026-11-01 10:00:00');    // seed demo
tx.run(deal, 50, 300, 1, 4999, 'success', '2026-11-02 10:00:00');                               // real
// v11: a second, DEMO client (id 2) whose account/leads/deals must all hide
// in live mode via client.demo=1, plus a real client (id 1 stays real).
tx.run(`INSERT INTO client (id, workspace_id, name) VALUES (2, 1, 'Demo Client') ON CONFLICT(id) DO NOTHING`);
tx.run(`UPDATE client SET demo=1 WHERE id=2`);
// v11: demo-client rows that must hide in live via client.demo=1, even though
// their ids/look real (a lowercase act_ account, an auto-id lead) — the
// seed-convention predicates above CANNOT catch them.
const PULL_AT = '2026-11-04T06:00:00.000Z';
tx.run(`INSERT INTO meta_ad_account (id, client_id, name, ad_account_id, currency, last_pull_at)
  VALUES (1, 1, 'Seed Coach', 'ACT-100001', 'INR', ?) ON CONFLICT(id) DO NOTHING`, PULL_AT);
tx.run(`INSERT INTO meta_ad_account (id, client_id, name, ad_account_id, currency, last_pull_at)
  VALUES (2, 1, 'Foremost', 'act_7001', 'INR', ?) ON CONFLICT(id) DO NOTHING`, PULL_AT);
tx.run(`INSERT INTO meta_ad_account (id, client_id, name, ad_account_id, currency, last_pull_at)
  VALUES (3, 2, 'Demo Client Act', 'act_9001', 'INR', ?) ON CONFLICT(id) DO NOTHING`, PULL_AT);
tx.run(`INSERT INTO meta_ad (id, ad_account_id, name, status) VALUES
  ('ACT-100001-1','ACT-100001','Seed Ad','ACTIVE'),
  ('act_7001-1','act_7001','Real Ad','ACTIVE'),
  ('act_9001-1','act_9001','Demo Client Ad','ACTIVE')
  ON CONFLICT(id) DO NOTHING`);
const sd = `INSERT INTO spend_daily (ad_id, date, ad_account_id, spend_inr, impressions, clicks)
  VALUES (?,?,?,?,?,?) ON CONFLICT(ad_id, date, ad_account_id) DO NOTHING`;
tx.run(sd, 'ACT-100001-1', '2026-11-01', 'ACT-100001', 5000, 100, 10); // demo spend
tx.run(sd, 'act_7001-1', '2026-11-01', 'act_7001', 9000, 200, 20);     // real spend
tx.run(sd, 'act_9001-1', '2026-11-01', 'act_9001', 3000, 50, 5);       // demo-client spend (hides via client.demo)
tx.run(lead, 301, 2, '+91 900000301', 'Demo Client Real-Id Lead', 'Paid'); // auto-id lead under demo client
tx.run(`INSERT INTO webhook_log (client_id, platform, ref, raw, test) VALUES
  (1, 'meta_leadgen', 'pay_seedfail', '{"seed":true}', 1),
  (1, 'razorpay', 'pay_REAL', '{"ok":true}', 0) ON CONFLICT DO NOTHING`);

// ---------------------------------------------------------------- 1. resolution order
// v11: unset settings + unset env -> LIVE (demo is opt-in only, never the
// default). env=demo is the only way to get demo without a settings row.
assert.strictEqual(dm.mode(tx), dm.LIVE, 'no settings + no env -> live (v11 default)');
delete process.env.DATA_MODE;
process.env.DATA_MODE = 'live';
assert.strictEqual(dm.mode(tx), dm.LIVE, 'env DATA_MODE=live -> live');
delete process.env.DATA_MODE;
process.env.DATA_MODE = 'demo';
assert.strictEqual(dm.mode(tx), dm.DEMO, 'env DATA_MODE=demo -> demo (opt-in)');
delete process.env.DATA_MODE;

// ---------------------------------------------------------------- 2. admin toggle
assert.strictEqual(dm.setDataMode(tx, 'live'), 'live');
assert.strictEqual(tx.get(`SELECT value FROM settings WHERE key='data_mode'`).value, 'live'); // row upserted
assert.strictEqual(dm.mode(tx), dm.LIVE, 'settings.data_mode beats env/absent');
assert.strictEqual(dm.setDataMode(tx, 'default'), 'default');
// v11: "default" deletes the settings row so the env value (here: none set)
// wins; with no env the app is live-only by default.
assert.strictEqual(dm.mode(tx), dm.LIVE, 'default deletes the row -> env/default live');
assert.strictEqual(dm.setDataMode(tx, 'bogus'), 'invalid');
// an explicit settings=demo still forces demo even though live is the default
assert.strictEqual(dm.setDataMode(tx, 'demo'), 'demo');
assert.strictEqual(dm.mode(tx), dm.DEMO, 'settings.data_mode=demo forces demo');
dm.setDataMode(tx, 'default'); // back to the v11 live default for the KPI checks below

// ---------------------------------------------------------------- 3. demo mode = all predicates empty
assert.strictEqual(dm.leadNotDemo(dm.DEMO), '');
assert.strictEqual(dm.dealNotDemo(dm.DEMO), '');
assert.strictEqual(dm.spendNotDemo(dm.DEMO, 's'), '');
assert.strictEqual(dm.metaNotDemo(dm.DEMO, ''), '');
assert.strictEqual(dm.webhookNotDemo(dm.DEMO, ''), '');
assert.strictEqual(dm.liveLeadEx(false), '', 'live wrapper: demo -> no clause');

// ---------------------------------------------------------------- 4. live predicates hide only seed rows
// seed predicates alone see the demo-client rows as REAL (auto-id leads,
// lowercase act_ accounts) — that is the gap client.demo=1 is meant to
// close, so each seed-only count below includes the demo-client rows.
assert.strictEqual(
  tx.get(`SELECT COUNT(*) c FROM lead l WHERE ${dm.leadNotDemo(dm.LIVE, 'l')}`).c,
  2, 'seed lead predicate keeps 300 (real) + 301 (demo-client, auto-id)');
assert.strictEqual(
  tx.get(`SELECT COUNT(*) c FROM deal d WHERE ${dm.dealNotDemo(dm.LIVE, 'd')}`).c,
  1, 'live hides seed deals 1/10, keeps real deal 50');
// seed predicates alone see the demo-client rows as REAL (lowercase act_ ids,
// auto-id leads) — that is the gap client.demo=1 is meant to close.
assert.strictEqual(
  tx.get(`SELECT COUNT(*) c FROM spend_daily s WHERE ${dm.spendNotDemo(dm.LIVE, 's')}`).c,
  2, 'seed spend predicate keeps BOTH act_ rows incl. demo client act_9001');
assert.strictEqual(
  tx.get(`SELECT COUNT(*) c FROM meta_ad a WHERE ${dm.metaNotDemo(dm.LIVE, 'a')}`).c,
  2, 'seed meta predicate keeps both act_ ads incl. demo client ad');
// v11 client-level hiding: the demo client's rows vanish on top of the seed
// predicates, via the client.demo=1 flag (never via id ranges or act_ look).
assert.strictEqual(
  tx.get(`SELECT COUNT(*) c FROM meta_ad_account ma WHERE ${dm.metaNotDemo(dm.LIVE, 'ma')} AND ${dm.clientNotDemo(dm.LIVE, 'ma')}`)
    .c,
  1, 'live switcher accounts: only client-1 act_ account (demo client act_9001 + ACT- gone)');
assert.strictEqual(
  tx.get(`SELECT COUNT(*) c FROM spend_daily s WHERE ${dm.spendNotDemo(dm.LIVE, 's')} AND ${dm.spendClientNotDemo(dm.LIVE, 's')}`).c,
  1, 'live spend: demo-client act_9001 spend hidden by client.demo, act_7001 kept');
assert.strictEqual(
  tx.get(`SELECT COUNT(*) c FROM lead l WHERE ${dm.leadNotDemo(dm.LIVE, 'l')} AND ${dm.clientNotDemo(dm.LIVE, 'l')}`).c,
  1, 'live leads: demo-client lead 301 hidden by client.demo, real lead 300 kept');
assert.deepStrictEqual(
  dm.realClientIds(tx, dm.LIVE, null),
  [1], 'live realClientIds: demo client 2 filtered out');
assert.deepStrictEqual(
  dm.realClientIds(tx, dm.DEMO, null),
  [1, 2], 'demo realClientIds: every in-scope client incl. demo');
assert.deepStrictEqual(
  dm.realClientIds(tx, dm.LIVE, [1, 2]),
  [1], 'live realClientIds honours the caller baseScope');
assert.strictEqual(
  tx.get(`SELECT COUNT(*) c FROM webhook_log w WHERE ${dm.webhookNotDemo(dm.LIVE, 'w')}`).c,
  1, 'live hides seed webhook rows (ref/raw/test), keeps real');
// empty alias must produce valid bare-column SQL (the integrations + health call sites)
assert.strictEqual(tx.get(`SELECT COUNT(*) c FROM webhook_log WHERE ${dm.webhookNotDemo(dm.LIVE, '')}`).c, 1);
// real lead (300) must SURVIVE the live lead predicate even though it is a >seed-range auto-id
assert.strictEqual(tx.get(`SELECT id FROM lead l WHERE l.id=300 AND ${dm.leadNotDemo(dm.LIVE, 'l')}`).id, 300);

// ---------------------------------------------------------------- 5. metaAccountReport aggregation
dm.setDataMode(tx, 'live');
const liveReport = S.metaAccountReport(tx, { adAccount: '', clientIds: [1], dataMode: dm.LIVE });
assert.strictEqual(liveReport.kpis.d30.spend_inr, 9000, `live KPI spend_inr excludes demo ACT- spend (got ${liveReport.kpis.d30.spend_inr})`);
assert.ok(!liveReport.topAds.some((a) => String(a.ad_id).startsWith('ACT-')), 'no ACT- ad in live topAds');
dm.setDataMode(tx, 'default');
const demoReport = S.metaAccountReport(tx, { adAccount: '', clientIds: [1], dataMode: dm.DEMO });
assert.strictEqual(demoReport.kpis.d30.spend_inr, 14000, 'demo KPI spend_inr = demo + real (5000+9000)');
assert.ok(demoReport.topAds.some((a) => String(a.ad_id).startsWith('ACT-')), 'demo topAds includes ACT- ad');

// ---------------------------------------------------------------- done
if (db.close) db.close();
console.log((isPG ? 'PG' : 'SQLite') + `  datamode: PASS (resolution, toggle, demo empty-predicates, live seed-only exclusion, KPI aggregation)`);
