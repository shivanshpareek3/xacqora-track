// Smoke-test the synchronous pg facade end-to-end against a live Postgres.
// Proves: connect -> schema exec -> RETURNING id -> COUNT(*) int8->Number ->
// RLS scoping (system unrestricted vs client-scoped vs fail-closed) through
// the REAL RLS-protected tables (lead, deal, funnel).
// Run:  DATABASE_URL=postgresql://xacq_app@127.0.0.1:5433/xacqora node scripts/pg-smoke.js
const { PgConn, setScope } = require('../server/pg');
const url = process.env.DATABASE_URL;
if (!url) { console.error('set DATABASE_URL'); process.exit(1); }

let fails = 0;
const check = (label, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + label + (cond ? '' : ' :: ' + detail));
  if (!cond) fails++;
};

const db = new PgConn(url); // runs schema.pg.sql? no — that's db.open's job here; exec it directly:
const fs = require('node:fs');
db.exec(fs.readFileSync(require('node:path').join(__dirname, '..', 'server', 'schema.pg.sql'), 'utf8'));
setScope(db, null); // unrestricted system scope — required before any DML under RLS

// seed two clients + leads via the facade (system scope); truncate so re-runs
// keep the counts deterministic
db.exec(`TRUNCATE lead, deal, event, funnel, funnel_stage, lead_identity, task, note, call_log, touchpoint CASCADE`);
db.exec(`INSERT INTO workspace (id, name) VALUES (1, 'Smoke') ON CONFLICT DO NOTHING`);
db.exec(`INSERT INTO client (id, workspace_id, name) VALUES (1, 1, 'Client A'), (2, 1, 'Client B') ON CONFLICT DO NOTHING`);
db.exec(`INSERT INTO lead (client_id, phone, name) VALUES (1, '+919000000001', 'A'), (1, '+919000000002', 'A2'), (2, '+919000000003', 'B')`);

// RETURNING id via the facade's run()
const r = db.prepare(`INSERT INTO funnel (client_id, name) VALUES (2, 'Smoke funnel') RETURNING id`).run();
check('run() returns {changes,lastInsertRowid} via RETURNING', r.changes === 1 && Number(r.lastInsertRowid) > 0, JSON.stringify(r));

// COUNT(*) -> int8 -> Number
const c = db.prepare(`SELECT COUNT(*) c FROM lead`).get();
check('COUNT(*) is a JS Number (int8 -> number)', typeof c.c === 'number', JSON.stringify(c));

// RLS: a client-1 scoped conn sees only client-1 leads (2)
const d1 = new PgConn(url); setScope(d1, { role: 'client', client_ids: '1' });
const c1 = d1.prepare(`SELECT COUNT(*) c FROM lead`).get();
check('client-1 RLS scope sees 2 leads', c1.c === 2, JSON.stringify(c1));

// client-2 scoped sees 1 lead
const d2 = new PgConn(url); setScope(d2, { role: 'client', client_ids: '2' });
const c2 = d2.prepare(`SELECT COUNT(*) c FROM lead`).get();
check('client-2 RLS scope sees 1 lead', c2.c === 1, JSON.stringify(c2));

// a team/unrestricted conn sees all 3
const dT = new PgConn(url); setScope(dT, { role: 'owner', client_ids: '' });
const cA = dT.prepare(`SELECT COUNT(*) c FROM lead`).get();
check('team (unrestricted) sees all 3 leads', cA.c === 3, JSON.stringify(cA));

// no GUC = system/maintenance context (ticker, queue, backup, pg_dump) ->
// the default-open policy grants full visibility. This is what makes
// pg_dump/pg_restore and ad-hoc psql work under FORCE RLS.
const dF = new PgConn(url);
const cF = dF.prepare(`SELECT COUNT(*) c FROM lead`).get();
check('no-scope (system/maintenance) connection sees all leads', cF.c === 3, JSON.stringify(cF));

d1.close(); d2.close(); dT.close(); dF.close(); db.close();
console.log(fails ? fails + ' smoke check(s) FAILED' : 'PG FACADE + RLS SMOKE PASSED');
process.exit(fails ? 1 : 0);
