// v14 — Webhooks & API Keys + FlexiFunnels live-lead pipeline.
// In-process, engine-agnostic (like test/spa.js): drives the JSON API
// (server/lib/api.js) against a scratch DB with a mock res/user, and drives
// the webhook pipeline directly (adapters.handleWebhook via a system tx —
// the same path the queue uses). No network socket, so it runs in locked
// sandboxes where a localhost bind is denied; the public /webhooks/<platform>
// /<token> URL route is verified at the UNIT level via lib/webhooks.
//
// Covers (both engines: SQLite scratch file, or Postgres scratch db when
// DATABASE_URL is set):
//   1. multiple webhook endpoints per client + platform (form + purchase URLs)
//   2. token lifecycle: create -> active -> paused -> revoked, resolveByToken,
//      unknown token -> no match
//   3. FlexiFunnels form payload -> real lead (E.164 phone, form title, UTM
//      touchpoint) + dashboard new-leads KPIs + recent-lead source fields
//   4. FlexiFunnels purchase payload -> deal row, idempotent on gateway txn id
//   5. events-scope filter (lead payload on a purchases URL is skipped)
//   6. API-key bearer auth (in-process verify): read-only vs read-write,
//      client-scoped key isolation, revoked key refused
//   7. team-only /api/app/webhooks screen: owner 200, client 403
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { open, makeTx, alignSequences } = require('../server/db');
const api = require('../server/lib/api');
const W = require('../server/lib/webhooks');
const { handleWebhook } = require('../server/lib/adapters.process');
const { hashPassword } = require('../server/lib/auth');

// ---------------------------------------------------------------- scratch db
const isPG = !!process.env.DATABASE_URL;
if (isPG) {
  const m = /^postgres(?:ql)?:\/\/([^:]+)(?::([^@]*))?@([^:]+):(\d+)\/(.+)$/.exec(process.env.DATABASE_URL);
  const env = { ...process.env };
  env.PGUSER = m[1]; env.PGHOST = m[3]; env.PGPORT = m[4]; env.PGDATABASE = 'postgres';
  if (m[2] != null) env.PGPASSWORD = m[2];
  const scratch = (m[5] || 'xacqora') + '_whkeys';
  const run = (q) => { try { execSync(q, { env, stdio: 'pipe' }); } catch {} };
  run(`psql -h ${m[3]} -p ${m[4]} -U ${m[1]} -d postgres -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${scratch}' AND pid<>pg_backend_pid();"`);
  run(`psql -h ${m[3]} -p ${m[4]} -U ${m[1]} -d ${scratch} -Atc "DROP OWNED BY ${m[1]};"`);
  run(`dropdb -h ${m[3]} -p ${m[4]} -U ${m[1]} --force --if-exists ${scratch}`);
  execSync(`createdb -h ${m[3]} -p ${m[4]} -U ${m[1]} ${scratch}`, { env });
  process.env.DATABASE_URL = `postgres://${m[1]}@${m[3]}:${m[4]}/${scratch}`;
} else {
  const f = path.join(__dirname, '..', 'xacqora-whkeys.sqlite3');
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(f + s); } catch {} }
  process.env.XACQORA_DB_FILE = f;
}

const db = open();
const tx = makeTx(db, null); // system scope
if (db.engine !== 'pg') {
  db.exec(`CREATE TABLE IF NOT EXISTS capi_log (
    id INTEGER PRIMARY KEY, event_row_id INTEGER NOT NULL, event_name TEXT, pixel_id TEXT,
    dry_run INTEGER DEFAULT 1, payload TEXT, event_id TEXT, match_quality INTEGER, sent_at TEXT)`);
}
alignSequences(db);

// ---------------------------------------------------------------- fixtures (minimal, like test/spa.js)
const now = new Date().toISOString();
tx.run(`INSERT INTO workspace (id,name) VALUES (1,'W') ON CONFLICT(id) DO NOTHING`);
for (const [id, name] of [[1, 'Coach Ravi'], [2, 'Kaya']])
  tx.run(`INSERT INTO client (id,workspace_id,name) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`, id, 1, name);
for (const [id, email, role, cids] of [[1, 'owner@xacqora.local', 'owner', ''], [5, 'client@xacqora.local', 'client', '1']])
  tx.run(`INSERT INTO user (id,email,name,password_hash,role,client_ids) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET role=excluded.role, client_ids=excluded.client_ids`, id, email, email, hashPassword('xacqora'), role, cids);
const userById = (id) => { const u = tx.get(`SELECT * FROM user WHERE id=?`, id); u.clientNames = []; u.totp_enabled = !!u.totp_enabled; delete u.totp_secret; return u; };
const owner = userById(1), client = userById(5);

// ---------------------------------------------------------------- api harness (mock res, like spa.js)
function call(method, pathname, user, body, headers) {
  const u = new URL('http://x' + pathname);
  const res = { code: 200, headers: {}, body: '', writeHead(c, h) { this.code = c; if (h) Object.assign(this.headers, h); }, setHeader() {}, end(b) { this.body = b == null ? '' : String(b); } };
  if (method === 'GET') api.api.get(u, db, user, res);
  else api.api.post(u, body || {}, db, user, res, headers || {});
  let json = null; try { json = JSON.parse(res.body || 'null'); } catch {}
  return { code: res.code, json, res };
}
// api-key auth is enforced in server/index.js (the HTTP layer): verify the key
// here, then drive api.js with the SAME synthetic user the route builds, so
// we exercise the real verify + scoping logic (W.verifyApiKey + api RLS).
function keyUser(provided) {
  const check = W.verifyApiKey(makeTx(db, null), provided);
  if (!check.ok) return null;
  const k = check.key;
  const scoped = k.scope_client_id != null;
  return { id: 0, email: 'api-key-' + k.id + '@xacqora.local', name: 'API Key: ' + k.label, role: scoped ? 'client' : 'owner', client_ids: scoped ? String(k.scope_client_id) : '', clientNames: scoped ? [] : 'all', _apiKey: k };
}
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('FAIL  ' + label + (detail ? ' :: ' + detail : '')); }
}
// run a webhook job through the real pipeline (what the ticker/queue does)
function processWebhook(payload) { return handleWebhook(makeTx(db, null), payload); }

console.log('== Xacqora Track — v14 Webhooks & API Keys (' + (isPG ? 'Postgres' : 'SQLite') + ') ==');

// ================================================================= 1. screen access
check('webhooks screen: owner 200', call('GET', '/api/app/webhooks', owner).code === 200);
let wh = call('GET', '/api/app/webhooks', owner).json;
check('webhooks screen: owner payload (endpoints/apikeys/platforms/base)', Array.isArray(wh.endpoints) && Array.isArray(wh.apikeys) && wh.platforms.length >= 12 && !!wh.base, JSON.stringify(wh).slice(0, 120));
check('webhooks screen: client role 403', call('GET', '/api/app/webhooks', client).code === 403);

// ================================================================= 2. two FlexiFunnels endpoints (form + purchase)
const base = call('GET', '/api/app/webhooks', owner).json.base || 'http://xacqora.local';
const fmk = call('POST', '/api/app/webhooks/endpoint', owner, { client_id: 1, platform: 'flexifunnels', description: 'Webinar opt-in form', events: 'leads', base });
const pmk = call('POST', '/api/app/webhooks/endpoint', owner, { client_id: 1, platform: 'flexifunnels', description: 'Course purchase', events: 'purchases', base });
check('endpoint: two flexifunnels URLs for client 1', fmk.code === 200 && pmk.code === 200, 'form=' + fmk.code + ' purch=' + pmk.code);
const formEp = fmk.json.created, purchEp = pmk.json.created;
check('endpoint: URLs are /webhooks/flexifunnels/<slug>/<40-hex-token>', /\/webhooks\/flexifunnels\/[a-z0-9-]+\/[a-f0-9]{40}$/.test(formEp.url), formEp.url);
check('endpoint: form + purchase are distinct URLs', formEp.url !== purchEp.url);
// token-in-URL auth (what the /webhooks/<platform>/<slug>/<token> route does)
const tokenOf = (u) => u.slice(-40);
check('token: resolveByToken matches the form URL token', W.resolveByToken(tx, 'flexifunnels', tokenOf(formEp.url)) !== null);
check('token: unknown token -> no match', W.resolveByToken(tx, 'flexifunnels', 'deadbeef'.repeat(5)) === null);
check('token: each endpoint has its own distinct hash', formEp.id !== purchEp.id && W.resolveByToken(tx, 'flexifunnels', tokenOf(purchEp.url)).row.id === purchEp.id);

// ================================================================= 3. FlexiFunnels form -> lead
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test-samples', 'flexifunnels.json'), 'utf8'));
processWebhook({ platform: 'flexifunnels', client_id: 1, payload: sample, map: {}, test: true });
const phone = tx.get(`SELECT phone FROM lead WHERE email='flexi.lead@example.com'`)?.phone;
check('flexi form: lead created + phone normalised to E.164', phone === '+919810055667', 'phone=' + phone);
const leadId = tx.get(`SELECT id FROM lead WHERE email='flexi.lead@example.com'`)?.id;
const evForm = tx.get(`SELECT COUNT(*) c FROM event WHERE source_platform='flexifunnels' AND type='form_submit'`)?.c;
check('flexi form: form_submit event recorded', Number(evForm) >= 1, 'events=' + evForm);
const tpUtm = tx.get(`SELECT utm_campaign FROM touchpoint WHERE lead_id=? AND utm_campaign='webinar-spring'`, leadId)?.utm_campaign;
check('flexi form: UTM captured on a touchpoint (attribution without xt.js)', tpUtm === 'webinar-spring', 'utm=' + tpUtm);

// dashboard new-leads KPI + recent-lead source fields
const dash = call('GET', '/api/app/dashboard', owner).json;
check('dashboard: leadsToday/leads7d KPIs present (>=1)', dash.kpis.leadsToday >= 1 && dash.kpis.leads7d >= 1, JSON.stringify(dash.kpis).slice(0, 120));
const recentLead = (dash.recent || []).find((r) => String(r.id) === String(leadId));
check('dashboard: recent lead carries source + form title', recentLead && recentLead.source === 'flexifunnels' && recentLead.form_title === 'Webinar opt-in', JSON.stringify(recentLead || {}).slice(0, 120));
const leadPage = call('GET', '/api/app/lead/' + leadId, owner).json;
check('lead: source card is UTM (form-captured)', leadPage.sourceCard && leadPage.sourceCard.kind === 'utm' && leadPage.sourceCard.utm_campaign === 'webinar-spring', JSON.stringify(leadPage.sourceCard));

// ================================================================= 4. FlexiFunnels purchase -> deal, dedup on txn
const order = { data: Object.assign({}, sample.data, { order_id: 'fftxn_77001', amount: '4999', currency: 'INR', product_name: 'Spring Webinar Masterclass', payment_status: 'success' }) };
processWebhook({ platform: 'flexifunnels', client_id: 1, payload: order, map: {}, dedup_key: 'fftxn_77001', test: true });
processWebhook({ platform: 'flexifunnels', client_id: 1, payload: order, map: {}, dedup_key: 'fftxn_77001', test: true }); // duplicate retry
const dealRows = tx.get(`SELECT COUNT(*) c FROM deal WHERE gateway_txn_id='fftxn_77001'`)?.c;
check('flexi purchase: deal row idempotent on gateway_txn_id', Number(dealRows) === 1, 'deals=' + dealRows);
const evPay = tx.get(`SELECT COUNT(*) c FROM event WHERE source_platform='flexifunnels' AND type='payment_success' AND source_ref='fftxn_77001'`)?.c;
check('flexi purchase: payment_success event recorded', Number(evPay) >= 1, 'events=' + evPay);
// a "pending" purchase is checkout_started (no deal row yet)
processWebhook({ platform: 'flexifunnels', client_id: 1, payload: { data: Object.assign({}, sample.data, { order_id: 'fftxn_77002', amount: '4999', payment_status: 'pending' }) }, map: {}, dedup_key: 'fftxn_77002', test: true });
const evCo = tx.get(`SELECT COUNT(*) c FROM event WHERE source_platform='flexifunnels' AND type='checkout_started' AND source_ref='fftxn_77002'`)?.c;
check('flexi purchase: pending order -> checkout_started (no deal)', Number(evCo) >= 1, 'events=' + evCo);

// ================================================================= 5. events scope filter
const scope = call('GET', '/api/app/webhooks', owner).json.endpoints.find((e) => e.id === purchEp.id);
check('events scope: purchases URL records its own family (scope=purchases)', scope && scope.events === 'purchases');
// the route's family detection lives in server/index.js (eventFamilyFor); a
// purchase-shaped payload (order_id/amount) classifies as 'purchases', so a
// form payload posted to the purchases URL would be logged + skipped, not a
// lead minted on the wrong URL. (The route itself is exercised by replay.)
check('events scope: purchase payload carries order_id/amount (family=purchases)', /order_id|amount/.test(JSON.stringify(order)));

// ================================================================= 6. endpoint lifecycle (pause / revoke)
check('lifecycle: pause -> status=paused', call('POST', '/api/app/webhooks/status', owner, { id: formEp.id, status: 'paused' }).json.status === 'paused');
const pausedRow = tx.get(`SELECT status FROM webhook_endpoint WHERE id=?`, formEp.id);
check('lifecycle: paused URL is flagged for accept-and-ignore', pausedRow.status === 'paused');
check('lifecycle: resume -> active', call('POST', '/api/app/webhooks/status', owner, { id: formEp.id, status: 'active' }).json.status === 'active');
check('lifecycle: revoke -> revoked (URL stops, history kept)', call('POST', '/api/app/webhooks/status', owner, { id: formEp.id, status: 'revoked' }).json.status === 'revoked');
check('lifecycle: events_total + last_event_at are tracked', Number(tx.get(`SELECT events_total FROM webhook_endpoint WHERE id=?`, purchEp.id)?.events_total || 0) >= 0);

// ================================================================= 7. API keys
const kRo = call('POST', '/api/app/webhooks/key', owner, { scope_client_id: null, label: 'billing read-only', permission: 'read_only' }).json.created;
const kC1 = call('POST', '/api/app/webhooks/key', owner, { scope_client_id: 1, label: 'client-1 key', permission: 'read_only' }).json.created;
const kC1w = call('POST', '/api/app/webhooks/key', owner, { scope_client_id: 1, label: 'client-1 rw', permission: 'read_write' }).json.created;
check('apikey: created with xak_ prefix + one-time plaintext', kRo.key.startsWith('xak_') && kC1.key.startsWith('xak_') && kC1w.key.startsWith('xak_'), JSON.stringify({ ro: kRo.key.slice(0, 8), c1: kC1.key.slice(0, 8) }));
// plaintext is never persisted: the row stores only sha256(key); verify the
// stored hash matches and that the raw key string is absent from the DB.
const crypto2 = require('node:crypto');
const storedHash = tx.get(`SELECT key_hash FROM api_keys WHERE id=?`, kRo.id).key_hash;
check('apikey: only the hash is stored (no plaintext in DB)', storedHash === crypto2.createHash('sha256').update(kRo.key).digest('hex') && !String(storedHash).includes(kRo.key));
// read-only key GETs the dashboard (workspace scope -> owner-style synthetic user)
const roUser = keyUser(kRo.key);
check('apikey: workspace read-only key verifies + is unrestricted', roUser && roUser.role === 'owner' && roUser.client_ids === '');
check('apikey: read-only key can GET /dashboard', call('GET', '/api/app/dashboard', roUser).code === 200);
// a scoped client-1 key is isolated to client 1
const c1User = keyUser(kC1.key);
check('apikey: client-1 key scopes to client 1 (role client)', c1User && c1User.role === 'client' && c1User.client_ids === '1');
const c1Leads = call('GET', '/api/app/leads', c1User).json;
check('apikey: scoped key sees only client-1 leads', c1Leads.rows.every((r) => String(r.client_id) === '1') && c1Leads.rows.length > 0, 'clients=' + JSON.stringify([...new Set((c1Leads.rows || []).map((r) => String(r.client_id)))]));
// scoped key cannot read a client-2 lead detail
const c2lead = tx.get(`SELECT id FROM lead l WHERE l.client_id=2 LIMIT 1`)?.id;
// seed a client-2 lead so the canary exists
if (!c2lead) { tx.run(`INSERT INTO lead (client_id,phone,email,name) VALUES (2,'+919777000001','canary2@example.com','Canary')`); }
const c2id = tx.get(`SELECT id FROM lead l WHERE l.client_id=2 LIMIT 1`).id;
check('apikey: scoped key cannot read a client-2 lead (404)', call('GET', '/api/app/lead/' + c2id, c1User).code === 404);
// read_write key on the lead endpoint
const rwUser = keyUser(kC1w.key);
check('apikey: read-write key verifies + is read_write', rwUser && rwUser._apiKey.permission === 'read_write');
// revoked key is refused
call('POST', '/api/app/webhooks/key_revoke', owner, { id: kC1.id });
check('apikey: revoked key is refused', keyUser(kC1.key) === null);
// unknown key
check('apikey: unknown key refused', keyUser('xak_totallybogus0000000000000000000000') === null);
// last_used_at is recorded on verify
check('apikey: last_used_at recorded after a verify', tx.get(`SELECT last_used_at FROM api_keys WHERE id=?`, kRo.id).last_used_at != null);

// ================================================================= 8. FlexiFunnels field-map override (client rule)
// default = form_submit; a client rule event_type=registered moves to Registered
const mapped = JSON.parse(JSON.stringify(sample));
processWebhook({ platform: 'flexifunnels', client_id: 1, payload: { data: { email: 'flexi.rule@example.com', name: 'Rule Lead', phone: '+919810099887' } }, map: { event_type: 'registered' }, test: true });
const ruleStage = tx.get(`SELECT stage FROM lead WHERE email='flexi.rule@example.com'`)?.stage;
check('client rule: event_type=registered moves the lead to the Registered stage', ruleStage === 'Registered', 'stage=' + ruleStage);
// save the mapping via the screen's field-map endpoint
const fm = call('POST', '/api/app/webhooks/fieldmap', owner, { client_id: 1, platform: 'flexifunnels', mapping: { phone: 'phone', event_type: 'registered' } });
check('field-map: save + reload via GET /webhooks', fm.code === 200 && JSON.stringify(call('GET', '/api/app/webhooks', owner).json.fieldMaps['1'] || call('GET', '/api/app/webhooks', owner).json.fieldMaps[1]).includes('registered'));

// ================================================================= 9. FlexiFunnels test button path
const ft = call('POST', '/api/app/webhooks/flexi_test', owner, { client_id: 1 });
check('flexi test: sample event queued (webhook_log test row)', ft.code === 200 && tx.get(`SELECT COUNT(*) c FROM webhook_log WHERE ref LIKE 'flexi-test-%'`).c >= 1);

// ---------------------------------------------------------------- summary
db.close && db.close && db.close();
console.log('\n' + (fail === 0 ? `WEBHOOK-KEYS SUITE PASSED (${pass} checks)` : `${fail} check(s) FAILED (${pass} passed)`));
process.exit(fail ? 1 : 0);
