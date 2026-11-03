// Phase S — security primitives. Central, tested, and reusable across the
// app so client isolation, secrets-at-rest, 2FA and rate limiting have one
// source of truth instead of being re-implemented per route.

const crypto = require('node:crypto');

// ---------------------------------------------------------------- secrets at rest
// AES-256-GCM. The master key comes from XACQORA_SECRET_KEY (hex or base64,
// 32 bytes). When absent we derive one so the demo still runs, but that is
// insecure and clearly flagged — production MUST set the env key.
function masterKey() {
  const raw = process.env.XACQORA_SECRET_KEY;
  if (raw) {
    const buf = raw.length === 64 ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (buf.length === 32) return { key: buf, secure: true };
  }
  // insecure dev fallback — never use in production
  return { key: crypto.createHash('sha256').update('xacqora-insecure-dev-key').digest(), secure: false };
}
const PREFIX = 'enc:v1:';

// encryptSecret(plain) -> "enc:v1:<iv-b64>:<ct-b64>:<tag-b64>"
function encryptSecret(plain) {
  if (plain == null || plain === '') return plain;
  if (String(plain).startsWith(PREFIX)) return plain; // already wrapped
  const { key } = masterKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.from(iv).toString('base64') + ':' + ct.toString('base64') + ':' + tag.toString('base64');
}
// decryptSecret(wrapped) -> plain (returns '' for unwrapped input)
function decryptSecret(wrapped) {
  if (wrapped == null || wrapped === '') return '';
  if (!String(wrapped).startsWith(PREFIX)) return String(wrapped); // legacy plaintext
  try {
    // layout: enc:v1:<iv>:<ct>:<tag>  -> split(':') = [enc, v1, iv, ct, tag]
    const [,, ivB64, ctB64, tagB64] = String(wrapped).split(':');
    const { key } = masterKey();
    const iv = Buffer.from(ivB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (e) {
    return ''; // key mismatch or corruption -> treat as unreadable, never crash
  }
}

// ---------------------------------------------------------------- client access
// Team roles (owner, admin, media_buyer, sales_rep, viewer) operate across all
// internal clients. The client role is locked to its own client_ids.
const TEAM_ROLES = ['owner', 'admin', 'media_buyer', 'sales_rep', 'viewer'];
function isTeam(user) {
  return !!user && TEAM_ROLES.includes(user.role);
}
// allowedClientIds(user): number[] of clients the user may see, or null when
// unrestricted (team roles). Use this at the data layer, not the UI layer.
function allowedClientIds(user) {
  if (!user) return [0]; // nobody
  if (user.role === 'client') {
    return (user.client_ids || '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  }
  if (isTeam(user)) return null; // unrestricted
  return [];
}
function canAccessClient(user, clientId) {
  const ids = allowedClientIds(user);
  if (ids === null) return true; // team: all internal clients
  return ids.includes(Number(clientId));
}

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 30s, 6 digits)
function base32Encode(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}
function totpSecret() {
  return base32Encode(crypto.randomBytes(20));
}
function totpBase32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.toUpperCase().replace(/=+$/, '')) {
    const idx = A.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secretB32, counter, digits = 6) {
  const key = totpBase32Decode(secretB32);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
// current TOTP step at a given time (ms)
function totpStep(nowMs, periodSec = 30) {
  return Math.floor(nowMs / 1000 / periodSec);
}
function totpCode(secretB32, nowMs = Date.now(), window = 0, periodSec = 30) {
  const step = totpStep(nowMs, periodSec);
  return hotp(secretB32, step + window);
}
// verify with a +/- window to allow clock drift; returns bool
function totpVerify(secretB32, code, window = 1, nowMs = Date.now()) {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) return false;
  for (let w = -window; w <= window; w++) {
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secretB32, nowMs, w)), Buffer.from(c))) return true;
  }
  return false;
}
function otpauthUri(issuer, account, secretB32) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// ---------------------------------------------------------------- rate limiting
// Per-IP + per-endpoint sliding window. Counts live in an in-memory map keyed
// by `${ip}:${platform}` with a timestamp; this is process-local, which is
// correct for a single-node demo and the shape the Postgres/Redis backend
// would use. Returns { limited, limit, remaining }.
const _rl = new Map();
function rateLimit(key, maxPerWindowSec, nowMs = Date.now()) {
  const win = Math.floor(nowMs / 1000);
  const bucket = _rl.get(key) || { windowStart: win, count: 0 };
  if (bucket.windowStart !== win) { bucket.windowStart = win; bucket.count = 0; }
  bucket.count += 1;
  _rl.set(key, bucket);
  return { limited: bucket.count > maxPerWindowSec, limit: maxPerWindowSec, remaining: Math.max(0, maxPerWindowSec - bucket.count + 1) };
}
// for tests only
function _resetRateLimit() { _rl.clear(); }

// Phase H: prod toggle / health signal — true when XACQORA_SECRET_KEY is set to
// a valid 32-byte key (false = the insecure dev fallback is in effect).
function keySecure() {
  return masterKey().secure;
}

module.exports = {
  encryptSecret, decryptSecret, keySecure,
  isTeam, allowedClientIds, canAccessClient, TEAM_ROLES,
  totpSecret, totpCode, totpVerify, otpauthUri,
  rateLimit, _resetRateLimit,
  _masterKeySecure: () => masterKey().secure,
};
