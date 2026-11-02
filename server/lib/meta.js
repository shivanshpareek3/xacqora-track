// Meta: scheduled ad account pull (spend + entities) and CAPI push with dedup.
// Live Meta API calls happen here; when no token / no network, the mock
// generator in shared.js stands in so the demo end-to-end still works.
// Mock vs live is decided by lib/liveapi.liveMode() (MOCK=1 forces mock).
const { makeTx } = require('../db');
const { mockMetaPull, capiHashedPhone, capiHashedEmail, buildCapiPayload, sha256 } = require('./shared');
const live = require('./liveapi');
const sec = require('./security');

function getFxRate(tx, date, currency) {
  const r = tx.get(`SELECT inr_per_unit FROM fx_rate WHERE date=? AND currency=?`, date, currency);
  return r ? r.inr_per_unit : 1;
}
// S.2: meta tokens are encrypted at rest; decrypt for use only.
function plainToken(stored) {
  return sec.decryptSecret(stored || '');
}

// Run a Meta pull for one ad account. In production this calls
// /act/{id}/insights with extended_result set; the mock returns synthetic rows.
async function runMetaPull(tx, payload) {
  const { ad_account_id } = payload;
  const acc = tx.get(`SELECT * FROM meta_ad_account WHERE ad_account_id=?`, ad_account_id);
  if (!acc) return;
  const now = new Date().toISOString();
  const token = plainToken(acc.token);
  const useMock = !live.liveMode() || !token || token === 'MOCK';

  if (useMock) {
    const data = mockMetaPull([{ ad_account_id, name: acc.name }]);
    upsertEntities(tx, ad_account_id, data);
    upsertSpend(tx, ad_account_id, data.spend);
    tx.run(`UPDATE meta_ad_account SET last_pull_at=? WHERE ad_account_id=?`, now, ad_account_id);
    return;
  }

  // live: batched Marketing API pull over the last 7 days
  try {
    const to = new Date(now);
    const from = new Date(Date.now() - 6 * 86400000);
    const data = await live.runLiveMetaPull({ ad_account_id }, { from, to, token });
    upsertEntities(tx, ad_account_id, data);
    upsertSpend(tx, ad_account_id, data.spend);
    tx.run(`UPDATE meta_ad_account SET last_pull_at=?, last_error=NULL WHERE ad_account_id=?`, now, ad_account_id);
  } catch (e) {
    // PRD risk rule: alert on failures
    console.error('[meta] live pull failed for', ad_account_id, e.message);
    tx.run(`UPDATE meta_ad_account SET last_error=? WHERE ad_account_id=?`, String(e.message).slice(0, 300), ad_account_id);
  }
}

function upsertEntities(tx, adAccount, data) {
  for (const c of data.campaigns) tx.run(`INSERT INTO meta_campaign (id, ad_account_id, name, status) VALUES (?,?,?,?) ON CONFLICT(id) DO NOTHING`, c.id, adAccount, c.name, c.status);
  for (const a of data.adsets) tx.run(`INSERT INTO meta_adset (id, ad_account_id, campaign_id, name, status) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING`, a.id, adAccount, a.campaign_id, a.name, 'ACTIVE');
  for (const ad of data.ads) tx.run(`INSERT INTO meta_ad (id, ad_account_id, adset_id, name, status, creative_img) VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status, creative_img=excluded.creative_img`,
    ad.id, adAccount, ad.adset_id, ad.name, ad.status, ad.creative_img || null);
}

function upsertSpend(tx, adAccount, rows) {
  for (const r of rows) {
    const fx = getFxRate(tx, r.date, 'INR');
    const inr = (r.spend || 0) * fx;
    tx.run(`INSERT INTO spend_daily (ad_id, date, ad_account_id, spend, spend_inr, impressions, reach, clicks, currency)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(ad_id, date, ad_account_id) DO UPDATE SET
        spend=excluded.spend, spend_inr=excluded.spend_inr,
        impressions=excluded.impressions, reach=excluded.reach, clicks=excluded.clicks`,
      r.ad_id, r.date, adAccount, r.spend || 0, inr, r.impressions || 0, r.reach || 0, r.clicks || 0, 'INR');
  }
}

// ---------------------------------------------------------------- CAPI
// Sends a lead event back to Meta. event_id is deterministic so the browser
// pixel and CAPI never double-count.
async function pushCapiEvent(tx, payload) {
  const { client_id, event_type, event_row_id } = payload;
  const ev = tx.get(`SELECT * FROM event WHERE id=?`, event_row_id);
  if (!ev) return;
  const lead = tx.get(`SELECT * FROM lead WHERE id=?`, ev.lead_id);
  if (!lead) return;
  // rules: never resend; skip Purchase when lead has an active refund
  const refunded = tx.get(`SELECT 1 FROM deal WHERE lead_id=? AND status='refunded'`, lead.id);
  if (event_type === 'payment_success' && refunded) {
    tx.run(`UPDATE event SET sent_to_meta=2 WHERE id=?`, ev.id); // 2 = suppressed
    return;
  }
  const settings = tx.get(`SELECT * FROM settings WHERE key='capi'`);
  const dryRun = !settings || settings.value !== 'live';
  const fbc = tx.get(`SELECT fbc FROM touchpoint WHERE lead_id=? AND fbc IS NOT NULL ORDER BY ts DESC LIMIT 1`, lead.id)?.fbc;
  const fbp = tx.get(`SELECT fbp FROM visitor WHERE id IN (SELECT visitor_id FROM touchpoint WHERE lead_id=? AND visitor_id IS NOT NULL) ORDER BY last_seen DESC LIMIT 1`, lead.id)?.fbp;
  const externalId = tx.get(`SELECT link_key FROM lead_identity WHERE lead_id=? AND link_type='email' LIMIT 1`, lead.id)?.link_key;
  const value = ev.value != null ? ev.value : null;
  const eventId = sha256(`capi|${client_id}|${event_type}|${ev.lead_id}|${event_row_id}`);
  const eventName = { registered: 'CompleteRegistration', webinar_joined: 'Attended', call_booked: 'Schedule', payment_success: 'Purchase' }[event_type] || event_type;
  const payloadObj = buildCapiPayload({
    client: client_id,
    eventName,
    hashedPhone: capiHashedPhone(lead.phone),
    hashedEmail: capiHashedEmail(lead.email),
    eventTime: Math.floor(Date.parse(ev.ts) / 1000),
    value, currency: ev.currency || 'INR',
    fbc, fbp, externalId,
    eventId,
  });
  const accRow = tx.get(`SELECT * FROM meta_ad_account WHERE client_id=? AND status='connected' ORDER BY id LIMIT 1`, client_id);
  const pixelId = accRow ? (tx.get(`SELECT pixel_id FROM meta_ad_account WHERE ad_account_id=?`, accRow.ad_account_id)?.pixel_id) : 'PIXEL-1';
  const capiToken = accRow ? plainToken(accRow.token) : '';
  const dryRunFinal = dryRun || !live.liveMode() || !capiToken || capiToken === 'MOCK';
  const log = {
    event_row_id: ev.id, event_name: eventName, pixel_id: pixelId,
    dry_run: dryRunFinal, payload: JSON.stringify(payloadObj),
    event_id: eventId,
    match_quality: (lead.phone ? 8 : 4) + (lead.email ? 1 : 0), // mock estimate: 7-9 when phone+email
    sent_at: new Date().toISOString(),
  };
  tx.run(`INSERT INTO capi_log (event_row_id, event_name, pixel_id, dry_run, payload, event_id, match_quality, sent_at) VALUES (?,?,?,?,?,?,?,?)`,
    ev.id, eventName, pixelId, dryRunFinal ? 1 : 0, log.payload, eventId, log.match_quality, log.sent_at);
  tx.run(`UPDATE event SET sent_to_meta=1, meta_event_id=?, meta_match_quality=? WHERE id=?`, eventId, log.match_quality, ev.id);
  if (dryRunFinal) return;
  // live CAPI POST (real token required); PRD rules already enforced above:
  // never sent twice (event_id), Purchase suppressed for refunded payments.
  try {
    const resp = await live.runLiveCapi({ pixelId, accessToken: capiToken, payload: payloadObj });
    // record Meta's real match quality when it returns one
    const mq = resp && resp.events_received && resp.events_received[0] ? resp.events_received[0].event_time : null;
    if (mq) tx.run(`UPDATE capi_log SET match_quality=? WHERE event_row_id=?`, mq, ev.id);
  } catch (e) {
    console.error('[capi] live push failed:', e.message);
    // keep the event enqueued for retry by marking it unsent
    tx.run(`UPDATE event SET sent_to_meta=0 WHERE id=?`, ev.id);
  }
}

// add capi_log table (created lazily). SQLite only — on Postgres the table
// ships in schema.pg.sql and the PG DDL is not valid SQLite, and vice-versa.
function ensureCapiLogTable(db) {
  if (db.engine === 'pg') return;
  db.exec(`CREATE TABLE IF NOT EXISTS capi_log (
    id INTEGER PRIMARY KEY, event_row_id INTEGER NOT NULL, event_name TEXT, pixel_id TEXT,
    dry_run INTEGER DEFAULT 1, payload TEXT, event_id TEXT, match_quality INTEGER, sent_at TEXT
  )`);
}

module.exports = { runMetaPull, pushCapiEvent, ensureCapiLogTable };
