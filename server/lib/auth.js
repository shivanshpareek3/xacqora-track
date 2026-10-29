// Session-token auth with roles, client access lists and 2FA.
const crypto = require('node:crypto');
const sec = require('./security');

function hashPassword(pw) {
  return crypto.createHash('sha256').update('xacqora:' + pw).digest('hex');
}

function createSession(db, user, ttlDays = 30) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO session_token (token, user_id, expires_at) VALUES (?,?,?)`)
    .run(token, user.id, new Date(Date.now() + ttlDays * 86400000).toISOString());
  return token;
}

// A user row is only treated as authenticated when 2FA (if enabled for the
// account) has been passed for THIS login. Sessions are only ever created on
// that path (see index.js sign-in + /2fa), so cookie-issued users are fully
// authenticated by construction.
function userFromCookie(db, cookieHeader) {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/xt_session=([a-f0-9]+)/);
  if (!m) return null;
  const s = db.prepare(`SELECT * FROM session_token WHERE token=?`).get(m[1]);
  if (!s) return null;
  if (s.expires_at && s.expires_at < new Date().toISOString()) return null;
  const u = db.prepare(`SELECT * FROM user WHERE id=?`).get(s.user_id);
  if (!u) return null;
  const clientNames = (u.client_ids || '').split(',').filter(Boolean)
    .map((id) => db.prepare(`SELECT name FROM client WHERE id=?`).get(id)?.name).filter(Boolean);
  // never let the raw 2FA secret leak into rendered/server-side user objects
  const { totp_secret, ...safe } = u;
  return { ...safe, clientNames, totp_enabled: !!u.totp_enabled };
}

function audit(db, user, action, entity, entityId, detail) {
  db.prepare(`INSERT INTO audit_log (user_email, action, entity, entity_id, detail) VALUES (?,?,?,?,?)`)
    .run(user?.email || 'system', action, entity || null, entityId || null, detail || null);
}

module.exports = { hashPassword, createSession, userFromCookie, audit };
