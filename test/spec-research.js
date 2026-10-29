// Re-probe script for docs/adapter-verification.md. Network required.
// Verifies gateway specs against official SDK source (authoritative), and
// re-checks the UNVERIFIED platforms against their public docs.
const get = async (u) => (await fetch(u, { redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0' } })).text();
const region = (src, marker, len = 1200) => {
  const i = src.indexOf(marker);
  return i === -1 ? `  (marker '${marker}' not found)` : '\n' + src.slice(i, i + len);
};
(async () => {
  console.log('===== RAZORPAY (lib/utils/razorpay-utils.js :: validateWebhookSignature) =====');
  console.log(region(await get('https://raw.githubusercontent.com/razorpay/razorpay-node/master/lib/utils/razorpay-utils.js'), 'validateWebhookSignature (body'));

  console.log('\n===== CASHFREE (lib/payouts/services/verifySignature.js) =====');
  console.log(region(await get('https://raw.githubusercontent.com/cashfree/cashfree-sdk-nodejs/master/lib/payouts/services/verifySignature.js'), 'verifySignature =', 900));

  console.log('\n===== UNVERIFIED PLATFORM DOCS (probe) =====');
  for (const [name, u] of [
    ['aevent', 'https://aevent.com/help/article/webhooks-72'],
    ['zoom', 'https://marketplace.zoom.us/docs/guides/webhooks/'],
    ['calendly', 'https://developer.calendly.com/docs/webhooks'],
    ['pabbly', 'https://www.pabbly.com/in/webhooks'],
    ['flexifunnels', 'https://flexifunnels.com/webhook'],
  ]) {
    try {
      const t = await get(u);
      const hits = [...new Set((t.match(/sha256|sha512|hmac|signature|x-[a-z-]+secret|apikey|webhook.?secret|secret.?key|secret/i) || []))].slice(0, 12);
      console.log(`[${name}] ${u} len=${t.length} :: ${hits.join(', ') || '(no signature keywords)'}`);
    } catch (e) { console.log(`[${name}] ${u} ERR ${e.message}`); }
  }
})();
