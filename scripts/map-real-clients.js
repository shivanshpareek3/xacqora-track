// v11 — real-client ad-account mapping (one-shot, idempotent, both engines).
//
// Creates the operator's REAL clients, marks the seed demo clients (Coach Ravi
// — Webinar Funnel, Kaya Coach — Workshop) as client.demo=1 so DATA_MODE=live
// hides their whole dataset (accounts + leads + deals + spend), and points the
// seven real act_ ad accounts at the client the operator mapped them to.
//
// Run:  node scripts/map-real-clients.js            (SQLite dev DB)
//       DATABASE_URL=postgresql://xacq_app@127.0.0.1:5433/xacqora \
//         node scripts/map-real-clients.js          (PG dev cluster)
//
// The script is idempotent: re-running it updates, never duplicates. Real
// client rows are matched by name; ad accounts by ad_account_id.
const { open, makeTx } = require('../server/db');

// operator's mapping: real client name -> the ad account ids it owns.
// (Names exactly as the operator supplied them, 2026-11-05.)
const MAPPING = [
  { name: 'Abhishek pal',      accounts: ['act_1042839737275035', 'act_500594992542527'] },
  { name: 'Cracckfyi',         accounts: ['act_1626467978880942'] },
  { name: 'Swraj jain',        accounts: ['act_4683943305259169'] },
  { name: 'Upcurvv',           accounts: ['act_4749960348632164'] },
  { name: 'The Job work shop', accounts: ['act_935714081758825'] },
  { name: 'Piyush ahuja',      accounts: ['act_1377451727314532'] },
];
// seed/demo clients — their whole dataset hides in DATA_MODE=live.
const DEMO_CLIENT_NAMES = ['Coach Ravi — Webinar Funnel', 'Kaya Coach — Workshop'];

function main() {
  const db = open(); // runs the client.demo migration on both engines
  const tx = makeTx(db, null);
  const ws = Number(tx.get(`SELECT id FROM workspace ORDER BY id LIMIT 1`)?.id || 1);

  // ---- 1. create / find the real clients ----
  const idsByName = {};
  for (const c of MAPPING) {
    const ex = tx.get(`SELECT id FROM client WHERE name=?`, c.name);
    if (ex) idsByName[c.name] = Number(ex.id);
    else {
      const r = tx.run(`INSERT INTO client (workspace_id, name, currency) VALUES (?,?,?)`, ws, c.name, c.accounts.includes('act_935714081758825') ? 'AED' : 'INR');
      idsByName[c.name] = Number(r.lastInsertRowid || tx.get(`SELECT id FROM client WHERE name=?`, c.name)?.id);
      console.log(`  client created: ${c.name} (id ${idsByName[c.name]})`);
    }
  }

  // ---- 2. mark the seed demo clients ----
  for (const n of DEMO_CLIENT_NAMES) {
    const r = tx.run(`UPDATE client SET demo=1 WHERE name=?`, n);
    if (r.changes) console.log(`  marked demo=1: ${n}`);
  }

  // ---- 3. point the real ad accounts at their client ----
  for (const c of MAPPING) {
    for (const act of c.accounts) {
      const ex = tx.get(`SELECT id FROM meta_ad_account WHERE ad_account_id=?`, act);
      if (!ex) { console.log(`  (no account row for ${act} — created on next pull)`); continue; }
      tx.run(`UPDATE meta_ad_account SET client_id=? WHERE ad_account_id=?`, idsByName[c.name], act);
      console.log(`  ${act} -> client ${idsByName[c.name]} (${c.name})`);
    }
  }

  // ---- summary ----
  console.log('=== RESULT ===');
  for (const r of tx.all(`SELECT c.id, c.name, c.demo, (SELECT COUNT(*) FROM meta_ad_account m WHERE m.client_id=c.id) accts
    FROM client c WHERE c.workspace_id=? ORDER BY c.demo DESC, c.id`, ws)) {
    console.log(`  ${r.demo ? '[demo]' : '[real]'} client ${r.id}: ${r.name} — ${r.accts} account(s)`);
  }
  if (db.close) db.close();
  console.log('done.');
}
main();
