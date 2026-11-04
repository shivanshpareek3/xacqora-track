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
// meta entities: demo ACT- account + ad; real act_ account + ad
// last_pull_at: a fixed UTC string (datetime('now') is SQLite-only; keep it
// engine-agnostic — the value only matters that it is parseable as "recent").
const PULL_AT = '2026-11-04T06:00:00.000Z';
tx.run(`INSERT INTO meta_ad_account (id, client_id, name, ad_account_id, currency, last_pull_at)
  VALUES (1, 1, 'Seed Coach', 'ACT-100001', 'INR', ?) ON CONFLICT(id) DO NOTHING`, PULL_AT);
tx.run(`INSERT INTO meta_ad_account (id, client_id, name, ad_account_id, currency, last_pull_at)
  VALUES (2, 1, 'Foremost', 'act_7001', 'INR', ?) ON CONFLICT(id) DO NOTHING`, PULL_AT);
tx.run(`INSERT INTO meta_ad (id, ad_account_id, name, status) VALUES
  ('ACT-100001-1','ACT-100001','Seed Ad','ACTIVE'),
  ('act_7001-1','act_7001','Real Ad','ACTIVE')
  ON CONFLICT(id) DO NOTHING`);
const sd = `INSERT INTO spend_daily (ad_id, date, ad_account_id, spend_inr, impressions, clicks)
  VALUES (?,?,?,?,?,?) ON CONFLICT(ad_id, date, ad_account_id) DO NOTHING`;
tx.run(sd, 'ACT-100001-1', '2026-11-01', 'ACT-100001', 5000, 100, 10); // demo spend
tx.run(sd, 'act_7001-1', '2026-11-01', 'act_7001', 9000, 200, 20);     // real spend
tx.run(`INSERT INTO webhook_log (client_id, platform, ref, raw, test) VALUES
  (1, 'meta_leadgen', 'pay_seedfail', '{"seed":true}', 1),
  (1, 'razorpay', 'pay_REAL', '{"ok":true}', 0) ON CONFLICT DO NOTHING`);

// ---------------------------------------------------------------- 1. resolution order
assert.strictEqual(dm.mode(tx), dm.DEMO, 'no settings + no env -> demo');
delete process.env.DATA_MODE;
process.env.DATA_MODE = 'live';
assert.strictEqual(dm.mode(tx), dm.LIVE, 'env DATA_MODE=live -> live');
delete process.env.DATA_MODE;
process.env.DATA_MODE = 'demo';
assert.strictEqual(dm.mode(tx), dm.DEMO, 'env DATA_MODE=demo -> demo');
delete process.env.DATA_MODE;

// ---------------------------------------------------------------- 2. admin toggle
assert.strictEqual(dm.setDataMode(tx, 'live'), 'live');
assert.strictEqual(tx.get(`SELECT value FROM settings WHERE key='data_mode'`).value, 'live'); // row upserted
assert.strictEqual(dm.mode(tx), dm.LIVE, 'settings.data_mode beats env/absent');
assert.strictEqual(dm.setDataMode(tx, 'default'), 'default');
assert.strictEqual(dm.mode(tx), dm.DEMO, 'default deletes the row -> env/default demo');
assert.strictEqual(dm.setDataMode(tx, 'bogus'), 'invalid');

// ---------------------------------------------------------------- 3. demo mode = all predicates empty
assert.strictEqual(dm.leadNotDemo(dm.DEMO), '');
assert.strictEqual(dm.dealNotDemo(dm.DEMO), '');
assert.strictEqual(dm.spendNotDemo(dm.DEMO, 's'), '');
assert.strictEqual(dm.metaNotDemo(dm.DEMO, ''), '');
assert.strictEqual(dm.webhookNotDemo(dm.DEMO, ''), '');
assert.strictEqual(dm.liveLeadEx(false), '', 'live wrapper: demo -> no clause');

// ---------------------------------------------------------------- 4. live predicates hide only seed rows
assert.strictEqual(
  tx.get(`SELECT COUNT(*) c FROM lead l WHERE ${dm.leadNotDemo(dm.LIVE, 'l')}`).c,
  1, 'live hides seed leads 101/126, keeps real lead 300');
assert.strictEqual(
  tx.get(`SELECT COUNT(*) c FROM deal d WHERE ${dm.dealNotDemo(dm.LIVE, 'd')}`).c,
  1, 'live hides seed deals 1/10, keeps real deal 50');
assert.strictEqual(
  tx.get(`SELECT COUNT(*) c FROM spend_daily s WHERE ${dm.spendNotDemo(dm.LIVE, 's')}`).c,
  1, 'live hides ACT- spend, keeps act_ spend');
assert.strictEqual(
  tx.get(`SELECT COUNT(*) c FROM meta_ad a WHERE ${dm.metaNotDemo(dm.LIVE, 'a')}`).c,
  1, 'live hides ACT- meta entities, keeps act_');
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
