// Daily database backup (PRD §10). Engine-aware (Phase P):
//   * Postgres (DATABASE_URL set)  — pg_dump via the shared runBackup().
//   * SQLite (default)             — VACUUM INTO a single-file snapshot, keep
//                                    the newest 7, verify the copy opens.
//   node scripts/backup.js
// Honours DATABASE_URL / XACQORA_DB_FILE.
const fs = require('node:fs');
const path = require('node:path');

if (process.env.DATABASE_URL) {
  // Postgres: delegate to the engine-aware runner (pg_dump + restore verify).
  // Under FORCE RLS a pg_dump by the RLS-bound app role is refused; the backup
  // path runs as the dedicated superuser role (created by pg-dev.sh /
  // pg-provision.sh). Default to it; override with PG_BACKUP_USER.
  process.env.PG_BACKUP_USER = process.env.PG_BACKUP_USER || 'xacq_backup';
  const { open } = require('../server/db');
  const { runBackup } = require('../server/lib/backup');
  const db = open();
  const line = runBackup(db);
  console.log('backup OK: ' + line);
  process.exit(0);
}

// ---------------------------------------------------------------- SQLite path
const { DatabaseSync } = require('node:sqlite');
const dbFile = process.env.XACQORA_DB_FILE || path.join(__dirname, '..', 'xacqora.sqlite3');
if (!fs.existsSync(dbFile)) {
  console.error('backup: no database at', dbFile);
  process.exit(1);
}
const outDir = path.join(__dirname, '..', 'backups');
fs.mkdirSync(outDir, { recursive: true });

// VACUUM INTO writes a consistent single-file snapshot (WAL-safe)
const src = new DatabaseSync(dbFile);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(outDir, `xacqora-${stamp}.sqlite3`);
src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
src.close();

// verify: the snapshot must open and count a known table
const chk = new DatabaseSync(out);
const n = chk.prepare(`SELECT COUNT(*) c FROM lead`).get().c;
chk.close();
console.log(`backup OK: ${path.relative(process.cwd(), out)} (leads=${n})`);

// keep the last 7, drop older
const kept = fs.readdirSync(outDir).filter((f) => f.startsWith('xacqora-') && f.endsWith('.sqlite3')).sort();
for (const f of kept.slice(0, -7)) fs.unlinkSync(path.join(outDir, f));
console.log('retained', Math.min(7, kept.length), 'of', kept.length, 'backups');
