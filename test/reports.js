// Phase R — Reports finish: exports (CSV + Excel), drill-down lead-id lists,
// net-of-refunds revenue, weekly PDF, and the Meta-vs-Track delta.
// Runs on the current engine (SQLite by default; set DATABASE_URL for PG) so
// both engines are covered by CI.
const assert = require('node:assert');
const { open, makeTx, alignSequences } = require('../server/db');
const S = require('../server/lib/shared');
const pdf = require('../server/lib/pdf');
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

// Throwaway database so the strict counts run against a clean schema on either
// engine (mirror isolation.js): SQLite = a fresh file, Postgres = a scratch db.
const isPG = process.env.DATABASE_URL ? true : false;
if (isPG) {
  const m = /^postgres(?:ql)?:\/\/([^:]+)(?::([^@]*))?@([^:]+):(\d+)\/(.+)$/.exec(process.env.DATABASE_URL);
  const env = { ...process.env };
  env.PGUSER = m[1]; env.PGHOST = m[3]; env.PGPORT = m[4]; env.PGDATABASE = 'postgres';
  if (m[2] != null) env.PGPASSWORD = m[2];
  const scratch = (m[5] || 'xacqora') + '_reports';
  try { execSync(`psql -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${scratch}' AND pid<>pg_backend_pid();" >/dev/null 2>&1`, { env }); } catch {}
  try { execSync(`psql -d ${scratch} -Atc "DROP OWNED BY ${m[1]};" >/dev/null 2>&1`, { env }); } catch {}
  try { execSync(`dropdb --force --if-exists ${scratch} >/dev/null 2>&1`, { env }); } catch {}
  execSync(`createdb ${scratch}`, { env });
  process.env.DATABASE_URL = `postgres://${m[1]}@${m[3]}:${m[4]}/${scratch}`;
} else {
  const f = path.join(__dirname, '..', 'xacqora-reports.sqlite3');
  for (const suf of ['', '-wal', '-shm']) { try { fs.unlinkSync(f + suf); } catch {} }
  process.env.XACQORA_DB_FILE = f;
}

const db = open();
const tx = makeTx(db, null);
const now = new Date().toISOString();

// ---- minimal scoped fixtures: client 1 + 2, ads, spend, leads, deals, refunds
tx.run(`INSERT INTO workspace (id, name) VALUES (1, 'W') ON CONFLICT(id) DO NOTHING`);
function fix(id, client) {
  tx.run(`INSERT INTO client (id, workspace_id, name) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name`, id, 1, 'C' + id);
  tx.run(`INSERT INTO meta_ad_account (id, client_id, name, ad_account_id, status) VALUES (?,?,?,?, 'connected')
    ON CONFLICT(id) DO NOTHING`, 100 + id, id, 'Acc ' + id, 'ACT-9' + id);
}
fix(1); fix(2);
// ad + spend with a Meta-reported conversions figure
tx.run(`INSERT INTO meta_ad (id, ad_account_id, adset_id, name, status) VALUES (?,?,?,?, 'ACTIVE') ON CONFLICT(id) DO NOTHING`, 'AD-1', 'ACT-91', 'A1', 'Ad one');
tx.run(`INSERT INTO spend_daily (ad_id, date, ad_account_id, spend_inr, impressions, clicks, conversions)
  VALUES ('AD-1', ?, 'ACT-91', 5000, 1000, 100, 42) ON CONFLICT(ad_id,date,ad_account_id) DO NOTHING`, now.slice(0, 10));

// leads: one paid + fully refunded (net 0), one paid (net 4999), one new
function lead(id, client, stage) {
  tx.run(`INSERT INTO lead (id, client_id, name, stage) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET stage=excluded.stage`, id, client, 'L' + id, stage);
}
lead(1001, 1, 'Paid');
lead(1002, 1, 'Paid');
lead(1003, 1, 'New');
// refund deal: refunded -> contributes 0
tx.run(`INSERT INTO deal (lead_id, client_id, amount, status, paid_at, refunded_at) VALUES (1001,1,4999,'refunded',?,?) ON CONFLICT(id) DO NOTHING`, now, now);
// paid deal: active -> contributes 4999
tx.run(`INSERT INTO deal (id, lead_id, client_id, amount, status, paid_at) VALUES (2002,1002,1,4999,'success',?) ON CONFLICT(id) DO NOTHING`, now);

// ---------------------------------------------------------------- net of refunds
const fp = S.funnelReport(tx, null, { attribution_model: 'last_paid_click', attribution_window_days: '30' }, [1]);
assert.strictEqual(fp.revenue, 4999, 'revenue must be net of the refund (got ' + fp.revenue + ')');
assert.strictEqual(fp.refunded, 1, 'one refunded lead expected');
assert.strictEqual(fp.paid, 2, 'two leads in Paid stage');
console.log('PASS net-of-refunds: revenue excludes refunded deal, refunded count surfaced');

// ---------------------------------------------------------------- drill-down lead-id lists
assert.deepStrictEqual([...(fp.lead_ids.revenue || [])].map(Number).sort((a, b) => a - b), [1002], 'revenue drill = only the net-paid lead');
assert.ok((fp.lead_ids.refunded || []).includes(1001), 'refund drill lists the refunded lead');
assert.strictEqual(fp.lead_ids.leads.length, 3, 'all-3 leads drill');
const ap = S.adPerformance(tx, { attribution_model: 'last_paid_click', attribution_window_days: '30' }, [1]);
// Ad-attributed leads list should be populated for any sale that had a touchpoint.
// (No touchpoint here -> sales are organic; just assert the field exists.)
assert.ok(ap.rows[0].lead_ids !== undefined && Array.isArray(ap.rows[0].lead_ids), 'ad row exposes lead_ids');
console.log('PASS drill-down: report numbers carry lead-id lists');

// ---------------------------------------------------------------- Meta vs Track (delta)
const mvt = S.metaVsTracker(tx, { attribution_model: 'last_paid_click' }, [1]);
const adRow = mvt.rows.find((r) => r.ad_id === 'AD-1');
assert.ok(adRow, 'meta-vs-track has a row for AD-1');
assert.strictEqual(adRow.meta_conv, 42, 'Meta-reported conversions = 42 from the spend pull');
assert.ok(typeof adRow.delta === 'number', 'delta column present');
assert.strictEqual(mvt.meta_conv_total, 42, 'meta total sums the ad conversions');
console.log('PASS meta-vs-track: per-ad Meta conversions vs our leads + delta');

// ---------------------------------------------------------------- weekly PDF
const ws = S.weeklySummary(tx, { attribution_model: 'last_paid_click', attribution_window_days: '30' }, [1]);
const buf = pdf.report(S.weeklyPdfLines(ws, 'Client 1'));
assert.strictEqual(buf.length > 200, true, 'pdf has content');
assert.strictEqual(buf.slice(0, 8).toString(), '%PDF-1.4', 'valid pdf header');
assert.ok(buf.indexOf('%%EOF') > 0, 'pdf ends with EOF');
console.log('PASS weekly summary PDF: valid single-file PDF bytes (' + buf.length + 'b)');

// ---------------------------------------------------------------- Excel + CSV export shapes
const excel = S.toExcel([{ id: 1, note: 'a,b "quoted"' }], { sheetName: 'test' });
assert.ok(excel.includes('<Workbook') && excel.includes('urn:schemas-microsoft-com:office:spreadsheet'), 'excel SpreadsheetML workbook');
assert.ok(excel.includes('&quot;quoted&quot;'), 'excel escapes quotes in XML');
assert.ok(excel.includes('a,b &quot;quoted&quot;'), 'excel keeps the full cell text (comma + quoted substring, escaped)');
assert.ok(excel.includes('<Data ss:Type="Number">1</Data>'), 'excel marks numeric cells as Number');
const csv = S.toCsv([{ id: 1, note: 'a,b "q"' }]);
assert.ok(csv.includes('"a,b ""q""'), 'csv quotes + doubles quotes');
console.log('PASS export shapes: CSV quoting + Excel SpreadsheetML (zero-dep)');

console.log('\nREPORTS TESTS PASSED (' + (process.env.DATABASE_URL ? 'pg' : 'sqlite') + ')');
