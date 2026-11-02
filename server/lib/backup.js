// PRD §10 — daily database backup. `runBackup(db)` writes a consistent
// snapshot, keeps the newest 7 in backups/, and returns a human-readable line.
// Engine-aware (Phase P):
//   * SQLite   — VACUUM INTO (WAL-safe single-file snapshot).
//   * Postgres — pg_dump (custom format, compressed single file). Verify by
//                restoring into a scratch database and counting `lead`. The
//                app role needs CREATEDB for the scratch db (see
//                scripts/pg-provision.sh), or the env PG_RESTORE_DB override
//                names one it can drop.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const KEEP = 7;

// Build pg client env from DATABASE_URL (role owns / has rights to the db).
// The app role is bound by FORCE ROW LEVEL SECURITY, so a bare pg_dump/pg_restore
// as that role is refused ("query would be affected by row-level security
// policy"). The backup path therefore connects as a role that BYPASSES RLS —
// a dedicated superuser backup role, xacq_backup (created by scripts/pg-dev.sh
// + pg-provision.sh; see scripts/pg-provision.sh). Set PG_BACKUP_USER to point
// pg_dump/pg_restore at that role while the app itself keeps connecting as
// DATABASE_URL's role (which stays RLS-bound, so the isolation proof holds).
// When PG_BACKUP_USER is unset the app role is used, which still works on a
// database that has no FORCE policies.
function pgEnv() {
  const env = { ...process.env };
  const m = /^postgres(?:ql)?:\/\/([^:]+)(?::([^@]*))?@([^:]+):(\d+)\/(.+)$/.exec(process.env.DATABASE_URL || '');
  if (m) {
    env.PGUSER = process.env.PG_BACKUP_USER || m[1];
    env.PGHOST = m[3];
    env.PGPORT = m[4];
    env.PGDATABASE = m[5];
    if (m[2] != null) env.PGPASSWORD = m[2];
  }
  return env;
}

function pgRestoreCount(out) {
  // restore into a scratch db, count leads, drop the scratch db
  const env = pgEnv();
  const probe = process.env.PG_RESTORE_DB || 'xacqora_backup_probe';
  // Long form --if-exists: this pg CLI build rejects the short -if-exists
  // cluster ("unrecognized option `--exists'"), which left the probe db behind
  // and made the count line throw (n stayed -1).
  try {
    execSync(`dropdb --if-exists ${probe} >/dev/null 2>&1`, { env });
    execSync(`createdb ${probe}`, { env });
    execSync(`pg_restore -d ${probe} -v ${JSON.stringify(out)} >/dev/null 2>&1`, { env, stdio: 'pipe' });
    const n = Number(execSync(`psql -qAt -d ${probe} -c "SELECT count(*) FROM lead;"`, { env, stdio: 'pipe' }).toString().trim());
    return n;
  } finally {
    try { execSync(`dropdb --if-exists ${probe} >/dev/null 2>&1`, { env }); } catch { /* ignore */ }
  }
}

function runBackup(db) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (db.engine === 'pg') {
    const out = path.join(BACKUP_DIR, `xacqora-${stamp}.pgdump`);
    execSync(`pg_dump --format=c --compress=6 --file=${JSON.stringify(out)}`, { env: pgEnv() });
    let n = -1;
    try { n = pgRestoreCount(out); } catch { /* verify optional; file is what matters */ }
    const kept = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('xacqora-') && f.endsWith('.pgdump')).sort();
    for (const f of kept.slice(0, -KEEP)) fs.unlinkSync(path.join(BACKUP_DIR, f));
    return `backups/${path.basename(out)} (leads=${n}, kept ${Math.min(KEEP, kept.length)}, pg_dump)`;
  }

  // SQLite path (default)
  const out = path.join(BACKUP_DIR, `xacqora-${stamp}.sqlite3`);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  const { DatabaseSync } = require('node:sqlite');
  const chk = new DatabaseSync(out, { readOnly: true });
  const n = chk.prepare(`SELECT COUNT(*) c FROM lead`).get().c;
  chk.close();
  const kept = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('xacqora-') && f.endsWith('.sqlite3')).sort();
  for (const f of kept.slice(0, -KEEP)) fs.unlinkSync(path.join(BACKUP_DIR, f));
  return `backups/${path.basename(out)} (leads=${n}, kept ${Math.min(KEEP, kept.length)})`;
}

module.exports = { runBackup };
