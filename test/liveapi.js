// Verify the live-opts-in wiring: signature check is a no-op in mock mode,
// and in live mode an HMAC-SHA512 signature is validated (Razorpay shape).
const assert = require('node:assert');

// 1) mock mode (default): no signature required even for gateways
process.env.MOCK = '1';
delete process.env.XACQORA_LIVE;
let live = require('../server/lib/liveapi');
assert.strictEqual(live.liveMode(), false, 'MOCK=1 must force mock');
let r = live.verifyInboundSignature('razorpay', '{"a":1}', {}, 'sekret');
assert.strictEqual(r.ok, true, 'mock mode skips signature');
console.log('PASS mock-mode: gateway signature not required');

// 2) live mode + correct HMAC-SHA512 (Razorpay header shape)
process.env.MOCK = '';
process.env.XACQORA_LIVE = '1';
// force re-eval so liveMode() re-reads env
delete require.cache[require.resolve('../server/lib/liveapi')];
live = require('../server/lib/liveapi');
assert.strictEqual(live.liveMode(), true, 'XACQORA_LIVE=1 enables live');

const crypto = require('node:crypto');
const secret = 'whsec_demo';
const body = JSON.stringify({ event: 'payment.captured', id: 'pay_X' });
const sig = crypto.createHmac('sha512', secret).update(body, 'utf8').digest('hex');
r = live.verifyInboundSignature('razorpay', body, { 'x-razorpay-signature': sig }, secret);
assert.strictEqual(r.ok, true, 'valid razorpay signature must pass');
console.log('PASS live-mode: valid razorpay HMAC-SHA512 accepted');

const bad = live.verifyInboundSignature('razorpay', body, { 'x-razorpay-signature': 'nope' }, secret);
assert.strictEqual(bad.ok, false, 'invalid signature must be rejected');
const missing = live.verifyInboundSignature('razorpay', body, {}, secret);
assert.strictEqual(missing.ok, false, 'missing signature header must be rejected');
console.log('PASS live-mode: invalid + missing signatures rejected');

console.log('\nLIVE-APPI GATE PASSED');
