// Phase G — pilot gates tooling (fast-track, MASTER v5 §1).
// Everything here runs on fake/pilot-mock data and is exercised by
// test/gates.js on BOTH engines. Four groups:
//   1. CSV import of old leads — column mapping + E.164 normalisation + duplicate skip
//   2. Ad URL checker — where {{ad.id}}/{{adset.id}}/{{campaign.id}}/fbclid are missing
//   3. Gate assertions — state checks over the current DB (runGates)
//   4. Accuracy checkers — pilot month: gateway revenue, Meta spend, CAPI quality,
//      weekly-report timing (all driven by exports the human pastes in)
const { normPhone, normEmail } = require('./shared');

// ---------------------------------------------------------------- CSV parsing
// Quoted-field aware (cells may contain commas and doubled quotes).
function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { header: [], rows: [] };
  const parseLine = (line) => {
    const out = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  };
  const header = parseLine(lines[0]).map((h) => h.trim());
  const rows = lines.slice(1).map((l) => {
    const vals = parseLine(l);
    const row = {};
    header.forEach((h, i) => { row[h] = vals[i] != null ? String(vals[i]).trim() : null; });
    return row;
  });
  return { header, rows };
}

// Column mapping: { <source-header>: target-field-or-ignore }
const IMPORT_FIELDS = ['name', 'phone', 'email', 'city', 'stage', 'amount', 'registered', 'attended', 'paid_at', 'refund'];
function normMapping(raw) {
  const m = {};
  for (const [k, v] of Object.entries(raw || {})) {
    const v2 = String(v || '').trim().toLowerCase();
    if (v2 && v2 !== 'ignore' && IMPORT_FIELDS.includes(v2)) m[String(k).trim()] = v2;
  }
  return m;
}
// Infer a mapping from a CSV header row when the importer did not pick one.
// The input `headerRow` is the array of source column names; returns
// { <source-header>: target-field }.
function inferMapping(headerRow) {
  const cols = headerRow.map((h) => String(h).trim()).filter(Boolean);
  const lc = (c) => c.toLowerCase();
  const by = (field, kw, exact = false) => {
    const hit = cols.find((c) => (exact ? lc(c) === kw : lc(c).includes(kw)));
    if (hit) return hit;
    return null;
  };
  const m = {};
  const set = (field, col) => { if (col) m[col] = field; };
  set('name', by('name', 'full name', true) || by('name', 'name') || by('name', 'first name'));
  set('phone', by('phone', 'mobile') || by('phone', 'phone'));
  set('email', by('email', 'email'));
  set('city', by('city', 'city'));
  set('stage', by('stage', 'status') || by('stage', 'stage'));
  set('amount', by('amount', 'amount') || by('amount', 'price'));
  set('registered', by('registered', 'registered'));
  set('attended', by('attended', 'attended'));
  set('paid_at', by('paid_at', 'paid'));
  set('refund', by('refund', 'refund'));
  return m;
}

// ---------------------------------------------------------------- 1. CSV import of old leads
// Map the client's columns, normalise phones to E.164 (India +91), skip rows
// that duplicate an existing lead (phone-first identity match), backfill a
// deal + payment_success event for amount columns, and record registered/
// attended flags as events. Idempotent: re-importing the same file matches,
// never double-counts revenue.
function importOldLeads(tx, clientId, { csv, mapping }) {
  const { header, rows } = parseCsv(csv);
  // an explicit mapping (screen form) wins; otherwise infer it from the header row
  const explicit = normMapping(mapping);
  const map = Object.keys(explicit).length ? explicit : inferMapping(header);
  const res = { imported: 0, matched: 0, skipped: 0, errors: [], deals: 0 };
  rows.forEach((row, i) => {
    const pick = (f) => {
      for (const [src, tgt] of Object.entries(map)) if (tgt === f) { const v = row[src]; return v != null && v !== '' ? v : null; }
      return null;
    };
    const phoneRaw = pick('phone');
    const emailRaw = pick('email');
    const phone = normPhone(phoneRaw);
    const email = normEmail(emailRaw);
    // keep raw values visible when they don't normalise (client may import
    // overseas numbers later — never silently drop the digit string)
    const identity = {
      phone: phone || (phoneRaw ? String(phoneRaw).trim() : null),
      email: email,
      name: pick('name'),
      city: pick('city'),
      source_unknown: !(phone || email) ? 1 : 0,
    };
    // duplicate skip: match by E.164 phone first, then normalised email
    const existing = phone
      ? tx.get(`SELECT id FROM lead WHERE client_id=? AND phone=?`, clientId, phone)
      : null;
    const existing2 = existing || (email ? tx.get(`SELECT id FROM lead WHERE client_id=? AND email=?`, clientId, email) : null);
    let lead = existing2;
    if (lead) { res.matched++; }
    else {
      // a row with no usable identity at all is skipped (not a lead)
      if (!identity.name && !identity.phone && !identity.email) { res.skipped++; res.errors.push('row ' + (i + 1) + ': no name/phone/email'); return; }
      const info = tx.run(`INSERT INTO lead (client_id, phone, email, name, city, source_unknown) VALUES (?,?,?,?,?,?) RETURNING id`,
        clientId, identity.phone, identity.email, identity.name, identity.city, identity.source_unknown ? 1 : 0);
      lead = { id: Number(info.lastInsertRowid), stage: 'New' };
      res.imported++;
    }
    const lid = lead.id;
    // backfill stage when given
    if (pick('stage')) tx.run(`UPDATE lead SET stage=? WHERE id=?`, pick('stage'), lid);
    // backfill revenue — idempotent on a csv deal for this lead. A refund
    // flag creates the deal then marks it refunded, so it surfaces in the
    // funnel's refunded bucket instead of vanishing (net revenue = 0).
    const amount = Number(pick('amount')) || 0;
    if (amount > 0) {
      const hasDeal = tx.get(`SELECT 1 c FROM deal WHERE lead_id=? AND gateway='csv'`, lid);
      if (!hasDeal) {
        tx.run(`INSERT INTO deal (lead_id, client_id, amount, gateway, gateway_txn_id, status, paid_at) VALUES (?,?,?,?,?,?,?)`,
          lid, clientId, amount, 'csv', 'CSV-IMP-' + lid, 'success', pick('paid_at') || new Date().toISOString());
        res.deals++;
      }
      if (pick('refund')) {
        const d = tx.get(`SELECT * FROM deal WHERE lead_id=? AND gateway='csv'`, lid);
        if (d && d.status !== 'refunded') {
          tx.run(`UPDATE deal SET status='refunded', refunded_at=? WHERE id=?`, pick('paid_at') || new Date().toISOString(), d.id);
        }
      }
    }
    if (pick('registered')) {
      tx.run(`INSERT INTO event (lead_id, type, source_platform, source_ref, ts) VALUES (?,?,?,?,?)`,
        lid, 'registered', 'csv', 'csvreg|' + lid, new Date().toISOString());
    }
    if (pick('attended')) {
      tx.run(`INSERT INTO event (lead_id, type, source_platform, source_ref, ts) VALUES (?,?,?,?,?)`,
        lid, 'webinar_joined', 'csv', 'csvatt|' + lid, new Date().toISOString());
    }
    // refresh the stage auto-move for a backfilled paid lead
    if (amount > 0 && !pick('refund')) tx.run(`UPDATE lead SET stage='Paid' WHERE id=?`, lid);
  });
  return res;
}

// ---------------------------------------------------------------- 2. Ad URL checker
// Paste a pilot ad destination URL -> report where the attribution tokens are
// missing. Meta replaces {{…}} before the click; if the destination has no
// ad token the lead lands with no ad_id (the G1 gate will fail for it).
const URL_TOKENS = [
  { key: 'ad', label: '{{ad.id}} / ad_id', test: (s) => /\{\{\s*ad\.id\s*}\}|ad_?id\s*=/i.test(s),
    severity: 'error', note: 'missing — leads from this ad will have NO ad_id (cannot attribute a sale to the ad).' },
  { key: 'adset', label: '{{adset.id}} / adset_id', test: (s) => /\{\{\s*adset\.id\s*}\}|adset_?id\s*=/i.test(s),
    severity: 'warn', note: 'missing — ad-set level attribution unavailable.' },
  { key: 'campaign', label: '{{campaign.id}} / campaign_id', test: (s) => /\{\{\s*campaign\.id\s*}\}|campaign_?id\s*=/i.test(s),
    severity: 'warn', note: 'missing — campaign level attribution unavailable.' },
  { key: 'fbclid', label: 'fbclid', test: (s) => /fbclid/i.test(s),
    severity: 'info', note: 'Meta auto-appends ?fbclid= on paid clicks, so this is informational (keep it in Google URLs for pixel fallback).' },
];
const URL_UTMS = ['utm_source', 'utm_medium', 'utm_campaign'];

function checkAdUrl(url) {
  const s = String(url || '').trim();
  const out = { url: s, ok: true, findings: [], utms: {} };
  if (!s) { out.ok = false; out.findings.push({ item: 'url', severity: 'error', present: false, note: 'empty URL' }); return out; }
  let host = '';
  try { host = new URL(s.startsWith('http') ? s : 'https://' + s).host; } catch { /* keep raw */ }
  out.host = host;
  for (const t of URL_TOKENS) {
    const present = t.test(s);
    out.findings.push({ item: t.label, present, severity: t.severity, note: present ? 'present' : t.note });
    if (!present && t.severity === 'error') out.ok = false;
  }
  for (const u of URL_UTMS) out.utms[u] = new RegExp(u, 'i').test(s);
  out.utm_missing = URL_UTMS.filter((u) => !out.utms[u]);
  return out;
}

// ---------------------------------------------------------------- 3. Gate assertions
// State checks over the current DB — pass/fail + the numbers behind each.
function runGates(tx) {
  const gates = [];

  // G1 — Instant Form leads land with an ad_id within 1 minute (100% coverage
  // of meta_leadgen leads + no webhook job still pending past the tick window)
  const ifl = tx.all(`SELECT e.lead_id,
      (SELECT 1 c FROM touchpoint t WHERE t.lead_id=e.lead_id AND t.ad_id IS NOT NULL AND t.ad_id NOT IN ('','unknown') LIMIT 1) has_ad
    FROM event e WHERE e.type='meta_form_lead' AND e.source_platform='meta_leadgen'`);
  const iflTotal = ifl.length;
  const iflWithAd = ifl.filter((r) => r.has_ad).length;
  // overdue = next_run_at in the past by >60s (epoch column, engine-agnostic)
  const slowJobs = tx.get(`SELECT COUNT(*) c FROM job WHERE queue_name='webhook' AND status='pending' AND next_run_at < ?`,
    Math.floor(Date.now() / 1000) - 60).c;
  gates.push({
    id: 'G1', name: 'Instant Form lead lands with ad_id within 1 min (100%)',
    pass: (iflTotal === 0 || iflWithAd === iflTotal) && slowJobs === 0,
    detail: (iflTotal === 0 ? 'no meta_leadgen leads yet (vacuously green — seed one in pilot week 1)'
      : iflWithAd + '/' + iflTotal + ' have an ad_id touchpoint') + '; ' + slowJobs + ' webhook job(s) pending >1min',
  });

  // G2 — landing leads: ad_id/UTM coverage ≥ 95%
  const landing = tx.all(`SELECT l.id,
      MAX(CASE WHEN t.ad_id IS NOT NULL AND t.ad_id NOT IN ('','unknown') THEN 1 ELSE 0 END) has_ad,
      MAX(CASE WHEN t.utm_campaign IS NOT NULL AND t.utm_campaign != '' THEN 1 ELSE 0 END) has_utm
    FROM lead l JOIN touchpoint t ON t.lead_id=l.id
    GROUP BY l.id`);
  const covered = landing.filter((r) => r.has_ad || r.has_utm).length;
  const covPct = landing.length ? covered / landing.length : 1;
  gates.push({
    id: 'G2', name: 'Landing leads ad_id/UTM coverage ≥ 95%',
    pass: covPct >= 0.95,
    detail: (landing.length ? Math.round(covPct * 100) : 100) + '% of ' + landing.length + ' landing leads carry an ad_id or UTM campaign',
  });

  // G3 — same person, two forms = one lead (no phone-duplicate leads)
  const dups = tx.get(`SELECT COUNT(*) c FROM (
      SELECT phone FROM lead WHERE phone IS NOT NULL AND phone != '' GROUP BY phone HAVING COUNT(DISTINCT id) > 1)`).c;
  gates.push({
    id: 'G3', name: 'Same person two forms = one lead',
    pass: dups === 0,
    detail: dups === 0 ? 'no phone-duplicate leads' : dups + ' phone numbers backing >1 lead (run Duplicates)',
  });

  // G4 — webhook queue age: zero unprocessed events older than 10 minutes.
  // The pending webhook WORK lives in the job table; next_run_at is epoch
  // seconds (set identically by enqueue() on both engines), so this is the
  // portable, engine-agnostic queue-age signal. (webhook_log timestamps are
  // display-format and differ per engine, so the gate keys off the job table.)
  const staleJobs = tx.get(`SELECT COUNT(*) c FROM job
      WHERE queue_name='webhook' AND status='pending' AND next_run_at < ?`,
    Math.floor(Date.now() / 1000) - 600).c;
  const queuedLog = tx.get(`SELECT COUNT(*) c FROM webhook_log WHERE status IN ('received','queued')`).c;
  gates.push({
    id: 'G4', name: 'Webhook log: 0 unprocessed events > 10 min',
    pass: staleJobs === 0,
    detail: staleJobs + ' webhook job(s) pending >10min; ' + queuedLog + ' still queued in the log',
  });

  return { gates, pass: gates.every((g) => g.pass) };
}

// ---------------------------------------------------------------- 4. Accuracy checkers
// Pilot month: the human pastes gateway settlements + the Meta Ads Manager
// spend export; the checkers compare them to what the system counted.

// 4a. our net revenue vs gateway settlements (≤ 2% diff)
function revenueVsGateways(tx, { externalTotal, gateway = null, periodDays = 30 }) {
  const since = new Date(Date.now() - Number(periodDays) * 86400000).toISOString();
  const q = `SELECT COALESCE(SUM(amount),0) our_total, COUNT(*) n FROM deal
    WHERE status='success' AND refunded_at IS NULL AND paid_at >= ?` + (gateway ? ` AND gateway=?` : '');
  const args = [since];
  if (gateway) args.push(gateway);
  const our = tx.get(q, ...args).our_total;
  const ext = Number(externalTotal || 0);
  const diff = ext ? Math.abs(our - ext) / ext : (our > 0 ? 1 : 0);
  return { our_total: our, external_total: ext, diff_pct: Math.round(diff * 10000) / 100, pass: diff <= 0.02, threshold: '2%' };
}

// 4b. our tracked spend vs the Meta Ads Manager export (≤ 1% diff)
function spendVsMeta(tx, { externalTotal, periodDays = 30 }) {
  const since = new Date(Date.now() - Number(periodDays) * 86400000).toISOString();
  const our = tx.get(`SELECT COALESCE(SUM(spend_inr),0) t FROM spend_daily WHERE date >= ?`, since.slice(0, 10)).t;
  const ext = Number(externalTotal || 0);
  const diff = ext ? Math.abs(our - ext) / ext : (our > 0 ? 1 : 0);
  return { our_total: our, external_total: ext, diff_pct: Math.round(diff * 10000) / 100, pass: diff <= 0.01, threshold: '1%' };
}

// 4c. CAPI match quality ≥ 7 on Purchase events (average over Purchase rows
// that carry a quality value — the dry-run estimate in mock mode, Meta's real
// number when CAPI runs live).
function capiQuality(tx) {
  const r = tx.get(`SELECT COUNT(*) n, COALESCE(AVG(match_quality),0) avg_mq,
      SUM(CASE WHEN match_quality >= 7 THEN 1 ELSE 0 END) good
    FROM capi_log WHERE event_name='Purchase' AND match_quality IS NOT NULL`);
  const pct = r.n ? Math.round((r.good / r.n) * 100) : 0;
  return { n: r.n, avg_mq: Math.round(r.avg_mq * 100) / 100, pct_good: pct, pass: r.n === 0 ? false : r.avg_mq >= 7, threshold: 'avg ≥ 7' };
}

// 4d. weekly report timing before/after log (settings keys)
function weeklyTiming(tx, { beforeMin, afterMin } = {}) {
  const set = (k, v) => tx.run(`INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, k, v);
  if (beforeMin != null) set('weekly_report_time_before_min', String(Math.round(Number(beforeMin) * 100) / 100));
  if (afterMin != null) set('weekly_report_time_after_min', String(Math.round(Number(afterMin) * 100) / 100));
  const b = Number(tx.get(`SELECT value FROM settings WHERE key='weekly_report_time_before_min'`)?.value ?? 0);
  const a = Number(tx.get(`SELECT value FROM settings WHERE key='weekly_report_time_after_min'`)?.value ?? 0);
  const improvement = b && a ? Math.round(((b - a) / b) * 100) : null;
  return { before_min: b || null, after_min: a || null, improvement_pct: improvement };
}

module.exports = {
  parseCsv, normMapping, inferMapping, importOldLeads, IMPORT_FIELDS,
  checkAdUrl,
  runGates,
  revenueVsGateways, spendVsMeta, capiQuality, weeklyTiming,
};
