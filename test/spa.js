// Phase F — JSON API + role-aware rendering contract test. Runs server/lib/api.js
// against a scratch DB (SQLite default; Postgres when DATABASE_URL is set) and
// asserts, for each role:
//   * correct HTTP status (200 team/client, 403 team-only screens for client)
//   * phone/email masking (S.roleSeesFullContacts semantics: only owner/admin/
//     sales_rep see full contacts; media_buyer/viewer/client are masked)
//   * client-scoping (client role sees ONLY its own client; never client-2 data)
// This is the headless, engine-agnostic proof that the SPA's data layer
// (public/app/app.js consumes /api/app/*) renders role-aware + isolated.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { open, makeTx, alignSequences } = require('../server/db');
const api = require('../server/lib/api');
const { hashPassword } = require('../server/lib/auth');
const S = require('../server/lib/shared');

// ---------------------------------------------------------------- scratch db
const isPG = !!process.env.DATABASE_URL;
if (isPG) {
  const m = /^postgres(?:ql)?:\/\/([^:]+)(?::([^@]*))?@([^:]+):(\d+)\/(.+)$/.exec(process.env.DATABASE_URL);
  const env = { ...process.env };
  env.PGUSER = m[1]; env.PGHOST = m[3]; env.PGPORT = m[4]; env.PGDATABASE = 'postgres';
  if (m[2] != null) env.PGPASSWORD = m[2];
  const scratch = (m[5] || 'xacqora') + '_spapi';
  const run = (q) => { try { execSync(q, { env, stdio: 'pipe' }); } catch {} };
  run(`psql -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${scratch}' AND pid<>pg_backend_pid();"`);
  run(`psql -d ${scratch} -Atc "DROP OWNED BY ${m[1]};"`);
  run(`dropdb --force --if-exists ${scratch}`);
  run(`createdb ${scratch}`);
  process.env.DATABASE_URL = `postgres://${m[1]}@${m[3]}:${m[4]}/${scratch}`;
} else {
  const f = path.join(__dirname, '..', 'xacqora-spa.sqlite3');
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(f + s); } catch {} }
  process.env.XACQORA_DB_FILE = f;
}

const db = open();
const tx = makeTx(db, null);
// capi_log ships in schema.pg.sql; create lazily on SQLite (mirror index.js)
if (db.engine !== 'pg') {
  db.exec(`CREATE TABLE IF NOT EXISTS capi_log (
    id INTEGER PRIMARY KEY, event_row_id INTEGER NOT NULL, event_name TEXT, pixel_id TEXT,
    dry_run INTEGER DEFAULT 1, payload TEXT, event_id TEXT, match_quality INTEGER, sent_at TEXT)`);
}
alignSequences(db);

// ---------------------------------------------------------------- fixtures
const now = new Date().toISOString();
const day = (h) => new Date(Date.now() - h * 3600000).toISOString();
tx.run(`INSERT INTO workspace (id,name) VALUES (1,'W') ON CONFLICT(id) DO NOTHING`);
for (const [id, name] of [[1, 'Coach Ravi'], [2, 'Kaya']])
  tx.run(`INSERT INTO client (id,workspace_id,name,currency,timezone,offer_price) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name`, id, 1, name, 'INR', 'Asia/Kolkata', id === 1 ? 4999 : 9999);
for (const cid of [1, 2])
  tx.run(`INSERT INTO funnel (id,client_id,name,type) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING`, cid, cid, 'Main funnel', 'webinar');
for (const cid of [1, 2])
  for (const [i, st] of S.DEFAULT_STAGES.entries())
    tx.run(`INSERT INTO funnel_stage (funnel_id,name,sort_order) VALUES (?,?,?) ON CONFLICT(funnel_id,name) DO NOTHING`, cid, st, i);
// ad accounts + entities + spend (both clients) so Reports/Meta have data
for (const [accId, cid, acc] of [[1, 1, 'ACT-100001'], [2, 2, 'ACT-100002']]) {
  tx.run(`INSERT INTO meta_ad_account (id,client_id,name,ad_account_id,token,pixel_id,status,auto_pull,last_pull_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET last_pull_at=excluded.last_pull_at, last_error=NULL`,
    accId, cid, 'Acct ' + acc, acc, 'MOCK', 'PIXEL-' + (1000 + cid), 'connected', 1, now);
  for (const c of [101, 102])
    tx.run(`INSERT INTO meta_campaign (id,ad_account_id,name,status,object_type) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, acc + '-' + c, acc, c === 101 ? 'Webinar' : 'Workshop', 'ACTIVE', 'campaign');
  for (const n of [3001, 3002, 3003, 4001, 4002])
    tx.run(`INSERT INTO meta_ad (id,ad_account_id,adset_id,name,status,creative_img) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name`, acc + '-' + n, acc, acc + '-' + (n <= 3003 ? '111' : '121'), 'Ad ' + n, n === 4002 ? 'PAUSED' : 'ACTIVE', 'CR-' + n);
  for (let d = 13; d >= 0; d--) {
    const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    for (const n of [3001, 3002, 3003, 4001, 4002])
      tx.run(`INSERT INTO spend_daily (ad_id,date,ad_account_id,spend,spend_inr,impressions,reach,clicks,conversions,currency)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ad_id,date,ad_account_id) DO UPDATE SET spend_inr=excluded.spend_inr,clicks=excluded.clicks`,
        acc + '-' + n, date, acc, 500, 500, 5000, 3000, 100, 30, 'INR');
  }
}
// users (all pw=xacqora)
for (const [id, email, name, role, cids] of [
  [1, 'owner@xacqora.local', 'Owner', 'owner', ''],
  [2, 'arpit@xacqora.local', 'Arpit', 'media_buyer', ''],
  [3, 'rep@xacqora.local', 'Sales Rep', 'sales_rep', ''],
  [5, 'client@xacqora.local', 'Client', 'client', '1'],
])
  tx.run(`INSERT INTO user (id,email,name,password_hash,role,client_ids) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET role=excluded.role, client_ids=excluded.client_ids`, id, email, name, hashPassword('xacqora'), role, cids);
// leads: client 1 (full + masked-visible) + client 2 (isolation canary)
const LEADS = [
  [301, 1, '+919812300301', 'ravi.spatest@example.com', 'Ravi', 'Mumbai', 'Paid'],
  [302, 1, '+919812300302', 'meera.spatest@example.com', 'Meera', 'Delhi', 'Registered'],
  [303, 2, '+919777300303', 'karan.spatest@example.com', 'Karan', 'Pune', 'Paid'], // client-2 canary
];
for (const [id, cid, ph, em, nm, city, st] of LEADS)
  tx.run(`INSERT INTO lead (id,client_id,phone,email,name,city,stage) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, id, cid, ph, em, nm, city, st);
// deals + events + capi + audit + webhook log so the data screens are populated
tx.run(`INSERT INTO deal (id,lead_id,client_id,product,amount,gateway,gateway_txn_id,status,paid_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
  1, 301, 1, 'Offer', 4999, 'razorpay', 'SPATXN-1', 'success', day(4));
tx.run(`INSERT INTO event (id,lead_id,type,source_platform,value,ts) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, 1, 301, 'payment_success', 'razorpay', 4999, day(4));
tx.run(`INSERT INTO webhook_log (id,client_id,platform,ref,status,ingested_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, 1, 1, 'meta_leadgen', 'mfl-sp', 'processed', day(3));
tx.run(`INSERT INTO audit_log (id,user_email,action,entity,ts) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, 1, 'owner@xacqora.local', 'export.csv', 'leads', day(1));
for (const k of ['capi', 'attribution_model', 'attribution_window_days', 'wasted_spend_threshold'])
  tx.run(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO NOTHING`,
    k, k === 'wasted_spend_threshold' ? '5000' : k === 'attribution_window_days' ? '30' : k === 'attribution_model' ? 'last_paid_click' : 'dry');

// ---------------------------------------------------------------- helpers
function userById(id) {
  const u = tx.get(`SELECT * FROM user WHERE id=?`, id);
  const { totp_secret, ...safe } = u;
  safe.clientNames = [];
  safe.totp_enabled = !!u.totp_enabled;
  return safe;
}
function call(method, pathname, user, body) {
  const u = new URL('http://x' + pathname);
  const res = {
    code: 200, headers: {}, body: '',
    writeHead(c, h) { this.code = c; if (h) Object.assign(this.headers, h); },
    setHeader() {}, end(b) { this.body = b == null ? '' : String(b); },
  };
  if (method === 'GET') api.api.get(u, db, user, res);
  else api.api.post(u, body, db, user, res, {});
  let json = null; try { json = JSON.parse(res.body || 'null'); } catch {}
  return { code: res.code, json, res };
}
const FULL_PHONES = ['9812300301', '98222300302', '9777300303'];
let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('PASS  ' + label); }
  else { fail++; console.log('FAIL  ' + label + (detail ? ' :: ' + detail : '')); }
}
const body = (o) => JSON.stringify(o || {});
const FULL_EMAIL_RE = /ravi\.spatest@example\.com|meera\.spatest@example\.com|karan\.spatest@example\.com/;

// =====================================================================
console.log('== Xacqora Track — Phase F API + role-aware masking (' + (isPG ? 'Postgres' : 'SQLite') + ') ==');

const owner = userById(1), mb = userById(2), rep = userById(3), client = userById(5);

// ---- /me: role flags + nav
let r = call('GET', '/api/app/me', owner).json;
check('me: owner sees full contacts + teamOps + canAdmin', r.seesContacts === true && r.teamOps === true && r.canAdmin === true && !r.readOnly);
r = call('GET', '/api/app/me', client).json;
check('me: client role read-only, no full contacts', r.readOnly === true && r.seesContacts === false && r.canAdmin === false && r.teamOps === false);
r = call('GET', '/api/app/me', mb).json;
check('me: media_buyer teamOps + not full contacts (masked)', r.teamOps === true && r.seesContacts === false);
r = call('GET', '/api/app/me', rep).json;
check('me: sales_rep sees full contacts, no teamOps', r.seesContacts === true && r.teamOps === false);

// ---- auth: unauthenticated
check('auth: /leads without user -> 401', call('GET', '/api/app/leads', null).code === 401);

// ---- team-only screens: 403 for client
for (const ep of ['/api/app/meta', '/api/app/integrations', '/api/app/duplicates', '/api/app/admin', '/api/app/pilot', '/api/app/alerts'])
  check('403 client ' + ep, call('GET', ep, client).code === 403);
// media_buyer (teamOps) CAN open the teamOps screens
for (const ep of ['/api/app/meta', '/api/app/integrations', '/api/app/pilot', '/api/app/alerts'])
  check('200 media_buyer ' + ep, call('GET', ep, mb).code === 200);
// duplicates/admin are owner+admin only -> 403 for media_buyer
check('403 media_buyer /duplicates', call('GET', '/api/app/duplicates', mb).code === 403);
check('403 media_buyer /admin', call('GET', '/api/app/admin', mb).code === 403);

// ---- phone/email masking on /leads + /lead
const ownerLeads = call('GET', '/api/app/leads', owner).json;
check('leads: owner sees FULL phone digits', ownerLeads.rows.some((x) => String(x.phone).includes('9812300301')));
check('leads: owner sees FULL email', body(ownerLeads).match(FULL_EMAIL_RE));
const clientLeads = call('GET', '/api/app/leads', client).json;
check('leads: client role phone MASKED', clientLeads.rows.every((x) => x.phone === '' || /•/.test(x.phone)));
check('leads: client role email MASKED', clientLeads.rows.every((x) => !x.email || /•/.test(x.email)));
const mbLeads = call('GET', '/api/app/leads', mb).json;
check('leads: media_buyer phone MASKED (S.4)', mbLeads.rows.every((x) => x.phone === '' || /•/.test(x.phone)));
// single lead detail masks too
const clientLead = call('GET', '/api/app/lead/301', client).json;
check('lead detail: client role masked', /•/.test(String(clientLead.lead.phone)) && /•/.test(String(clientLead.lead.email)));
const ownerLead = call('GET', '/api/app/lead/301', owner).json;
check('lead detail: owner full', ownerLead.lead.phone === '+919812300301' && ownerLead.lead.email === 'ravi.spatest@example.com');

// ---- client isolation: client-1 (client role) must never see client-2 canary
const karanPhone = '+919777300303';
check('isolation: client-1 /leads has no client-2 canary', !body(clientLeads).includes('karan.spatest') && !body(clientLeads).includes('9777300303'));
check('isolation: client-1 /lead/303 -> 404', call('GET', '/api/app/lead/303', client).code === 404);
// owner unrestricted: sees the canary
check('owner /leads sees client-2 canary', call('GET', '/api/app/leads', owner).json.rows.some((x) => String(x.phone).includes('9777300303')));
// scoped pipeline/reports for client role -> client-1 only
check('isolation: client-1 /pipeline no client-2 canary', !body(call('GET', '/api/app/pipeline', client).json).includes('9777300303'));
check('isolation: client-1 /reports no client-2 account', !body(call('GET', '/api/app/reports', client).json).includes('ACT-100002'));

// ---- data screens return populated payloads (demo-populated: no empty on open)
const dash = call('GET', '/api/app/dashboard', owner).json;
check('dashboard: KPIs + funnel + sourceMix + spendTrend populated',
  dash.kpis.totalLeads >= 3 && dash.funnel.steps.leads >= 3 && dash.sourceMix.length > 0 && dash.spendTrend.length === 14 && dash.adPerf.rows.length > 0);
const rep1 = call('GET', '/api/app/reports', owner).json;
check('reports: adPerf + wasted + sourceMix + metaVsTrack populated',
  rep1.adPerf.rows.length > 0 && rep1.metaVsTrack && rep1.sourceMix.length > 0 && rep1.funnel.leads >= 3);
const meta = call('GET', '/api/app/meta', owner).json;
check('meta: accounts + spend + capi populated', meta.accounts.length > 0 && meta.spend.length > 0);
const integ = call('GET', '/api/app/integrations', owner).json;
check('integrations: platforms + log populated', integ.platforms.length >= 10 && integ.log.length > 0);
const adm = call('GET', '/api/app/admin', owner).json;
check('admin: users + audit populated', adm.users.length >= 4 && adm.audit.length >= 1);
const pil = call('GET', '/api/app/pilot', owner).json;
check('pilot: gates + allPass present', Array.isArray(pil.gates.gates) && typeof pil.allPass === 'boolean');
const alr = call('GET', '/api/app/alerts', owner).json;
check('alerts: 5 signals present', alr.alerts.webhook_failures !== undefined && alr.alerts.backup_not_recorded !== undefined && alr.db.queue);
// portal: client role auto-selects its own client (weekly + leads populated)
const portalC = call('GET', '/api/app/portal', client).json;
check('portal: client role weekly + leads populated', portalC.weekly && portalC.leads.length > 0 && portalC.cid === '1');
// owner with an explicit ?client= also gets a weekly
const portalO = call('GET', '/api/app/portal?client=1', owner).json;
check('portal: owner ?client=1 weekly + leads populated', portalO.weekly && portalO.leads.length > 0);
// owner with no client selected -> no weekly (correct per-client semantics)
check('portal: owner no-client -> weekly is null', call('GET', '/api/app/portal', owner).json.weekly === null);

// ---- a write path (stage move) is audit + RLS-gated
const before = tx.get(`SELECT stage FROM lead WHERE id=301`).stage;
const mv = call('POST', '/api/app/pipeline', rep, { id: 301, stage: 'Hot' });
check('write: sales_rep can move a lead stage', mv.code === 200 && mv.json.ok === true);
check('write: stage persisted', tx.get(`SELECT stage FROM lead WHERE id=301`).stage === 'Hot');
check('write: client role cannot move a lead (403)', call('POST', '/api/app/pipeline', client, { id: 301, stage: 'New' }).code === 403);
// restore
tx.run(`UPDATE lead SET stage=? WHERE id=301`, before);

console.log('\n== RESULT: ' + pass + ' passed, ' + fail + ' failed ==');
process.exit(fail ? 1 : 0);
