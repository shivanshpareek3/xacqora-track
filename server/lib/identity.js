// Identity rules: match on phone first, then email; attach anonymous
// visitor touchpoints to the lead once the form reveals who it is.
const { normPhone, normEmail } = require('./shared');

function findLead(tx, clientId, { phone, email }) {
  const p = normPhone(phone);
  const e = normEmail(email);
  let lead = null;
  if (p) lead = tx.get(`SELECT * FROM lead WHERE client_id=? AND phone=?`, clientId, p);
  if (!lead && e) lead = tx.get(`SELECT * FROM lead WHERE client_id=? AND email=?`, clientId, e);
  if (!lead && !p && !e) {
    // a sale with no phone/email still becomes a lead ("source unknown")
    lead = null;
  }
  return lead;
}

function getOrCreateLead(tx, clientId, { phone, email, name, city, source_unknown = 0, client_name = '' }) {
  const p = normPhone(phone);
  const e = normEmail(email);
  let lead = p
    ? tx.get(`SELECT * FROM lead WHERE client_id=? AND phone=?`, clientId, p)
    : null;
  if (!lead && e) lead = tx.get(`SELECT * FROM lead WHERE client_id=? AND email=?`, clientId, e);
  if (!lead) {
    const info = tx.run(`INSERT INTO lead (client_id, phone, email, name, city, owner, source_unknown) VALUES (?,?,?,?,?,?,?)`,
      clientId, p, e, name || null, city || null, null, source_unknown ? 1 : 0);
    lead = tx.get(`SELECT * FROM lead WHERE id=?`, Number(info.lastInsertRowid));
  }
  // upsert identity links
  if (p) {
    try {
      tx.run(`INSERT INTO lead_identity (link_type, link_key, lead_id) VALUES ('phone', ?, ?)`, p, lead.id);
    } catch { /* already linked */ }
  }
  if (e) {
    try {
      tx.run(`INSERT INTO lead_identity (link_type, link_key, lead_id) VALUES ('email', ?, ?)`, e, lead.id);
    } catch { /* already linked */ }
  }
  if (name && !lead.name) tx.run(`UPDATE lead SET name=? WHERE id=?`, name, lead.id);
  if (city && !lead.city) tx.run(`UPDATE lead SET city=? WHERE id=?`, city, lead.id);
  if (p && !lead.phone) {
    tx.run(`UPDATE lead SET phone=? WHERE id=?`, p, lead.id);
    tx.run(`INSERT OR IGNORE INTO lead_identity (link_type, link_key, lead_id) VALUES ('phone', ?, ?)`, p, lead.id);
  }
  if (e && !lead.email) {
    tx.run(`UPDATE lead SET email=? WHERE id=?`, e, lead.id);
    tx.run(`INSERT OR IGNORE INTO lead_identity (link_type, link_key, lead_id) VALUES ('email', ?, ?)`, e, lead.id);
  }
  return tx.get(`SELECT * FROM lead WHERE id=?`, lead.id);
}

// When a known visitor cookie fills a form, attach all earlier anonymous
// touchpoints of that visitor to the lead, and record first/last touch.
function attachVisitorTouchpoints(tx, lead, visitorId) {
  if (!visitorId) return;
  const rows = tx.all(`SELECT * FROM touchpoint WHERE visitor_id=? AND (lead_id IS NULL OR lead_id=0) ORDER BY ts`, visitorId);
  for (const r of rows) {
    tx.run(`UPDATE touchpoint SET lead_id=? WHERE id=?`, lead.id, r.id);
  }
  touchFlags(tx, lead.id, visitorId);
}
function touchFlags(tx, leadId, visitorId) {
  const all = tx.all(`SELECT * FROM touchpoint WHERE lead_id=? ORDER BY ts`, leadId);
  if (!all.length) return;
  const withAd = all.filter((x) => x.ad_id && x.ad_id !== 'unknown');
  const first = withAd[0] || all[0];
  const last = withAd[withAd.length - 1] || all[all.length - 1];
  tx.run(`UPDATE lead SET first_touch_id=?, last_touch_id=? WHERE id=?`, first.id, last.id, leadId);
}

function recordTouchpoint(tx, row) {
  // row: { client_id?, lead_id?, visitor_id, utm_source, utm_medium, utm_campaign,
  //        utm_content, utm_term, campaign_id, adset_id, ad_id, fbclid, fbc,
  //        landing_url, referrer, device, ip, ua, ts, meta_reported_conversions? }
  const ts = row.ts || new Date().toISOString();
  if (row.visitor_id) {
    tx.run(`INSERT OR IGNORE INTO visitor (id, fbp, first_seen, last_seen) VALUES (?, ?, ?, ?)`, row.visitor_id, row.fbp || null, ts, ts);
    try {
      tx.run(`UPDATE visitor SET last_seen=?, fbp=COALESCE(?, fbp) WHERE id=?`, ts, row.fbp || null, row.visitor_id);
    } catch { /* ok */ }
  }
  let info;
  if (row.lead_id) {
    // if a form-submission touchpoint carries visitor_id, resolve the lead identity
    info = tx.run(`INSERT INTO touchpoint
      (lead_id, visitor_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       campaign_id, adset_id, ad_id, fbclid, fbc, landing_url, referrer, device, ip, ua, meta_reported_conversions, ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.lead_id, row.visitor_id || null, row.utm_source || null, row.utm_medium || null, row.utm_campaign || null,
      row.utm_content || null, row.utm_term || null, row.campaign_id || null, row.adset_id || null,
      row.ad_id || null, row.fbclid || null, row.fbc || null, row.landing_url || null, row.referrer || null,
      row.device || null, row.ip || null, row.ua || null, row.meta_reported_conversions ? 1 : 0, ts);
  } else {
    info = tx.run(`INSERT INTO touchpoint
      (visitor_id, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
       campaign_id, adset_id, ad_id, fbclid, fbc, landing_url, referrer, device, ip, ua, meta_reported_conversions, ts)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      row.visitor_id, row.utm_source || null, row.utm_medium || null, row.utm_campaign || null,
      row.utm_content || null, row.utm_term || null, row.campaign_id || null, row.adset_id || null,
      row.ad_id || null, row.fbclid || null, row.fbc || null, row.landing_url || null, row.referrer || null,
      row.device || null, row.ip || null, row.ua || null, row.meta_reported_conversions ? 1 : 0, ts);
  }
  const tpId = Number(info.lastInsertRowid);
  if (row.lead_id) touchFlags(tx, row.lead_id, row.visitor_id);
  return tpId;
}

// Duplicate review: same email, different phone (and vice-versa), within a client.
function likelyDuplicates(tx, clientId) {
  const leads = tx.all(`SELECT * FROM lead WHERE client_id=?`, clientId);
  const byEmail = {};
  for (const l of leads) {
    if (!l.email) continue;
    (byEmail[l.email] = byEmail[l.email] || []).push(l);
  }
  const out = [];
  for (const [em, group] of Object.entries(byEmail)) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++)
      for (let j = i + 1; j < group.length; j++)
        if (group[i].phone !== group[j].phone)
          out.push({ a: group[i], b: group[j], email: em });
  }
  return out;
}
function mergeLeads(tx, keepId, dropId, keepPhone) {
  tx.run(`UPDATE lead SET phone=?, name=COALESCE((SELECT name FROM lead WHERE id=?), name), email=COALESCE((SELECT email FROM lead WHERE id=?), email) WHERE id=?`,
    keepPhone, dropId, dropId, keepId);
  // move everything
  for (const t of tx.all(`SELECT id FROM touchpoint WHERE lead_id=?`, dropId))
    tx.run(`UPDATE touchpoint SET lead_id=? WHERE id=?`, keepId, t.id);
  for (const ev of tx.all(`SELECT id FROM event WHERE lead_id=?`, dropId))
    tx.run(`UPDATE event SET lead_id=? WHERE id=?`, keepId, ev.id);
  for (const d of tx.all(`SELECT id, client_id FROM deal WHERE lead_id=?`, dropId))
    tx.run(`UPDATE deal SET lead_id=? WHERE id=?`, keepId, d.id);
  for (const t of tx.all(`SELECT id FROM task WHERE lead_id=?`, dropId))
    tx.run(`UPDATE task SET lead_id=? WHERE id=?`, keepId, t.id);
  for (const n of tx.all(`SELECT id FROM note WHERE lead_id=?`, dropId))
    tx.run(`UPDATE note SET lead_id=? WHERE id=?`, keepId, n.id);
  for (const c of tx.all(`SELECT id FROM call_log WHERE lead_id=?`, dropId))
    tx.run(`UPDATE call_log SET lead_id=? WHERE id=?`, keepId, c.id);
  try {
    tx.run(`INSERT OR IGNORE INTO lead_identity (link_type, link_key, lead_id) VALUES ('phone', ?, ?)`, keepPhone, keepId);
  } catch { /* ok */ }
  tx.run(`DELETE FROM lead WHERE id=?`, dropId);
  const keep = tx.get(`SELECT * FROM lead WHERE id=?`, keepId);
  touchFlags(tx, keepId, null);
  return keep;
}

module.exports = { findLead, getOrCreateLead, attachVisitorTouchpoints, recordTouchpoint, touchFlags, likelyDuplicates, mergeLeads };
