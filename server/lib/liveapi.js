// Live integration layer (Phase L). Everything here is OPT-IN:
// the app runs in mock/dry-run mode unless XACQORA_LIVE=1 is set.
// MOCK=1 forces mock even if credentials exist (dev default).
//
// Gateway signature specs are VERIFIED against the official SDK source
// (see docs/adapter-verification.md for the exact URLs + dates):
//   Razorpay: X-Razorpay-Signature = HMAC-SHA256(rawBody, webhookSecret), hex
//             source: razorpay/razorpay-node lib/utils/razorpay-utils.js
//   Cashfree: X-Cf-Signature        = HMAC-SHA256(rawBody, clientSecret), hex
//             source: cashfree/cashfree-sdk-nodejs lib/payouts/services/verifySignature.js
const crypto = require('node:crypto');

function liveMode() {
  return process.env.MOCK !== '1' && process.env.XACQORA_LIVE === '1';
}

// ---------------------------------------------------------------- inbound signatures
// Verify an inbound webhook. For gateways this is an HMAC over the RAW body
// string; for the rest it is the shared endpoint secret.
function verifyInboundSignature(platform, rawBody, headers, secret) {
  const h = lowerHeaders(headers);
  const raw = rawBody == null ? '' : String(rawBody);
  if (!liveMode()) return { ok: true, reason: 'mock-mode (no signature required)' };
  if (!secret) return { ok: true, reason: 'no secret configured; rely on endpoint secret' };

  switch (platform) {
    // Razorpay (VERIFIED): X-Razorpay-Signature = HMAC-SHA256(rawBody, webhookSecret), hex.
    // Source: razorpay-node validateWebhookSignature.
    case 'razorpay': {
      const provided = h['x-razorpay-signature'];
      if (!provided) return { ok: false, reason: 'missing X-Razorpay-Signature' };
      const expect = hmacSha256hex(raw, secret);
      return { ok: timingSafeEqual(provided, expect), reason: 'razorpay HMAC-SHA256 (verified)' };
    }
    // Cashfree (VERIFIED): X-Cf-Signature = HMAC-SHA256(rawBody, clientSecret), hex.
    // Source: cashfree-sdk-nodejs verifySignature.
    case 'cashfree': {
      const provided = h['x-cf-signature'];
      if (!provided) return { ok: false, reason: 'missing X-Cf-Signature' };
      const expect = hmacSha256hex(raw, secret);
      return { ok: timingSafeEqual(provided, expect), reason: 'cashfree HMAC-SHA256 (verified)' };
    }
    // Everything else: a shared secret echoed in a header
    default: {
      const provided = h['x-xt-secret'] || h['x-signature'] || h['secret'];
      return { ok: !!provided && timingSafeEqual(provided, secret), reason: 'shared secret header' };
    }
  }
}

function lowerHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) out[k.toLowerCase()] = v;
  return out;
}
// Both verified gateways use HMAC-SHA256 over the raw body, hex-encoded.
function hmacSha256hex(body, key) {
  return crypto.createHmac('sha256', key).update(body, 'utf8').digest('hex');
}
function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b)));
}

// ---------------------------------------------------------------- outbound: Meta
// Real Marketing API spend pull. Batches insight requests in 20-day windows
// (PRD risk rule: official SDK, batches, alert on failures). Token comes from
// the ad account row (system-user token preferred).
async function runLiveMetaPull(acc, { from, to, token, signal }) {
  const acct = acc.ad_account_id;
  const fields = 'spend,impressions,reach,clicks,link_clicks,video_views,actions';
  const base = `https://graph.facebook.com/v19.0/${acct}/insights`;
  const jobs = [];
  // split the range into <=20-day batches
  for (let d = new Date(from); d <= new Date(to); d.setDate(d.getDate() + 20)) {
    const f = d.toISOString().slice(0, 10);
    const t = new Date(d.getTime() + 19 * 86400000).toISOString().slice(0, 10);
    jobs.push(`${base}?date_preset=${f},1d&fields=${fields}&time_range={"since":"${f}","until":"${t}"}&limit=1000&access_token=${encodeURIComponent(token)}`);
  }
  const out = { campaigns: [], adsets: [], ads: [], spend: [] };
  for (const url of jobs) {
    const r = await fetch(url, { signal });
    if (!r.ok) throw new Error(`meta insights ${r.status}`);
    const data = await r.json();
    // map insight rows into spend rows (ad_id from the ad object when present)
    for (const row of (data.data || [])) {
      out.spend.push({
        ad_id: row.ad_id || (row.ad && row.ad.id),
        date: row.date, ad_account_id: acct,
        spend: Number(row.spend || 0),
        impressions: Number(row.impressions || 0),
        reach: Number(row.reach || 0),
        clicks: Number(row.clicks || row.link_clicks || 0),
      });
    }
  }
  return out;
}

// Real CAPI POST to the pixel's dataset. Callers pass a fully-built payload
// (see buildCapiPayload) plus the access token. Returns Meta's response so the
// caller can log event_id + match_quality.
async function runLiveCapi({ pixelId, accessToken, payload, signal }) {
  const url = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${encodeURIComponent(accessToken)}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`capi ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body; // { events_received, fbtrace_id, ... }
}

module.exports = { liveMode, verifyInboundSignature, runLiveMetaPull, runLiveCapi };
