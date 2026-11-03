// Zero-dependency .env loader. The app is built zero-dep (no dotenv), so it
// did not read a .env file at all. This loader parses the repo-root .env and
// fills in process.env — for LOCAL DEV only.
//
// Rules:
//  - A real environment variable (or a Vercel dashboard var) always WINS:
//    we never override a key that is already set in process.env.
//  - Real secret values live in .env (gitignored) — they are never committed.
//  - Parse is deliberately minimal: `KEY=VALUE` lines, `#` comments, blank
//    lines skipped, surrounding single/double quotes stripped. No inline
//    comments / export prefixes / variables — keep the file human-writable.
//
// Called at the very top of server/index.js (before open()) so DATABASE_URL,
// XACQORA_LIVE, the META_* values and the secrets key are all present.
const fs = require('node:fs');
const path = require('node:path');

function parseLine(line) {
  line = line.trim();
  if (!line || line.startsWith('#')) return null;
  if (line.startsWith('export ')) line = line.slice(6).trim();
  const eq = line.indexOf('=');
  if (eq <= 0) return null; // no value part
  let key = line.slice(0, eq).trim();
  let val = line.slice(eq + 1).trim();
  // strip matching surrounding quotes
  if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
    val = val.slice(1, -1);
  }
  return { key, val };
}

// Load the .env at `file` (default: the repo-root .env, overridable via
// XACQORA_ENV_FILE) into process.env without overriding existing vars.
// Returns { loaded: n, path } so the caller can log what happened.
function loadEnvFile(file) {
  const p = file || process.env.XACQORA_ENV_FILE || path.join(__dirname, '..', '..', '.env');
  let text;
  try { text = fs.readFileSync(p, 'utf8'); }
  catch { return { loaded: 0, path: p, present: false }; } // no .env -> pure mock/dev
  let loaded = 0;
  for (const line of text.split(/\r?\n/)) {
    const kv = parseLine(line);
    if (kv && process.env[kv.key] === undefined) { process.env[kv.key] = kv.val; loaded++; }
  }
  return { loaded, path: p, present: true };
}

module.exports = { loadEnvFile, parseLine };
