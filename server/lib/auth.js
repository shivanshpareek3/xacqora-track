// Session-token auth with roles and client access lists.
const crypto = require('node:crypto');

function hashPassword(pw) {
  return crypto.createHash('sha256').update('xacqora:' + pw).digest('hex');
}

function createSession(db, user, ttlDays = 30) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare(`INSERT INTO session_token (token, user_id, expires_at) VALUES (?,?,?)`)
    .run(token, user.id, new Date(Date.now() + ttlDays * 86400000).toISOString());
  return token;
}

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
  return { ...u, clientNames };
}

function audit(db, user, action, entity, entityId, detail) {
  db.prepare(`INSERT INTO audit_log (user_email, action, entity, entity_id, detail) VALUES (?,?,?,?,?)`)
    .run(user?.email || 'system', action, entity || null, entityId || null, detail || null);
}

module.exports = { hashPassword, createSession, userFromCookie, audit };
