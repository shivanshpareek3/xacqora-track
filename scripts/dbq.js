// Engine-aware one-liner query runner: emits each result row as a
// tab-separated line on stdout (no headers).
//   * SQLite (default): runs against XACQORA_DB_FILE (node:sqlite).
//   * Postgres: when DATABASE_URL is set, runs via psql -At (pg-native's
//     connection string is not accepted by psql, so we translate the env
//     vars psql needs).
// Usage:  node scripts/dbq.js "SELECT COUNT(*) FROM lead" [param1 ...]
// (bind params are only supported on the SQLite path; the app's test
// queries are all literal-constant, so the pg path takes no params.)
const path = require('node:path');
const { execSync } = require('node:child_process');

const sql = (process.argv[2] || '').trim();
if (!sql) { console.error('usage: node scripts/dbq.js "<sql>"'); process.exit(2); }

if (process.env.DATABASE_URL) {
  const u = new URL(process.env.DATABASE_URL);
  const args = [
    '-h', u.hostname,
    '-p', String(u.port || 5432),
    '-U', u.username || 'postgres',
    '-d', u.pathname.replace(/^\//, ''),
    '-At', '-v', 'ON_ERROR_STOP=1',
    '-c', sql,
  ];
  const env = { ...process.env };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const out = execSync(`psql ${args.map((a) => JSON.stringify(a)).join(' ')}`, { env, encoding: 'utf8' });
  process.stdout.write(out); // psql -At already emits bare tab-separated rows
} else {
  const { DatabaseSync } = require('node:sqlite');
  const dbFile = process.env.XACQORA_DB_FILE || path.join(__dirname, '..', 'xacqora.sqlite3');
  const db = new DatabaseSync(dbFile, { readOnly: true });
  const rows = db.prepare(sql).all();
  for (const r of rows) process.stdout.write(Object.values(r).join('\t') + '\n');
}
