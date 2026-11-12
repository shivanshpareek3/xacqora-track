// v14 — Webhooks & API Keys. Lifecycle for the token-in-URL inbound
// endpoints (webhook_endpoint.slug/token_hash/status) and the bearer API-key
// store (api_keys). The public ingest path (handleIngest in server/index.js)
// calls resolveByToken() so a POST to /webhooks/<platform>/<slug>/<token>
// authenticates against THIS endpoint row (status + events-scope checks),
// not just the first matching platform+client.
//
// API keys: generated with an `xak_` prefix, only the sha256 hash is stored,
// the plaintext is returned ONCE to the caller (never re-readable). Auth is
// enforced on /api/app/* by lib/api.js (see bearerAuth below).
const crypto = require('node:crypto');
const S = require('./shared');
const sec = require('./security');

// ---------------------------------------------------------------- token + key primitives
// URL token: 40 hex chars (160 bits) — long enough that a leaked URL is not
// brute-forceable, short enough to paste into FlexiFunnels / Razoar boxes.
function genToken() {
  return crypto.randomBytes(20).toString('hex');
}
// API key: `xak_` + 40 base64url chars. Human-pasted into an Authorization:
// Bearer header. Returned once at creation; only keyHash is persisted.
function genApiKey() {
  return 'xak_' + crypto.randomBytes(30).toString('base64url');
}
function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s == null ? '' : s), 'utf8').digest('hex');
}
// slug: lowercase alnum-dash, from a description like "Webinar opt-in form"
// -> "webinar-opt-in-form". Falls back to a short token prefix when empty.
function slugOf(desc, token) {
  const s = String(desc || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || String(token).slice(0, 8);
}

// ---------------------------------------------------------------- base URL
// The public inbound base is APP_URL (set on the host/Vercel env) when present,
// else the current host the request is on. We pass it in from the route so
// this stays testable without a live request.
function publicBase(req) {
  const fromEnv = process.env.APP_URL || process.env.XACQORA_PUBLIC_URL;
  if (fromEnv) return String(fromEnv).replace(/\/$/, '');
  const proto = (req && req.headers['x-forwarded-proto']) || 'http';
  const host = (req && req.headers['x-forwarded-host']) || (req && req.headers['host']) || 'localhost:4100';
  return proto + '://' + host;
}

// ---------------------------------------------------------------- webhook endpoints
function baseEndpoint(tx, row) {
  return {
    id: row.id, client_id: row.client_id, platform: row.platform,
    slug: row.slug, description: row.description,
    events: row.events || 'all', status: row.status || 'active',
    events_total: row.events_total || 0, last_event_at: row.last_event_at,
    created_at: row.created_at,
  };
}
// Create a new endpoint. Returns the full row including the ONE-TIME url +
// secret. Callers must capture the url now; it is not returned by GET again
// (only the token is re-derivable, the secret is encrypted at rest).
function createEndpoint(tx, { client_id, platform, description, events, base }) {
  const token = genToken();
  const slug = slugOf(description, token);
  const secret = sec.encryptSecret(genToken().slice(0, 24));
  const url = base + `/webhooks/${platform}/${slug}/${token}`;
  const info = tx.run(
    `INSERT INTO webhook_endpoint (client_id, platform, url, secret, slug, token_hash, description, events, status, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    Number(client_id), String(platform), url, secret, slug, sha256Hex(token),
    description || null, events || 'all', 'active', new Date().toISOString());
  const row = tx.get(`SELECT * FROM webhook_endpoint WHERE id=?`, Number(info.lastInsertRowid));
  return { ...baseEndpoint(tx, row), url, token, secretPlain: sec.decryptSecret(secret) };
}
// All endpoints for a client (or all for team). The legacy encrypted `secret`
// is masked; the token-in-URL `url` IS returned in full (it is the endpoint's
// auth and the user must be able to re-copy it to re-paste into the platform)
// — this route is team-only + cookie-auth, and any URL can be rotated.
function listEndpoints(tx, clientIds) {
  const where = clientIds && clientIds.length ? `WHERE client_id IN (${clientIds.map((n) => Number(n)).join(',')})` : '';
  return tx.all(`SELECT * FROM webhook_endpoint ${where} ORDER BY id DESC`).map((r) => {
    const out = baseEndpoint(tx, r);
    out.url = r.url;
    out.url_masked = maskUrl(r.url);
    out.secret_masked = r.secret ? (sec.decryptSecret(r.secret).slice(0, 4) || '•') + '•••' : '';
    return out;
  });
}
// Mask the URL's token for display: keep host + path, redact the 40-char token.
function maskUrl(url) {
  if (!url) return '';
  const m = String(url).match(/^(.*)\/([a-z0-9]{16,})(\/?)(.*)$/i);
  return m ? m[1] + '/' + m[2].slice(0, 6) + '…' + (m[3] || '') + (m[4] || '') : url;
}
// Resolve an inbound POST by its URL token. Returns the row + the decrypted
// secret, or null. Used by handleIngest to authenticate /webhooks/.../.../TOKEN.
function resolveByToken(tx, platform, token) {
  const hash = sha256Hex(token);
  const row = tx.get(`SELECT * FROM webhook_endpoint WHERE platform=? AND token_hash=?`, platform, hash);
  if (!row) return null;
  return { row, secret: sec.decryptSecret(row.secret) };
}
// Pause / resume / revoke (revoke = invalidate the token without deleting the
// row, so the log keeps its history).
function setStatus(tx, id, status, user) {
  const row = tx.get(`SELECT * FROM webhook_endpoint WHERE id=?`, Number(id));
  if (!row) return null;
  const next = ['active', 'paused', 'revoked'].includes(status) ? status : 'active';
  tx.run(`UPDATE webhook_endpoint SET status=? WHERE id=?`, next, Number(id));
  return { id: Number(id), status: next, url: row.url };
}
// Count + timestamp an event on the endpoint (called from the ingest path
// after a successful/failed enqueue so the screen can show last-event + total).
function recordEvent(tx, endpointId) {
  const now = new Date().toISOString();
  tx.run(`UPDATE webhook_endpoint SET events_total=events_total+1, last_event_at=? WHERE id=?`, now, Number(endpointId));
}
// Delete (removes the row; any past webhook_log rows remain for the audit).
function deleteEndpoint(tx, id) {
  tx.run(`DELETE FROM webhook_endpoint WHERE id=?`, Number(id));
  return { id: Number(id) };
}

// ---------------------------------------------------------------- API keys
function createApiKey(tx, { scope_client_id, label, permission, createdBy }) {
  const key = genApiKey();
  const hash = sha256Hex(key);
  const perm = permission === 'read_write' ? 'read_write' : 'read_only';
  const info = tx.run(
    `INSERT INTO api_keys (scope_client_id, label, permission, key_hash, created_by, created_at)
     VALUES (?,?,?,?,?,?) RETURNING id`,
    scope_client_id == null ? null : Number(scope_client_id),
    label || 'API key', perm, hash, createdBy || null, new Date().toISOString());
  const row = tx.get(`SELECT * FROM api_keys WHERE id=?`, Number(info.lastInsertRowid));
  return { ...keyView(row), key }; // key = the ONE-TIME plaintext
}
// Public view of a key (no hash, no plaintext).
function keyView(r) {
  return {
    id: r.id, label: r.label, permission: r.permission,
    scope_client_id: r.scope_client_id,
    created_by: r.created_by, created_at: r.created_at,
    last_used_at: r.last_used_at, revoked_at: r.revoked_at,
    status: r.revoked_at ? 'revoked' : 'active',
    prefix: 'xak_…',
  };
}
function listApiKeys(tx, clientIds) {
  // Keys are a team-managed credential store. The screen is team-only, and the
  // RLS policy hides the table entirely from scoped client sessions, so this
  // lister only ever runs for team roles (clientIds null) or one's own scope.
  const where = clientIds && clientIds.length
    ? `WHERE scope_client_id IN (${clientIds.map((n) => Number(n)).join(',')}) OR scope_client_id IS NULL`
    : '';
  return tx.all(`SELECT * FROM api_keys ${where} ORDER BY id DESC`).map(keyView);
}
// Verify a bearer key. Returns { ok, key } (key = the row) or { ok:false }.
// On success, record last_used_at.
function verifyApiKey(tx, provided) {
  if (!provided) return { ok: false };
  const hash = sha256Hex(String(provided).trim());
  const row = tx.get(`SELECT * FROM api_keys WHERE key_hash=?`, hash);
  if (!row) return { ok: false };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  tx.run(`UPDATE api_keys SET last_used_at=? WHERE id=?`, new Date().toISOString(), row.id);
  return { ok: true, key: row };
}
function revokeApiKey(tx, id, user) {
  tx.run(`UPDATE api_keys SET revoked_at=? WHERE id=? AND revoked_at IS NULL`, new Date().toISOString(), Number(id));
  return { id: Number(id) };
}
function deleteApiKey(tx, id) {
  tx.run(`DELETE FROM api_keys WHERE id=?`, Number(id));
  return { id: Number(id) };
}

module.exports = {
  genToken, genApiKey, sha256Hex, slugOf, publicBase,
  createEndpoint, listEndpoints, resolveByToken, setStatus, recordEvent, deleteEndpoint,
  createApiKey, listApiKeys, verifyApiKey, revokeApiKey, deleteApiKey,
  keyView,
};
