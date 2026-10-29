// Daily database backup (PRD §10): copy the SQLite file to backups/ with a
// timestamp, keep the last 7, and verify the copy opens cleanly.
//   node scripts/backup.js [dbPath]
// XACQORA_DB_FILE env var is honoured; default is the app's xacqora.sqlite3.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const dbFile = process.argv[2] || process.env.XACQORA_DB_FILE || path.join(__dirname, '..', 'xacqora.sqlite3');
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
