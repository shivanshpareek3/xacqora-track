// PRD §10 — daily database backup. `runBackup(db)` writes a consistent
// single-file snapshot via VACUUM INTO (WAL-safe: no lost/wal corruption),
// keeps the newest 7 in backups/, and returns the file path.
const fs = require('node:fs');
const path = require('node:path');

const BACKUP_DIR = path.join(__dirname, '..', '..', 'backups');
const KEEP = 7;

function runBackup(db) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(BACKUP_DIR, `xacqora-${stamp}.sqlite3`);
  db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  // verify the snapshot opens and is queryable
  const { DatabaseSync } = require('node:sqlite');
  const chk = new DatabaseSync(out, { readOnly: true });
  const n = chk.prepare(`SELECT COUNT(*) c FROM lead`).get().c;
  chk.close();
  // retain the newest KEEP, drop older
  const kept = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('xacqora-') && f.endsWith('.sqlite3')).sort();
  for (const f of kept.slice(0, -KEEP)) fs.unlinkSync(path.join(BACKUP_DIR, f));
  return `backups/${path.basename(out)} (leads=${n}, kept ${Math.min(KEEP, kept.length)})`;
}

module.exports = { runBackup };
