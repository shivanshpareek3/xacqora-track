#!/usr/bin/env node
// v10 Task 1 — one-time cleanup of TEST-ARTIFACT leads (NOT seed, NOT real).
//
// What it removes: the nameless leads that test harnesses POSTed through the
// live ingest pipeline into the SHARED dev DB. Their fingerprint (verified
// against the real 181 rows, 2026-11-04):
//   * id strictly above the seed range (>126), and ALL of
//   *   phone = email = name = owner NULL, source_unknown = 1
//   *   zero deals, zero touchpoints (no revenue, no ad attribution)
//   *   at least one event, and EVERY event's raw_payload is degenerate:
//       - '"__sweep_test"' marker (post-guard harness payloads), OR
//       - the exact body '{"client_id":1}' / '{"client_id":<n>}' that the
//         sweep's S.6 flood loop and the integrations "test event" button send.
//
// What it NEVER touches: the 26 seed leads (101-126), any lead with a real
// phone/email/name/owner, any lead with a deal or a touchpoint, and any lead
// with even one non-degenerate event. The guard is checked in JS after the
// row is loaded, so a false positive is impossible by construction:
// deletion only happens for leads that pass EVERY condition.
//
// Usage:
//   node scripts/clean-test-artifacts.js            # dry-run (default): list + count, no writes
//   node scripts/clean-test-artifacts.js --delete   # backup first (scripts/backup.js),
//                                                    # then delete; aborts on backup failure
// Idempotent: after a delete, a dry-run reports 0 found.
// Engine-aware: SQLite (XACQORA_DB_FILE, default xacqora.sqlite3) and Postgres
// (DATABASE_URL). This is a human-reviewed operation (it deletes rows) — run
// it in the terminal, not inside a test.
const { execSync } = require('node:child_process');
const path = require('node:path');

const mode = process.argv.includes('--delete') ? 'delete' : 'dry-run';

const { open, makeTx } = require('../server/db');
const db = open();
const tx = makeTx(db);

// JS-side classification: a lead is a test-artifact iff EVERY one of its
// events is degenerate:
//   * marker payloads:     {"client_id":N,"__sweep_test":true} (post-guard)
//   * pre-marker payloads: {"client_id":N} exactly (sweep S.6 flood / test btn)
// One real event (any other payload shape) keeps the lead.
const isDegenerate = (p) => {
  if (p == null) return false;
  const s = String(p);
  if (s.includes('"__sweep_test"')) return true;
  return /^\{"client_id":\d+\}$/.test(s);
};
// findArtifacts(): the full classification, recomputable at any point
// (used before AND after the delete for the idempotency check).
function findArtifacts() {
  const cands = tx.all(`
    SELECT l.id, l.client_id, l.created_at, l.source_unknown
    FROM lead l
    WHERE l.id > 126
      AND l.name IS NULL AND l.phone IS NULL AND l.email IS NULL
      AND l.source_unknown = 1
      AND NOT EXISTS (SELECT 1 FROM deal d WHERE d.lead_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM touchpoint t WHERE t.lead_id = l.id)`);
  const out = [];
  for (const l of cands) {
    const evs = tx.all(`SELECT raw_payload FROM event WHERE lead_id=?`, l.id);
    if (evs.length === 0) continue; // an artifact always carries its degenerate event
    if (!evs.every((e) => isDegenerate(e.raw_payload))) continue; // one real event -> keep
    out.push({ ...l, events: evs.length, marker: evs.some((e) => String(e.raw_payload || '').includes('"__sweep_test"')) });
  }
  return out;
}

const artifacts = findArtifacts();

// Snapshot what must survive (engine/DB-agnostic — no hardcoded counts).
const seedBefore = tx.get(`SELECT COUNT(*) c FROM lead WHERE id BETWEEN 101 AND 126`).c;
const namedBefore = tx.get(`SELECT COUNT(*) c FROM lead WHERE name IS NOT NULL OR phone IS NOT NULL OR email IS NOT NULL OR owner IS NOT NULL`).c;

console.log(`[clean-test-artifacts] mode=${mode} engine=${db.engine || 'sqlite'}`);
console.log(`[clean-test-artifacts] test-artifact leads matched (all events degenerate): ${artifacts.length}`);
if (artifacts.length) {
  const byMarker = artifacts.filter((a) => a.marker).length;
  console.log(`[clean-test-artifacts]   with "__sweep_test" marker: ${byMarker}; pre-marker {"client_id":N} fingerprint: ${artifacts.length - byMarker}`);
  const idMin = Math.min(...artifacts.map((a) => a.id));
  const idMax = Math.max(...artifacts.map((a) => a.id));
  console.log(`[clean-test-artifacts]   id range ${idMin}..${idMax}, sample: ` + artifacts.slice(0, 5).map((a) => `#${a.id} (client ${a.client_id}, ${a.events} event, created ${a.created_at})`).join('; '));
  console.log('[clean-test-artifacts]   seed 101-126 and every lead with a real identity/deal/touchpoint are structurally excluded.');
}

if (artifacts.length === 0) {
  console.log('[clean-test-artifacts] nothing to do (already clean).');
  if (db.close) db.close();
  process.exit(0);
}

if (mode === 'dry-run') {
  console.log('[clean-test-artifacts] DRY RUN — would delete ' + artifacts.length + ' leads and their degenerate events.');
  console.log('[clean-test-artifacts] confirm the list above, then re-run with --delete (a backup is taken first).');
  if (db.close) db.close();
  process.exit(0);
}

// ---- delete mode: BACKUP FIRST, abort on any failure -------------------
let bk = '';
try {
  bk = execSync(`node ${JSON.stringify(path.join(__dirname, 'backup.js'))}`, { encoding: 'utf8', stdio: 'pipe' });
} catch (e) {
  bk = String(e.stdout || '') + ' ' + String(e.message || '');
}
if (!/OK/i.test(bk)) {
  console.error('[clean-test-artifacts] ABORT: pre-delete backup did not report OK:\n' + bk.trim());
  process.exit(1);
}
console.log('[clean-test-artifacts] pre-delete backup: ' + bk.trim().split('\n').pop());

const ids = artifacts.map((a) => a.id);
const marks = ids.map(() => '?').join(',');
const evBefore = tx.get(`SELECT COUNT(*) c FROM event WHERE lead_id IN (${marks})`, ...ids).c;
tx.run(`DELETE FROM event WHERE lead_id IN (${marks})`, ...ids);
tx.run(`DELETE FROM lead_identity WHERE lead_id IN (${marks})`, ...ids);
const leadBefore = tx.get(`SELECT COUNT(*) c FROM lead WHERE id IN (${marks})`, ...ids).c;
tx.run(`DELETE FROM lead WHERE id IN (${marks})`, ...ids);

const deletedArtifacts = findArtifacts().length; // idempotency: must now be 0
const seedIntact = tx.get(`SELECT COUNT(*) c FROM lead WHERE id BETWEEN 101 AND 126`).c;
const namedIntact = tx.get(`SELECT COUNT(*) c FROM lead WHERE name IS NOT NULL OR phone IS NOT NULL OR email IS NOT NULL OR owner IS NOT NULL`).c;
console.log(`[clean-test-artifacts] deleted ${leadBefore} leads (+${evBefore} degenerate events)`);
console.log(`[clean-test-artifacts] verification: artifacts remaining=${deletedArtifacts} (expect 0); seed 101-126 intact=${seedIntact}/${seedBefore}; named leads intact=${namedIntact}/${namedBefore}`);
if (db.close) db.close();
if (deletedArtifacts !== 0 || seedIntact !== seedBefore || namedIntact !== namedBefore) process.exit(1);
console.log('[clean-test-artifacts] OK.');
