// Phase G — pilot gates tooling test. Exercises the four tool groups in
// server/lib/pilot.js against a fresh scratch DB on BOTH engines, plus the
// committed fixture samples/old-leads.csv (E.164 normalisation, duplicate
// skip, refund backfill) and the gate assertion suite on a pilot-mock dataset.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { open, makeTx, alignSequences } = require('../server/db');
const P = require('../server/lib/pilot');
const { ensureCapiLogTable } = require('../server/lib/meta');

// ---------------------------------------------------------------- engine
const isPG = process.env.DATABASE_URL ? true : false;
if (isPG) {
  const m = /^postgres(?:ql)?:\/\/([^:]+)(?::([^@]*))?@([^:]+):(\d+)\/(.+)$/.exec(process.env.DATABASE_URL);
  const env = { ...process.env };
  env.PGUSER = m[1]; env.PGHOST = m[3]; env.PGPORT = m[4]; env.PGDATABASE = 'postgres';
  if (m[2] != null) env.PGPASSWORD = m[2];
  const scratch = (m[5] || 'xacqora') + '_gates';
  for (const q of [
    `psql -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${scratch}' AND pid<>pg_backend_pid();"`,
    `psql -d ${scratch} -Atc "DROP OWNED BY ${m[1]};"`,
    `dropdb --force --if-exists ${scratch}`,
  ]) { try { execSync(q, { env }); } catch {} }
  execSync(`createdb ${scratch}`, { env });
  process.env.DATABASE_URL = `postgres://${m[1]}@${m[3]}:${m[4]}/${scratch}`;
} else {
  const f = path.join(__dirname, '..', 'xacqora-gates.sqlite3');
  for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(f + suf); } catch {} }
  process.env.XACQORA_DB_FILE = f;
}

const db = open();
const tx = makeTx(db, null);
ensureCapiLogTable(db);
alignSequences(db);
const now = new Date().toISOString();
const today = now.slice(0, 10);

// ---------------------------------------------------------------- fixtures
tx.run(`INSERT INTO workspace (id, name) VALUES (1, 'W') ON CONFLICT(id) DO NOTHING`);
tx.run(`INSERT INTO client (id, workspace_id, name) VALUES (1, 1, 'Pilot Client') ON CONFLICT(id) DO NOTHING`);

// ---- CSV import of old leads (the committed fixture) ----
const fixture = fs.readFileSync(path.join(__dirname, '..', 'samples', 'old-leads.csv'), 'utf8');
// Explicit column mapping (header -> Xacqora field), the pilot screen's shape.
const mapping = {
  'Full Name': 'name', 'Mobile': 'phone', 'Email': 'email', 'City': 'city',
  'Status': 'stage', 'Amount': 'amount', 'Registered': 'registered',
  'Attended': 'attended', 'Paid At': 'paid_at', 'Refund': 'refund',
};
const first = P.importOldLeads(tx, 1, { csv: fixture, mapping });
assert.strictEqual(first.imported, 6, 'all 6 fixture rows import as new leads (got ' + first.imported + ')');
assert.strictEqual(first.deals, 3, '3 deals backfilled (John, Ravi, Deepa-refund); got ' + first.deals);
// E.164 normalisation: "09811000003" -> "+919811000003", bare 10-digit -> +91…
const meera = tx.get(`SELECT id FROM lead WHERE phone=?`, '+919811000003');
assert.ok(meera, 'Meera normalised to +919811000003 (09811000003 form)');
const deepa = tx.get(`SELECT id FROM lead WHERE phone=?`, '+919844444445');
assert.ok(deepa, 'Deepa normalised to +919844444445 (bare 10-digit form)');
// the refund row creates a deal then marks it refunded (net revenue 0)
const deepaDeal = tx.get(`SELECT * FROM deal WHERE gateway='csv' AND lead_id=?`, deepa.id);
assert.ok(deepaDeal && deepaDeal.status === 'refunded' && deepaDeal.refunded_at, 'Deepa deal backfilled + refunded');
console.log('PASS csv import: 6 leads, E.164 normalisation, refund backfill');

// duplicate skip: re-import the same file -> nothing new, deals idempotent
const second = P.importOldLeads(tx, 1, { csv: fixture, mapping });
assert.strictEqual(second.imported, 0, 're-import adds 0 new leads');
assert.strictEqual(second.matched, 6, 're-import matches all 6 existing leads');
assert.strictEqual(second.deals, 0, 're-import adds no duplicate deals');
console.log('PASS csv import: duplicate skip + idempotent deals on re-import');

// inferred mapping (no explicit map) should auto-map the fixture header too
const inferred = P.importOldLeads(tx, 1, { csv: fixture });
assert.strictEqual(inferred.imported, 0, 'inferred mapping matches (no new leads)');
assert.strictEqual(inferred.matched, 6, 'inferred mapping matched all 6');
console.log('PASS csv import: header inference works without an explicit mapping');

// ---------------------------------------------------------------- ad URL checker
const goodUrl = 'https://client.com/thank-you?utm_source=facebook&{{ad.id}}={{ad.id}}&{{adset.id}}={{adset.id}}&{{campaign.id}}={{campaign.id}}&fbclid={{fbclid}}';
const g = P.checkAdUrl(goodUrl);
assert.strictEqual(g.ok, true, 'a fully-tokened URL passes');
assert.ok(g.findings.every((f) => f.present), 'every token/param reported present');
const badUrl = 'https://client.com/checkout?utm_source=google&utm_medium=cpc';
const b = P.checkAdUrl(badUrl);
assert.strictEqual(b.ok, false, 'a URL with no ad token fails');
assert.ok(b.findings.find((f) => f.item.includes('{{ad.id}}')) && !b.findings.find((f) => f.item.includes('{{ad.id}}')).present, 'ad token flagged missing');
console.log('PASS ad URL checker: tokened URL passes, bare URL flagged');

// ---------------------------------------------------------------- gate suite on a pilot-mock dataset
// One ad-attributed Instant Form lead so G1/G2 have real (non-vacuous) data.
const li = tx.run(`INSERT INTO lead (client_id, phone, email, name, stage) VALUES (1,'+919855555555','pilot@x.local','Pilot','New') RETURNING id`);
const pilotLead = Number(li.lastInsertRowid);
tx.run(`INSERT INTO event (lead_id, type, source_platform, source_ref, ts) VALUES (?,?,?,?,?)`,
  pilotLead, 'meta_form_lead', 'meta_leadgen', 'GATE-5001', now);
tx.run(`INSERT INTO touchpoint (lead_id, ad_id, adset_id, campaign_id, utm_source, utm_medium, ts)
  VALUES (?,?,?,?,?,?,?)`, pilotLead, 'ACT-1', 'ADS-1', 'CAM-1', 'facebook', 'paid', now);
const gates = P.runGates(tx);
const gmap = {}; for (const x of gates.gates) gmap[x.id] = x;
assert.strictEqual(gates.pass, true, 'all gates pass on the pilot-mock dataset. got: ' +
  gates.gates.map((x) => x.id + (x.pass ? '✓' : '✗ ' + x.detail)).join(' | '));
assert.strictEqual(gmap['G1'].pass, true, 'G1 Instant-Form lead has an ad_id');
assert.strictEqual(gmap['G2'].pass, true, 'G2 landing coverage ≥95%');
assert.strictEqual(gmap['G3'].pass, true, 'G3 no phone-duplicate leads');
assert.strictEqual(gmap['G4'].pass, true, 'G4 no stale webhook work');
console.log('PASS gate suite: ' + gates.gates.map((x) => x.id + '=' + x.detail).join(' · '));

// ---------------------------------------------------------------- accuracy checkers
// revenue vs gateways: net-of-refunds total of the backfilled deals (John+Ravi=9998; Deepa refunded)
const rev = P.revenueVsGateways(tx, { externalTotal: 9998, periodDays: 400 });
assert.strictEqual(rev.pass, true, 'revenue matches gateways (diff ' + rev.diff_pct + '%)');
assert.strictEqual(rev.our_total, 9998, 'net-of-refunds our_total = 9998 (got ' + rev.our_total + ')');
const revFail = P.revenueVsGateways(tx, { externalTotal: 9998 * 1.05, periodDays: 400 });
assert.strictEqual(revFail.pass, false, 'a >2% revenue diff must fail');
console.log('PASS accuracy: revenue vs gateways (≤2%) with net-of-refunds base');

// spend vs Meta Ads Manager: a spend_daily row, ≤1% diff
tx.run(`INSERT INTO spend_daily (ad_id, date, ad_account_id, spend, spend_inr, conversions)
  VALUES (?,?,?,?,?,?) ON CONFLICT(ad_id,date,ad_account_id) DO UPDATE SET spend_inr=excluded.spend_inr`,
  'ACT-1', today, 'ACC-1', 10000, 10000, 5);
const sp = P.spendVsMeta(tx, { externalTotal: 10000 });
assert.strictEqual(sp.pass, true, 'spend matches Meta (diff ' + sp.diff_pct + '%)');
const spFail = P.spendVsMeta(tx, { externalTotal: 10000 * 1.02 });
assert.strictEqual(spFail.pass, false, 'a >1% spend diff must fail');
console.log('PASS accuracy: spend vs Meta Ads Manager (≤1%)');

// CAPI match quality ≥7 on Purchase
tx.run(`INSERT INTO capi_log (event_row_id, event_name, pixel_id, dry_run, match_quality, sent_at) VALUES (?,?,?,?,?,?)`, 1, 'Purchase', 'PIX-1', 0, 8, now);
tx.run(`INSERT INTO capi_log (event_row_id, event_name, pixel_id, dry_run, match_quality, sent_at) VALUES (?,?,?,?,?,?)`, 2, 'Purchase', 'PIX-1', 0, 9, now);
const capi = P.capiQuality(tx);
assert.strictEqual(capi.n, 2, 'two Purchase quality rows');
assert.strictEqual(capi.avg_mq, 8.5, 'avg match quality 8.5');
assert.strictEqual(capi.pass, true, 'avg MQ ≥ 7 passes');
assert.strictEqual(capi.pct_good, 100, '100% of Purchases ≥7');
console.log('PASS accuracy: CAPI Purchase match quality ≥ 7 (avg ' + capi.avg_mq + ')');

// weekly report timing before/after log
const t = P.weeklyTiming(tx, { beforeMin: 60, afterMin: 10 });
assert.strictEqual(t.before_min, 60, 'before time logged');
assert.strictEqual(t.after_min, 10, 'after time logged');
assert.strictEqual(t.improvement_pct, 83, 'improvement 83% (60 -> 10 min)');
console.log('PASS accuracy: weekly report time logged (before ' + t.before_min + ' → after ' + t.after_min + ' min, ' + t.improvement_pct + '% faster)');

console.log('\nGATES TESTS PASSED (' + (isPG ? 'pg' : 'sqlite') + ')');
