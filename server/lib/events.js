// Central event creation: dedup, stage auto-move, CAPI enqueue.
const { makeTx } = require('../db');
const { enqueue } = require('./queue');
const { DEFAULT_STAGES, STAGE_EVENTS, autoStage, isWithinRange } = require('./shared');

function getFunnelStages(tx, clientId) {
  const f = tx.get(`SELECT * FROM funnel WHERE client_id=? ORDER BY id LIMIT 1`, clientId);
  if (!f) return DEFAULT_STAGES;
  const rows = tx.all(`SELECT name FROM funnel_stage WHERE funnel_id=? ORDER BY sort_order`, f.id);
  if (rows.length) return rows.map((r) => r.name);
  return DEFAULT_STAGES;
}

function ensureFunnel(db, clientId, name, type) {
  const tx = makeTx(db);
  let f = tx.get(`SELECT * FROM funnel WHERE client_id=? ORDER BY id LIMIT 1`, clientId);
  if (!f) {
    const info = tx.run(`INSERT INTO funnel (client_id, name, type) VALUES (?,?,?)`, clientId, name || 'Main funnel', type || 'webinar');
    f = tx.get(`SELECT * FROM funnel WHERE id=?`, Number(info.lastInsertRowid));
    for (const [i, s] of DEFAULT_STAGES.entries()) {
      tx.run(`INSERT INTO funnel_stage (funnel_id, name, sort_order) VALUES (?,?,?)`, f.id, s, i);
    }
  }
  return f;
}

// addEvent: creates an event row, auto-moves the stage (never backwards,
// except refund -> Lost), and enqueues CAPI push when the event type is
// in the client's CAPI settings. `tx` is the wrapper; db can be reached via tx.db.
function addEvent(tx, { lead, type, source_platform, source_ref, value, currency, raw_payload, ts, dedup_key }) {
  const db = tx.db;
  const clientId = lead.client_id;
  // dedup: same (lead, type, source_ref) within 1h => skip unless type allows repeats
  const repeatable = ['page_view', 'whatsapp_sent', 'whatsapp_replied', 'ad_click', 'replay_watched'];
  if (!repeatable.includes(type) && dedup_key) {
    const dup = tx.get(`SELECT id FROM event WHERE lead_id=? AND type=? AND source_ref=? ORDER BY id DESC LIMIT 1`, lead.id, type, dedup_key);
    if (dup) return { skipped: true, event: dup };
  }
  const info = tx.run(`INSERT INTO event (lead_id, type, source_platform, source_ref, value, currency, raw_payload, ts) VALUES (?,?,?,?,?,?,?,?)`,
    lead.id, type, source_platform || null, source_ref || dedup_key || null, value ?? null, currency || 'INR', raw_payload || null, ts || new Date().toISOString());
  const eventId = Number(info.lastInsertRowid);
  // auto stage move
  if (STAGE_EVENTS[type]) {
    const stages = getFunnelStages(tx, clientId);
    const target = autoStage(stages, lead.stage, type);
    if (target && target !== lead.stage) {
      tx.run(`UPDATE lead SET stage=? WHERE id=?`, target, lead.id);
      tx.run(`INSERT INTO event (lead_id, type, source_platform, raw_payload, ts) VALUES (?,?,?,?,?)`,
        lead.id, 'stage_changed', 'auto', JSON.stringify({ from: lead.stage, to: target }), new Date().toISOString());
    }
  }
  // CAPI enqueue for events we send back to Meta
  if (type === 'registered' || type === 'webinar_joined' || type === 'call_booked' || type === 'payment_success') {
    const capiTypes = tx.all(`SELECT event_types FROM capi_setting WHERE client_id=?`, clientId).map((r) => JSON.parse(r.event_types || '[]')).flat();
    const name = { registered: 'CompleteRegistration', webinar_joined: 'Attended', call_booked: 'Schedule', payment_success: 'Purchase' }[type];
    if (capiTypes.length === 0 || capiTypes.includes(name)) {
      enqueue(db, 'capi', { client_id: clientId, event_type: type, event_row_id: eventId, value, ts: ts || new Date().toISOString() });
    }
  }
  return { skipped: false, event: { id: eventId } };
}

module.exports = { addEvent, ensureFunnel, getFunnelStages };
