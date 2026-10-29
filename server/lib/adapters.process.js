// The webhook router: normalize -> find/create lead -> attach touchpoints
// -> create event(s) -> auto stage -> CAPI enqueue. All DB access goes
// through the tx wrapper from makeTx(db) (run/get/all).
const { getOrCreateLead, recordTouchpoint, findLead } = require('./identity');
const { addEvent } = require('./events');
const { ADAPTERS } = require('./adapters');

async function handleWebhook(tx, job) {
  const { platform, client_id, payload, map, dedup_key, test } = job;
  const adapter = ADAPTERS[platform];
  if (!adapter) throw new Error('no adapter for platform: ' + platform);
  const n = adapter(tx, { client_id, payload, map });
  if (!n) return;
  if (platform === 'google_sheets') {
    for (const row of n.rows || []) processRow(tx, 'google_sheets', client_id, map, row, dedup_key, test);
    return;
  }
  processRow(tx, platform, client_id, map, n, dedup_key, test);
}

function processRow(tx, platform, clientId, map, n, dedupKey, test) {
  let lead = findLead(tx, clientId, { phone: n.phone, email: n.email });
  const isNew = !lead;
  lead = getOrCreateLead(tx, clientId, {
    phone: n.phone, email: n.email, name: n.name, city: n.city,
    source_unknown: (n.phone == null && n.email == null) ? 1 : 0,
  });
  // ad-driven touchpoint (Meta Instant Forms)
  if (n.touchpoint || n.ad_id) {
    const tp = n.touchpoint || { ad_id: n.ad_id, adset_id: n.adset_id, campaign_id: n.campaign_id };
    recordTouchpoint(tx, {
      lead_id: lead.id,
      visitor_id: n.visitor_id || null,
      utm_source: tp.utm_source || null, utm_medium: tp.utm_medium || null, utm_campaign: tp.utm_campaign || null,
      ad_id: tp.ad_id || null, adset_id: tp.adset_id || null, campaign_id: tp.campaign_id || null,
      ts: n.ts,
    });
  }
  const dedup = dedupKey || (n.gateway_txn_id || n.source_ref || null);
  addEvent(tx, { lead, type: n.event_type, source_platform: platform,
    source_ref: n.gateway_txn_id || n.source_ref || null, value: n.amount, currency: n.currency,
    raw_payload: n.raw_payload, ts: n.ts, dedup_key: dedup, test });
  // gateway payment -> deal row (idempotent on gateway_txn_id)
  if (['payment_success', 'payment_failed'].includes(n.event_type) && n.gateway_txn_id) {
    const dexists = tx.get(`SELECT 1 c FROM deal WHERE gateway_txn_id=?`, n.gateway_txn_id);
    if (!dexists) {
      tx.run(`INSERT INTO deal (lead_id, client_id, product, amount, currency, gateway, gateway_txn_id, status, paid_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        lead.id, clientId, n.product, n.amount || 0, n.currency || 'INR', n.gateway || platform,
        n.gateway_txn_id, n.event_type === 'payment_success' ? 'success' : 'failed', n.ts || new Date().toISOString());
    }
  }
  if (n.event_type === 'refund' && n.gateway_txn_id) {
    const d = tx.get(`SELECT * FROM deal WHERE gateway_txn_id=?`, n.gateway_txn_id);
    if (d) tx.run(`UPDATE deal SET status='refunded', refunded_at=? WHERE id=?`, n.ts || new Date().toISOString(), d.id);
  }
  return { lead, isNew, event_skipped: false };
}

module.exports = { handleWebhook };
