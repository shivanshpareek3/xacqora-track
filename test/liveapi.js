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

// ---- Calendly: a real sample-signed payload
// Spec (developer.calendly.com/api-docs/overview/webhooks/webhook-signatures):
//   header Calendly-Webhook-Signature = `t=<ts>,v1=<HMAC-SHA256(secret, ts+"."+rawBody)>`
//   The timestamp is part of the signed message and must be within tolerance.
const cdBody = JSON.stringify({ event: 'invite.created', invitee_email: 'prospect@client.com', uuid: 'inv_1' });
const cdSecret = 'calendly_webhook_secret_demo';
const cdTs = String(Math.floor(Date.now() / 1000));
const cdSig = `t=${cdTs},v1=${hmac256(cdTs + '.' + cdBody, cdSecret)}`;
r = live.verifyInboundSignature('calendly', cdBody, { 'calendly-webhook-signature': cdSig }, cdSecret);
assert.strictEqual(r.ok, true, 'valid calendly sample-signed payload must pass');
assert.ok(/calendly/i.test(r.reason), 'reason should state calendly HMAC-SHA256');
console.log('PASS calendly: real sample-signed payload (Calendly-Webhook-Signature) accepted');

// tampered body must fail
assert.strictEqual(live.verifyInboundSignature('calendly', cdBody + ' ', { 'calendly-webhook-signature': cdSig }, cdSecret).ok, false, 'tampered calendly body must fail');
// missing / malformed header must fail
assert.strictEqual(live.verifyInboundSignature('calendly', cdBody, {}, cdSecret).ok, false, 'missing Calendly-Webhook-Signature must fail');
assert.strictEqual(live.verifyInboundSignature('calendly', cdBody, { 'calendly-webhook-signature': 'garbage' }, cdSecret).ok, false, 'malformed calendly signature must fail');
// a stale timestamp (outside tolerance) must fail even if the HMAC matches
const cdStaleTs = String(Math.floor(Date.now() / 1000) - 3600);
const cdStaleSig = `t=${cdStaleTs},v1=${hmac256(cdStaleTs + '.' + cdBody, cdSecret)}`;
assert.strictEqual(live.verifyInboundSignature('calendly', cdBody, { 'calendly-webhook-signature': cdStaleSig }, cdSecret).ok, false, 'stale calendly timestamp must be rejected');
console.log('PASS calendly: tampered / missing / malformed / stale all rejected');

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

console.log('\nLIVE-API GATE PASSED (Razorpay + Cashfree + Calendly signatures, verified spec)');
