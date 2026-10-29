// End-to-end replay test: fresh DB -> seed -> POST each sample payload
// through the ingest API -> tick the queue -> assert leads / events / deals.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const DB = path.join(__dirname, '..', 'xacqora-test.sqlite3');
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }

process.env.PORT = '4177';
process.env.XACQORA_DB_FILE = DB;

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

  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(DB);
  const count = (sql, ...a) => (db.prepare(sql).get(...a)?.c || 0);
  const checks = [
    ['meta lead created (phone +919812345678)', `SELECT COUNT(*) c FROM lead WHERE phone='+919812345678'`, 1],
    ['meta_form_lead event', `SELECT COUNT(*) c FROM event WHERE type='meta_form_lead'`, 1],
    ['razorpay deal row (txn pay_NX9abcDEF)', `SELECT COUNT(*) c FROM deal WHERE gateway_txn_id='pay_NX9abcDEF'`, 1],
    ['aevent webinar_joined', `SELECT COUNT(*) c FROM event WHERE type='webinar_joined' AND source_platform='aevent'`, 1],
    ['calendly call_booked on client 2', `SELECT COUNT(*) c FROM event WHERE type='call_booked' AND source_platform='calendly'`, 1],
    ['whatsapp_replied', `SELECT COUNT(*) c FROM event WHERE type='whatsapp_replied'`, 1],
    ['stages auto-moved (Paid exists)', `SELECT COUNT(*) c FROM lead WHERE stage='Paid'`, 1],
    ['CAPI log rows (dry-run)', `SELECT COUNT(*) c FROM capi_log`, 1],
    ['webhook logs processed', `SELECT COUNT(*) c FROM webhook_log WHERE status IN ('processed','queued','test')`, 5],
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
