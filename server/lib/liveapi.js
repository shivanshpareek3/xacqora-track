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
// Real Marketing API pull. Two parts:
//   1. the ad tree (campaigns/adsets/ads) so Reports shows real ad names
//   2. per-AD DAILY insights (level=ad) — the account-level query returns NO
//      per-ad breakdown, and spend_daily.ad_id is NOT NULL, so ad-level is
//      required.
// v19.0 insights `spend` comes back in CURRENCY UNITS, verified live: the
// 7-day aggregate and the same 7 days summed from daily rows both read 9.72
// for act_1377451727314532 (probe tmp/probe-meta.js), not 9.72e-6. Do NOT
// divide by 1e6 — that is what breaks the ≤1% spend gate.
async function graphGet(path, params, token, signal) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null) q.set(k, String(v));
  q.set('access_token', token);
  const url = `https://graph.facebook.com/v19.0${path}?` + q.toString();
  const r = await fetch(url, { signal });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`meta ${path} ${r.status}: ${String(body.error && body.error.message || '').slice(0, 200)}`);
  return body;
}
// follow a Marketing API paging cursor (bounded) — insights can exceed one page
async function graphGetAll(path, params, token, signal, maxPages = 5) {
  const first = await graphGet(path, params, token, signal);
  const out = [...(first.data || [])];
  let p = first.paging;
  let i = 1;
  while (p && p.next && i < maxPages) {
    // the `next` URL carries the full query incl. token; fetch and keep going
    const r = await fetch(p.next, { signal });
    if (!r.ok) break;
    const j = await r.json().catch(() => ({}));
    out.push(...(j.data || []));
    p = j.paging; i++;
  }
  return out;
}
// Insights `spend` (v19.0) is in CURRENCY UNITS, not microcurrency — verified
// live: 7-day aggregate and the daily rows both sum to 9.72 for
// act_1377451727314532 (tmp/probe-meta.js). Dividing by 1e6 would store
// near-zero and defeat the ≤1% spend gate, so it is passed through as-is.
function insightSpend(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
// one insights row (level=ad) -> a spend_daily row. ad_id + date mandatory
// (both NOT NULL); a row missing either is skipped, not faked. Daily
// time_increment rows carry `date_start`/`date_stop` (equal), not `date`.
function mapInsightRow(row, acct) {
  if (!row || !row.ad_id) return null;
  const date = row.date_start || row.date_stop || row.date;
  if (!date) return null;
  return {
    ad_id: String(row.ad_id),
    date,
    ad_account_id: acct,
    spend: insightSpend(row.spend),          // currency units (verified live)
    impressions: Number(row.impressions) || 0,
    reach: Number(row.reach) || 0,
    clicks: Number(row.clicks) || 0,
    conversions: Number(row.conversions ?? row.quality_conversions ?? 0),
  };
}
// map the ad tree into the upsertEntities() shapes shared.js/mock also use
function mapAdTree(campaigns, adsets, ads) {
  return {
    campaigns: campaigns.map((c) => ({ id: String(c.id), name: c.name, status: c.status })),
    adsets: adsets.map((a) => ({ id: String(a.id), campaign_id: String((a.campaign && a.campaign.id) || a.campaign_id || ''), name: a.name, status: a.status })),
    ads: ads.map((a) => ({ id: String(a.id), adset_id: String(a.adset_id || ''), name: a.name, status: a.status, creative_img: a.creative ? 'CR-' + a.creative.id : null })),
  };
}
async function runLiveMetaPull(acc, { from, to, token, signal }) {
  const acct = acc.ad_account_id;
  // ad tree: the report needs real campaign/adset/ad names, not just totals
  let tree;
  try {
    const [cams, ads] = await Promise.all([
      graphGetAll(`/${acct}/campaigns`, { fields: 'id,name,status', limit: 250 }, token, signal),
      graphGetAll(`/${acct}/ads`, { fields: 'id,name,status,adset_id,creative', limit: 250 }, token, signal),
    ]);
    const adsetIds = [...new Set(ads.map((a) => a.adset_id).filter(Boolean))];
    const adsets = [];
    // adsets in chunks of 50 ids (the API caps the `filter` values per call)
    for (let i = 0; i < adsetIds.length; i += 50) {
      const chunk = adsetIds.slice(i, i + 50).join(',');
      const rows = await graphGetAll(`/${acct}/adsets`,
        { fields: 'id,name,status,campaign.id', limit: 250, filter: JSON.stringify([{ field: 'id', operator: 'IN', value: chunk }]) },
        token, signal);
      adsets.push(...rows);
    }
    tree = mapAdTree(cams, adsets, ads);
  } catch (e) {
    // a tree failure (e.g. an account with no entities) should not sink the
    // spend pull — alert, keep going
    console.error('[meta] ad-tree pull failed for', acct, '—', e.message);
    tree = { campaigns: [], adsets: [], ads: [] };
  }
  // Per-ad DAILY insights, CURRENCY UNITS (verified live, see insightSpend).
  // `time_range` + `time_increment: 1` returns one row per day; each row
  // carries `date_start`/`date_stop` (a bare time_range has no date, and
  // spend_daily.date is NOT NULL). At level=ad the `ad` and
  // `quality_conversions` fields are invalid (#100), so don't request them.
  const timeRange = JSON.stringify({ since: from, until: to });
  const fields = 'ad_id,spend,impressions,reach,clicks,conversions';
  const rows = await graphGetAll(`/${acct}/insights`,
    { level: 'ad', fields, time_range: timeRange, time_increment: 1, limit: 250 }, token, signal);
  const spend = rows.map((r) => mapInsightRow(r, acct)).filter(Boolean);
  return { campaigns: tree.campaigns, adsets: tree.adsets, ads: tree.ads, spend };
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
