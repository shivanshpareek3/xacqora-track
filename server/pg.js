// Phase P — synchronous Postgres facade (pg-native / libpq).
//
// node:sqlite is synchronous; pg-native's libpq backend is too (PQexecParams /
// PQexec block until the result arrives). The app was written against the sync
// node:sqlite API — db.prepare().get/.run/.all, db.exec, and makeTx's
// { run, get, all, db } wrapper. This facade exposes the identical shapes, so
// the ~150 sync call sites stay untouched and the whole app runs on either
// engine. db.js picks: DATABASE_URL set -> this facade, else node:sqlite.
//
// What the facade owns:
//   1. SQL translation — `?` -> `$n`; `OR IGNORE`/`OR REPLACE` are already
//      written as portable `ON CONFLICT` in the app; and the reserved Postgres
//      identifier `user` is auto-quoted ("user") so app SQL stays dialect-free.
//   2. node:sqlite result shape: stmt.run() -> { changes, lastInsertRowid }.
//      `lastInsertRowid` is populated from the RETURNed id; the app appends
//      `RETURNING id` to its auto-increment INSERTs (portable to SQLite too).
//   3. Type fidelity: INT8/INT4 -> JS Number (so COUNT(*) and next_run_at
//      compare like the SQLite engine); TEXT (our ISO timestamps) -> string.
//   4. multi-statement exec (schema load, RLS DDL) — sent as one PQexec batch.
//   5. per-session RLS scoping: setScope(handle, user) sets the app.* GUCs the
//      policies in schema.pg.sql key on. Team/system -> unrestricted; the
//      client role -> locked to its own client ids.

const npg = require('pg-native');
const pgtypes = require('pg-types');

// Type parsers identical to pg's, except INT8 (OID 20) -> Number. Postgres
// reports COUNT(*) / any int8 as int8; the SQLite engine yields JS numbers, so
// we match that here (pg-types' default int8 parser returns a string).
function makeTypes() {
  const base = pgtypes;
  return { getTypeParser: (id) => (id === 20 ? (s) => parseInt(s, 10) : base.getTypeParser(id)) };
}
const OK_STATUS = new Set([2, 3, 'PGRES_COMMAND_OK', 'PGRES_TUPLES_OK']);

// ---------------------------------------------------------------- SQL translate
// `user` is a reserved word in Postgres; the app names its user table `user`.
// `\buser\b` matches only the standalone identifier — user_id / user_email /
// user_name never match (the trailing `_` is a word char, so the boundary
// fails). Guard against double-quoting when already quoted.
function quoteUserIdent(sql) {
  return String(sql).replace(/\buser\b/g, (m, off, s) => (off > 0 && s[off - 1] === '"' ? m : '"user"'));
}
// `?` -> $1..$n  (no `?` appears inside any string literal in the app's SQL)
function toDollars(sql) {
  let n = 0;
  return String(sql).replace(/\?/g, () => '$' + ++n);
}
function translate(sql) {
  return toDollars(quoteUserIdent(sql));
}

// ---------------------------------------------------------------- value shape
// libpq sends params as text and infers the column type from context. Guard
// undefined -> null so a stray JS undefined never reaches the C layer; the app
// already normalizes booleans to 1/0, but guard anyway.
function normalizeParam(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

// ---------------------------------------------------------------- facade
class PgConn {
  constructor(connectionString) {
    const client = npg({});
    client.pq.connectSync(connectionString);
    this.pq = client.pq;
    this.types = makeTypes();
    this.engine = 'pg';
  }

  _read() {
    const pq = this.pq;
    pq.consumeInput();
    const status = pq.resultStatus();
    const nfields = pq.nfields();
    const fields = [], parsers = [];
    for (let x = 0; x < nfields; x++) { fields[x] = pq.fname(x); parsers[x] = this.types.getTypeParser(pq.ftype(x)); }
    const n = pq.ntuples();
    const rows = new Array(n);
    for (let i = 0; i < n; i++) {
      const row = {};
      for (let j = 0; j < nfields; j++) {
        const v = pq.getvalue(i, j);
        row[fields[j]] = v === '' && pq.getisnull(i, j) ? null : parsers[j](v);
      }
      rows[i] = row;
    }
    return { status, rows, rowCount: parseInt(pq.cmdTuples() || '0', 10) || 0 };
  }

  // one parameterized statement -> { rows, changes, lastInsertRowid? }
  _execParams(sql, params = []) {
    this.pq.execParams(translate(sql), params.map(normalizeParam));
    const r = this._read();
    if (!OK_STATUS.has(r.status)) throw new Error('PG error (' + r.status + '): ' + this.pq.errorMessage() + '\n' + sql);
    r.changes = r.rowCount;
    if (r.rows.length && Object.prototype.hasOwnProperty.call(r.rows[0], 'id')) r.lastInsertRowid = r.rows[0].id;
    return r;
  }

  // multi-statement, non-parameterized DDL (schema + RLS). PQexec runs the whole
  // batch; the final resultStatus is what matters. No `?` / `user` translation
  // — the schema files are Postgres-native.
  exec(sql) {
    this.pq.exec(sql);
    this.pq.consumeInput();
    const st = this.pq.resultStatus();
    if (!OK_STATUS.has(st)) throw new Error('PG exec error (' + st + '): ' + this.pq.errorMessage() + '\n' + sql);
    return undefined;
  }

  prepare(sql) {
    const self = this;
    return {
      get(...args) { const r = self._execParams(sql, args); return r.rows.length ? r.rows[0] : undefined; },
      all(...args) { return self._execParams(sql, args).rows; },
      run(...args) { return self._execParams(sql, args); },
    };
  }

  close() { this.pq.finish(); }
}

// ---------------------------------------------------------------- RLS scope
// Drive the two app.* GUCs the policies key on (fail closed when neither set):
//   team / system / unknown user -> app.unrestricted='true'  (see everything)
//   client role                  -> app.client_ids='<ids>', app.unrestricted='false'
function userScope(user) {
  if (!user) return { unrestricted: true, clientIds: null };
  if (user.role !== 'client') return { unrestricted: true, clientIds: null }; // team: all internal clients
  const ids = String(user.client_ids || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number).filter(Number.isFinite);
  return { unrestricted: false, clientIds: ids };
}
function setScope(pgConn, user) {
  const s = userScope(user);
  const pq = pgConn.pq;
  if (s.unrestricted || !s.clientIds || !s.clientIds.length) {
    pq.execParams("SELECT set_config('app.unrestricted', 'true', false)");
  } else {
    pq.execParams("SELECT set_config('app.unrestricted', 'false', false), set_config('app.client_ids', $1, false)", [s.clientIds.join(',')]);
  }
  pq.consumeInput();
  return s;
}

module.exports = { PgConn, setScope, userScope, translate, normalizeParam, quoteUserIdent };
