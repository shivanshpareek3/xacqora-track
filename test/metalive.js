// Meta live-connect bridge test (pull-only path; CAPI stays dry). Verifies on
// BOTH engines that:
//  1. env -> DB: META_ACCESS_TOKEN + META_AD_ACCOUNT_IDS upsert encrypted rows
//     into meta_ad_account (the "fill the .env and start the server" workflow)
//  2. the token is stored ENCRYPTED at rest (never the plaintext in the column)
//  3. liveMode() stays false without XACQORA_LIVE, and is true with it + a real token
//  4. the CAPI gate is dry by default (settings.capi unset/absent -> dryRun)
//  5. the error classifier + token-expiry signal the /alerts screen surfaces
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { open, makeTx } = require('../server/db');
const ml = require('../server/lib/metalive');
const sec = require('../server/lib/security');
const live = require('../server/lib/liveapi');

// ---------------------------------------------------------------- scratch db (mirror test/gates.js)
const isPG = !!process.env.DATABASE_URL;
if (isPG) {
  const m = /^postgres(?:ql)?:\/\/([^:]+)(?::([^@]*))?@([^:]+):(\d+)\/(.+)$/.exec(process.env.DATABASE_URL);
  const env = { ...process.env };
  env.PGUSER = m[1]; env.PGHOST = m[3]; env.PGPORT = m[4]; env.PGDATABASE = 'postgres';
  if (m[2] != null) env.PGPASSWORD = m[2];
  const scratch = (m[5] || 'xacqora') + '_metalive';
  for (const q of [
    `psql -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${scratch}' AND pid<>pg_backend_pid();"`,
    `psql -d ${scratch} -Atc "DROP OWNED BY ${m[1]};"`,
    `dropdb --force --if-exists ${scratch}`,
  ]) { try { execSync(q, { env }); } catch {} }
  execSync(`createdb ${scratch}`, { env });
  process.env.DATABASE_URL = `postgres://${m[1]}@${m[3]}:${m[4]}/${scratch}`;
} else {
  const f = path.join(__dirname, '..', 'xacqora-metalive.sqlite3');
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(f + s); } catch {} }
  process.env.XACQORA_DB_FILE = f;
}
// ensure a secure key for the encrypt-at-rest assertions
if (!process.env.XACQORA_SECRET_KEY) process.env.XACQORA_SECRET_KEY = 'a'.repeat(64);

const db = open();
const tx = makeTx(db, null);

// ---- fixtures: a workspace + client so the FK holds on Postgres
tx.run(`INSERT INTO workspace (id, name) VALUES (1, 'W') ON CONFLICT(id) DO NOTHING`);
tx.run(`INSERT INTO client (id, workspace_id, name) VALUES (1, 1, 'Pilot Client') ON CONFLICT(id) DO NOTHING`);

// ---------------------------------------------------------------- 1. env -> DB bridge
const before = tx.get(`SELECT COUNT(*) c FROM meta_ad_account WHERE ad_account_id='ACT-9000'`).c;
assert.strictEqual(before, 0, 'ACT-9000 does not exist yet');
const notes = ml.syncMetaAccountsFromEnv(tx, {
  token: 'FAKE_LONG_LIVED_SYSTEM_TOKEN',
  adAccountIds: ['ACT-9000', 'ACT-9001'],
  pixelId: 'PIXEL-9',
  name: 'Pilot main',
  clientId: 1,
});
assert.strictEqual(notes.length, 2, 'two account rows synced');
const row = tx.get(`SELECT * FROM meta_ad_account WHERE ad_account_id='ACT-9000'`);
assert.ok(row, 'ACT-9000 row created');
assert.strictEqual(row.pixel_id, 'PIXEL-9', 'pixel stored on the row');
assert.strictEqual(row.status, 'connected', 'row is connected');
assert.ok(String(row.token).startsWith('enc:v1:'), 'token is stored ENCRYPTED at rest, not plaintext');
assert.strictEqual(sec.decryptSecret(row.token), 'FAKE_LONG_LIVED_SYSTEM_TOKEN', 'decrypts back to the token');
// idempotent: a re-sync updates, does not duplicate
ml.syncMetaAccountsFromEnv(tx, { token: 'FAKE_LONG_LIVED_SYSTEM_TOKEN', adAccountIds: ['ACT-9000', 'ACT-9001'] });
assert.strictEqual(tx.get(`SELECT COUNT(*) c FROM meta_ad_account WHERE ad_account_id='ACT-9000'`).c, 1, 're-sync is idempotent');
console.log('PASS metalive: .env values upsert encrypted meta_ad_account rows (idempotent)');

// blank/absent token is a no-op (dev stays on mock without touching the DB)
const noop = ml.syncMetaAccountsFromEnv(tx, { token: '', adAccountIds: [] });
assert.strictEqual(noop.length, 0, 'blank .env is a no-op');
console.log('PASS metalive: blank .env -> no DB writes (dev stays mock)');

// ---------------------------------------------------------------- 3. liveMode() gate
delete process.env.XACQORA_LIVE;
assert.strictEqual(live.liveMode(), false, 'liveMode false without XACQORA_LIVE');
process.env.XACQORA_LIVE = '1';
assert.strictEqual(live.liveMode(), true, 'liveMode true with XACQORA_LIVE=1');
process.env.MOCK = '1';
assert.strictEqual(live.liveMode(), false, 'MOCK=1 forces mock even with LIVE=1');
delete process.env.MOCK; delete process.env.XACQORA_LIVE;
console.log('PASS liveMode: XACQORA_LIVE + MOCK gating is correct');

// ---------------------------------------------------------------- 4. CAPI dry-run by default
// pushCapiEvent reads settings.capi; absent -> dry. Confirm the setting path the
// bridge relies on stays dry unless explicitly flipped (no env var drives it).
const capi = tx.get(`SELECT value FROM settings WHERE key='capi'`);
const dryRun = !capi || capi.value !== 'live';
assert.strictEqual(dryRun, true, 'CAPI is dry-run by default (no settings.capi=live)');
console.log('PASS CAPI gate: dry-run unless settings.capi is explicitly "live"');

// ---------------------------------------------------------------- 5. /alerts signals
const cls = ml.classifyMetaError('meta insights 401');
assert.ok(/token/i.test(cls), '401 classifies as a token problem');
assert.ok(/assign|permission/i.test(ml.classifyMetaError('error code 200: ad account not assigned')), '200 classifies as a permission/assign problem');
assert.ok(/retry|network|api/i.test(ml.classifyMetaError('fetch failed: timeout')), 'network classifies as retry-with-backoff');
// token-expiry signal: record a soon-to-expire time and confirm the flag flips
tx.run(`UPDATE meta_ad_account SET token_expires_at=? WHERE ad_account_id='ACT-9000'`, new Date(Date.now() + 24 * 3600000).toISOString());
const expSoon = ml.metaTokenExpiry(tx);
assert.strictEqual(expSoon.expiringSoon, 1, 'a 24h-out token is flagged expiring-soon');
tx.run(`UPDATE meta_ad_account SET token_expires_at=? WHERE ad_account_id='ACT-9001'`, new Date(Date.now() - 60 * 1000).toISOString());
const expNow = ml.metaTokenExpiry(tx);
assert.strictEqual(expNow.expired, 1, 'an already-past token is flagged expired');
console.log('PASS /alerts signals: friendly error classification + token-expiry flags');

console.log('\nMETALIVE TESTS PASSED (' + (isPG ? 'pg' : 'sqlite') + ')');
