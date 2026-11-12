// End-to-end replay test: fresh DB -> seed -> POST each sample payload
// through the ingest API -> tick the queue -> assert leads / events / deals.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Engine-aware (Phase P): Postgres when DATABASE_URL is set, else a throwaway
// SQLite file. On Postgres a throwaway scratch database is used so the strict
// counts run against a clean schema (the app role has CREATEDB for this).
const DB = path.join(__dirname, '..', 'xacqora-test.sqlite3');
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }

process.env.PORT = '4177';

function pgTestDb() {
  const { execSync } = require('node:child_process');
  const m = /^postgres(?:ql)?:\/\/([^:]+)(?::([^@]*))?@([^:]+):(\d+)\/(.+)$/.exec(process.env.DATABASE_URL);
  const env = { ...process.env };
  if (m) { env.PGUSER = m[1]; env.PGHOST = m[3]; env.PGPORT = m[4]; env.PGDATABASE = 'postgres'; if (m[2] != null) env.PGPASSWORD = m[2]; }
  const iso = 'xacqora_test';
  // force-drop so a stale prior test run (still holding the db open, or owned
  // by the dropped role) cannot block recreation
  try { execSync(`psql -h ${m[3]} -p ${m[4]} -U ${m[1]} -d postgres -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${iso}' AND pid<>pg_backend_pid();" >/dev/null 2>&1`, { env }); } catch { /* ignore */ }
  try { execSync(`psql -h ${m[3]} -p ${m[4]} -U ${m[1]} -d ${iso} -Atc "DROP OWNED BY ${m[1]};" >/dev/null 2>&1`, { env }); } catch { /* ignore */ }
  try { execSync(`dropdb -h ${m[3]} -p ${m[4]} -U ${m[1]} --force --if-exists ${iso} >/dev/null 2>&1`, { env }); } catch { /* ignore */ }
  execSync(`createdb -h ${m[3]} -p ${m[4]} -U ${m[1]} ${iso}`, { env });
  return `postgres://${m[1]}${m[2] != null ? ':' + m[2] : ''}@${m[3]}:${m[4]}/${iso}`;
}

if (process.env.DATABASE_URL) {
  process.env.DATABASE_URL = pgTestDb();
  // The server's daily-backup ticker runs pg_dump; under FORCE RLS that must
  // run as the superuser backup role (superusers bypass RLS) or Postgres
  // refuses the export. Default it so the spawned server's ticker is clean.
  process.env.PG_BACKUP_USER = process.env.PG_BACKUP_USER || 'xacq_backup';
} else {
  process.env.XACQORA_DB_FILE = DB;
}

function startServer() {
  const child = require('node:child_process').spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.env.QUIET ? 0 : process.stdout.write('[server] ' + d));
  child.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d));
  return child;
}

function post(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: 'localhost', port: 4177, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
    (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}
function get(pathname) {
  return new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port: 4177, path: pathname }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    }).on('error', reject);
  });
}

(async () => {
  const server = startServer();
  await new Promise((r) => setTimeout(r, 1200));
  try {
    execSync(`node ${JSON.stringify(path.join(__dirname, '..', 'scripts', 'seed.js'))}`, { env: { ...process.env }, stdio: 'pipe' });
  } catch { /* seed is idempotent */ }

  // give the ticker a beat, then post samples
  const samples = [
    ['meta_leadgen', 'meta_leadgen.json', { client_id: 1 }],
    ['razorpay', 'razorpay.json', { client_id: 1 }],
    ['aevent', 'aevent.json', { client_id: 1 }],
    ['calendly', 'calendly.json', { client_id: 2 }],
    ['whatsapp', 'whatsapp.json', { client_id: 1 }],
    // v14: FlexiFunnels form submit -> form_submit lead event (no secret row
    // seeded for this platform, so no ?secret= needed — same as the razorpay
    // dupe below; token-URL auth is covered by test/webhook-keys.js + sweep)
    ['flexifunnels', 'flexifunnels.json', { client_id: 1 }],
  ];
  let failed = 0;
  for (const [platform, file, extra] of samples) {
    const payload = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-samples', file), 'utf8'));
    const body = { ...payload, ...extra };
    // configured endpoints require their secret; pass it in the query
    const r = await post('/api/ingest/' + platform + '?secret=sec-' + platform, body);
    const ok = r.status === 200 && r.json && r.json.ok;
    if (!ok) failed++;
    console.log((ok ? 'PASS' : 'FAIL') + '  POST /api/ingest/' + platform + ' -> ' + r.status + ' ' + JSON.stringify(r.json));
  }
  // two ticker cycles: webhook jobs first, then the CAPI jobs they enqueue (ticker = 5s)
  await new Promise((r) => setTimeout(r, 12000));

  // Engine-aware count reader: SQLite via node:sqlite; Postgres via dbq.js
  // (psql), which reads the DATABASE_URL the app process used.
  const count = (sql, ...a) => {
    if (process.env.DATABASE_URL) {
      const out = execSync(`node ${JSON.stringify(path.join(__dirname, '..', 'scripts', 'dbq.js'))} ${JSON.stringify(sql)}`,
        { stdio: 'pipe', env: { ...process.env } }).toString();
      return Number((out.split('\n').filter(Boolean).pop() || '0').trim());
    }
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(DB);
    return db.prepare(sql).get(...a)?.c || 0;
  };
  const checks = [
    ['meta lead created (phone +919812345678)', `SELECT COUNT(*) c FROM lead WHERE phone='+919812345678'`, 1],
    ['meta_form_lead event', `SELECT COUNT(*) c FROM event WHERE type='meta_form_lead'`, 1],
    ['razorpay deal row (txn pay_NX9abcDEF)', `SELECT COUNT(*) c FROM deal WHERE gateway_txn_id='pay_NX9abcDEF'`, 1],
    ['aevent webinar_joined', `SELECT COUNT(*) c FROM event WHERE type='webinar_joined' AND source_platform='aevent'`, 1],
    ['calendly call_booked on client 2', `SELECT COUNT(*) c FROM event WHERE type='call_booked' AND source_platform='calendly'`, 1],
    ['whatsapp_replied', `SELECT COUNT(*) c FROM event WHERE type='whatsapp_replied'`, 1],
    ['stages auto-moved (Paid exists)', `SELECT COUNT(*) c FROM lead WHERE stage='Paid'`, 1],
    ['CAPI log rows (dry-run)', `SELECT COUNT(*) c FROM capi_log`, 1],
    ['flexifunnels form_submit event (v14)', `SELECT COUNT(*) c FROM event WHERE source_platform='flexifunnels' AND type='form_submit'`, 1],
    ['flexifunnels lead + UTM touchpoint', `SELECT COUNT(*) c FROM lead l WHERE l.email='flexi.lead@example.com'`, 1],
    ['webhook logs processed', `SELECT COUNT(*) c FROM webhook_log WHERE status IN ('processed','queued','test')`, 6],
  ];
  let bad = 0;
  for (const [label, sql, min] of checks) {
    const c = count(sql);
    const ok = c >= min;
    if (!ok) bad++;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + ' (found ' + c + ', need >= ' + min + ')');
  }
  // dupe safety: post the razorpay payload twice; deal count must stay 1
  const raz = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-samples', 'razorpay.json'), 'utf8'));
  for (let i = 0; i < 2; i++) await post('/api/ingest/razorpay', { ...raz, client_id: 1 });
  await new Promise((r) => setTimeout(r, 6500));
  const dupe = count(`SELECT COUNT(*) c FROM deal WHERE gateway_txn_id='pay_NX9abcDEF'`);
  const dupeOk = dupe === 1;
  if (!dupeOk) bad++;
  console.log((dupeOk ? 'PASS' : 'FAIL') + `  duplicate razorpay payload ignored (deal rows = ${dupe}, expect 1)`);

  server.kill();
  console.log('\n' + (bad === 0 && failed === 0 ? 'ALL TESTS PASSED' : bad + ' assertion(s) failed'));
  process.exit(bad === 0 && failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error('replay test error:', e);
  process.exit(1);
});
