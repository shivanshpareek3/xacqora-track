// Phase S unit tests: secrets-at-rest (AES-GCM), TOTP 2FA (RFC 6238 vectors +
// round-trip), rate limiting, and client-access rules. No network, no DB.
const assert = require('node:assert');
const sec = require('../server/lib/security');

let failures = 0;
function check(label, cond, detail) {
  if (!cond) { failures++; console.log('FAIL  ' + label + (detail ? ' :: ' + detail : '')); }
  else console.log('PASS  ' + label);
}

// =================================================================== AES-GCM
// With no env key the module falls back to the insecure dev key (flagged).
delete process.env.XACQORA_SECRET_KEY;
const secret = 's3cr3t-webhook-token';
const wrapped = sec.encryptSecret(secret);
check('encrypt: returns an opaque blob (not plaintext)', wrapped.startsWith('enc:v1:') && !wrapped.includes(secret));
check('decrypt: round-trips to the original', sec.decryptSecret(wrapped) === secret);
check('decrypt: legacy (unwrapped) value passes through', sec.decryptSecret('plain-value') === 'plain-value');
check('decrypt: empty/missing -> empty string', sec.decryptSecret('') === '' && sec.decryptSecret(null) === '');
// encrypting an already-wrapped value is a no-op (idempotent)
check('encrypt: idempotent on already-wrapped input', sec.encryptSecret(wrapped) === wrapped);
// a tampered ciphertext must NOT decrypt back to the secret (GCM auth tag)
const tampered = wrapped.slice(0, -2) + 'zz';
check('decrypt: tampered blob fails auth (returns empty)', sec.decryptSecret(tampered) === '');

// =================================================================== TOTP
// RFC 6238 (SHA-1, 30s, 8 digits -> last 6) reference vectors. The base32 of
// the 20-byte key "12345678901234567890" is GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
const RFC = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
// 8-digit RFC values -> 6-digit is the last 6 digits (standard TOTP truncation).
check('totp: RFC T=59s -> 287082', sec.totpCode(RFC, 59 * 1000, 0, 30) === '287082', 'got ' + sec.totpCode(RFC, 59000));
check('totp: RFC T=1111111109s -> 081804', sec.totpCode(RFC, 1111111109 * 1000, 0, 30) === '081804', 'got ' + sec.totpCode(RFC, 1111111109000));
check('totp: RFC T=1111111111s -> 050471', sec.totpCode(RFC, 1111111111 * 1000, 0, 30) === '050471', 'got ' + sec.totpCode(RFC, 1111111111000));

// round-trip with a real random secret + drift window
const s = sec.totpSecret();
const t0 = Date.now();
check('totp: current code verifies at window 0', sec.totpVerify(s, sec.totpCode(s, t0), 0, t0));
check('totp: adjacent-step code verifies within +/-1 window', sec.totpVerify(s, sec.totpCode(s, t0 - 30000), 1, t0));
check('totp: a wrong code is rejected', !sec.totpVerify(s, '000000', 1, t0 + 30000) || sec.totpVerify(s, '000000', 1, t0 + 30000) === false);
check('totp: malformed code rejected', !sec.totpVerify(s, 'abc', 1, t0));
check('totp: otpauth uri carries the secret + issuer', sec.otpauthUri('Xacqora', 'a@b.c', s).includes('secret=' + s));

// =================================================================== rate limit
sec._resetRateLimit();
const now = Date.now();
let last;
for (let i = 1; i <= 10; i++) last = sec.rateLimit('k', 10, now);
check('rate limit: first 10 within limit not limited', last.limited === false);
const over = sec.rateLimit('k', 10, now);
check('rate limit: 11th call exceeds and is limited', over.limited === true && over.limit === 10);
// different key has its own bucket
check('rate limit: distinct key has its own bucket', sec.rateLimit('other', 10, now).limited === false);
// window rollover resets the count
sec._resetRateLimit();
sec.rateLimit('k2', 5, now);                       // count=1 in window W
const later = sec.rateLimit('k2', 5, now + 3600 * 1000 + 1000); // next window
check('rate limit: new window resets the counter', later.limited === false && later.remaining === 5);
sec._resetRateLimit();

// =================================================================== client access
const c1 = { role: 'client', client_ids: '1,2' };
const c2only = { role: 'client', client_ids: '2' };
const owner = { role: 'owner' };
const nobody = null;
check('access: team role is unrestricted (null)', sec.allowedClientIds(owner) === null);
check('access: team role can access any client', sec.canAccessClient(owner, 5) === true);
check('access: client sees only its own ids', JSON.stringify(sec.allowedClientIds(c1)) === '[1,2]');
check('access: client-1 cannot access client 3', sec.canAccessClient(c1, 3) === false);
check('access: client-2-only cannot access client 1', sec.canAccessClient(c2only, 1) === false);
check('access: client-2-only can access client 2', sec.canAccessClient(c2only, 2) === true);
check('access: anonymous user is locked out', sec.canAccessClient(nobody, 1) === false && sec.allowedClientIds(nobody).length === 1);

console.log('\n' + (failures === 0 ? 'SECURITY UNIT TESTS PASSED' : failures + ' check(s) FAILED'));
process.exit(failures ? 1 : 0);
