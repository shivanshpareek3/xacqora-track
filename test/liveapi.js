// Phase L: verify gateway inbound signature checks against the documented
// (official-SDK-verified) specs, with a REAL sample-signed payload for each.
//
//   Razorpay: X-Razorpay-Signature = HMAC-SHA256(rawBody, webhookSecret), hex
//   Cashfree: X-Cf-Signature        = HMAC-SHA256(rawBody, clientSecret), hex
//
// (Source URLs + verification date live in docs/adapter-verification.md.)
const assert = require('node:assert');
const crypto = require('node:crypto');

const hmac256 = (body, key) => crypto.createHmac('sha256', key).update(body, 'utf8').digest('hex');

// 1) mock mode (dev default): signature is never required
process.env.MOCK = '1';
delete process.env.XACQORA_LIVE;
let live = require('../server/lib/liveapi');
assert.strictEqual(live.liveMode(), false, 'MOCK=1 must force mock');
assert.strictEqual(live.verifyInboundSignature('razorpay', '{"a":1}', {}, 'sekret').ok, true, 'mock skips signature');
console.log('PASS mock-mode: gateway signature not required');

// 2) live mode: enable and force the module to re-eval liveMode()
process.env.MOCK = '';
process.env.XACQORA_LIVE = '1';
delete require.cache[require.resolve('../server/lib/liveapi')];
live = require('../server/lib/liveapi');
assert.strictEqual(live.liveMode(), true, 'XACQORA_LIVE=1 enables live');

// ---- Razorpay: a real sample-signed payload (raw body + computed signature)
const rzBody = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_NX9abcDEF', amount: 499900 } } } });
const rzSecret = 'whsec_rz_demo';
const rzSig = hmac256(rzBody, rzSecret); // exactly what the Razorpay SDK computes
let r = live.verifyInboundSignature('razorpay', rzBody, { 'X-Razorpay-Signature': rzSig }, rzSecret);
assert.strictEqual(r.ok, true, 'valid razorpay sample-signed payload must pass');
assert.ok(/verified/i.test(r.reason), 'reason should state it is verified');
console.log('PASS razorpay: real sample-signed payload (HMAC-SHA256) accepted');

// negative: tampered body / wrong secret / missing header
assert.strictEqual(live.verifyInboundSignature('razorpay', rzBody + ' ', { 'X-Razorpay-Signature': rzSig }, rzSecret).ok, false, 'tampered body must fail');
assert.strictEqual(live.verifyInboundSignature('razorpay', rzBody, { 'X-Razorpay-Signature': rzSig }, 'whsec_wrong').ok, false, 'wrong secret must fail');
assert.strictEqual(live.verifyInboundSignature('razorpay', rzBody, {}, rzSecret).ok, false, 'missing header must fail');
console.log('PASS razorpay: tampered body / wrong secret / missing header all rejected');

// a SHA512 signature must NOT pass now that we require SHA256 (regression guard)
const rzSigSha512 = crypto.createHmac('sha512', rzSecret).update(rzBody, 'utf8').digest('hex');
assert.strictEqual(live.verifyInboundSignature('razorpay', rzBody, { 'X-Razorpay-Signature': rzSigSha512 }, rzSecret).ok, false, 'SHA512 must be rejected');
console.log('PASS razorpay: SHA512 signature correctly rejected (spec is SHA256)');

// ---- Cashfree: a real sample-signed payload
const cfBody = JSON.stringify({ event: 'transaction_settled', payload: { transactionId: 'TXN-1', amount: 4999 } });
const cfSecret = 'cfclient_secret_demo';
const cfSig = hmac256(cfBody, cfSecret); // exactly what the Cashfree SDK computes
r = live.verifyInboundSignature('cashfree', cfBody, { 'X-Cf-Signature': cfSig }, cfSecret);
assert.strictEqual(r.ok, true, 'valid cashfree sample-signed payload must pass');
console.log('PASS cashfree: real sample-signed payload (HMAC-SHA256, X-Cf-Signature) accepted');

assert.strictEqual(live.verifyInboundSignature('cashfree', cfBody, {}, cfSecret).ok, false, 'missing X-Cf-Signature must fail');
// old (wrong) header name must no longer be trusted
assert.strictEqual(live.verifyInboundSignature('cashfree', cfBody, { 'x-cashfree-signature': cfSig }, cfSecret).ok, false, 'legacy header must be ignored');
console.log('PASS cashfree: missing header + legacy header name rejected');

console.log('\nLIVE-API GATE PASSED (Razorpay + Cashfree signatures, verified spec)');
