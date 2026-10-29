// Minimal SQLite wrapper around node:sqlite (Node 24 built-in).
// node:sqlite binds positional params as spread arguments, not as an array.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function open() {
  const dbFile = process.env.XACQORA_DB_FILE || path.join(__dirname, '..', 'xacqora.sqlite3');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // lazily add tables that are created later in the codebase
  db.exec(`CREATE TABLE IF NOT EXISTS capi_log (
    id INTEGER PRIMARY KEY, event_row_id INTEGER NOT NULL, event_name TEXT, pixel_id TEXT,
    dry_run INTEGER DEFAULT 1, payload TEXT, event_id TEXT, match_quality INTEGER, sent_at TEXT
  )`);
  return db;
}

function makeTx(db) {
  // node:sqlite is synchronous; "transaction" simply means run statements in order.
  // run() returns { changes, lastInsertRowid } like node:sqlite's stmt.run().
  return {
    db,
    run(sql, ...args) {
      const stmt = db.prepare(sql);
      return args.length ? stmt.run(...args) : stmt.run();
    },
    get(sql, ...args) {
      const stmt = db.prepare(sql);
      return args.length ? stmt.get(...args) : stmt.get();
    },
    all(sql, ...args) {
      const stmt = db.prepare(sql);
      return args.length ? stmt.all(...args) : stmt.all();
    },
  };
}

module.exports = { open, makeTx };
