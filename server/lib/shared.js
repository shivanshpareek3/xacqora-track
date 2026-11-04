// Shared pure logic: identity rules, CAPI payloads, attribution, reports, UI helpers.
const crypto = require('node:crypto');

// ---------------------------------------------------------------- identity
function normPhone(p) {
  if (!p) return null;
  let s = String(p).replace(/[\s\-()]/g, '');
  if (!/^\+?[0-9]+$/.test(s)) return null;
  s = s.replace(/^\+/, '');
  if (s.startsWith('0091')) s = s.slice(4);
  if (s.startsWith('91') && s.length === 12) s = s.slice(2);
  if (s.startsWith('0') && s.length === 11) s = s.slice(1);
  if (s.length === 10) s = '91' + s;
  if (!/^91\d{10}$/.test(s)) return null;
  return '+' + s;
}
function normEmail(e) {
  if (!e) return null;
  const x = String(e).trim().toLowerCase();
  return x.includes('@') ? x : null;
}
function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}
// CAPI rules: hash E.164 WITHOUT the leading + ; email lowercase trimmed.
function capiHashedPhone(p) {
  const n = normPhone(p);
  return n ? sha256(n.replace('+', '')) : null;
}
function capiHashedEmail(e) {
  const n = normEmail(e);
  return n ? sha256(n) : null;
}
function buildCapiEvent(opts) {
  const { eventName, hashedPhone, hashedEmail, eventTime, value, currency = 'INR', fbc, fbp, eventId, externalId, dedupable = true } = opts;
  return {
    eventName,
    action_time: eventTime,
    user_data: {
      ...(hashedPhone ? { ph: [hashedPhone] } : {}),
      ...(hashedEmail ? { em: [hashedEmail] } : {}),
      ...(externalId ? { external_id: [externalId] } : {}),
      ...(fbc ? { fbc } : {}),
      ...(fbp ? { fbp } : {}),
    },
    custom_data: { ...(value != null ? { value, currency } : {}), ...(dedupable ? { dedupable: true } : {}) },
    ...(eventId ? { event_id: eventId } : {}),
  };
}
function buildCapiPayload(opts) {
  return { data: [buildCapiEvent(opts)], event_id: opts.eventId || sha256('capi|' + opts.clientId + '|' + Date.now() + '|' + Math.random()) };
}
function maskPhone(p) {
  const n = normPhone(p);
  if (!n) return p ? String(p) : '';
  return '+91 ••••• ' + n.slice(-4);
}
function maskEmail(e) {
  if (!e) return '';
  const x = String(e).toLowerCase();
  const [name, domain] = x.split('@');
  if (!domain) return x.slice(0, 1) + '•••';
  const keep = name ? name.slice(0, 2) : '?';
  return keep + '•••@' + domain;
}
// roles that may see unmasked contact data
function roleSeesFullContacts(role) {
  return ['owner', 'admin', 'sales_rep'].includes(role);
}
// build a CSV string from an array of row objects; value is masked per user role
// ---------------------------------------------------------------- Excel export
// Zero-dep: hand-written SpreadsheetML (the "Excel 2003 XML" format) that
// Excel / Numbers / LibreOffice all open natively as .xls. PRD §8 "boring tools,
// by hand" — no SheetJS. Same role-masking as toCsv.
function toExcel(rows, { sheetName = 'report', role, mask = [] } = {}) {
  const head = rows.length ? rows[0] : {};
  const esc = (v) => String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const cellFor = (v) => {
    let val = v;
    const s = String(val == null ? '' : val);
    const looksNumeric = s !== '' && !isNaN(Number(s)) && isFinite(Number(s)) && /^-?[\d.]+$/.test(s);
    const numAttr = looksNumeric ? ' DataType="Number"' : '';
    return `<Cell${numAttr}><Data ss:Type="${looksNumeric ? 'Number' : 'String'}">${esc(val)}</Data></Cell>`;
  };
  const dataRows = rows.length
    ? rows.map((r) => `<Row>${Object.keys(head).map((k) => {
        let v = r[k];
        const m = (mask || [])[k];
        if (m === 'phone') v = roleSeesFullContacts(role) ? v : maskPhone(v);
        else if (m === 'email') v = roleSeesFullContacts(role) ? v : maskEmail(v);
        return cellFor(v);
      }).join('')}</Row>`).join('')
    : '<Row><Cell><Data ss:Type="String">no rows</Data></Cell></Row>';
  return `<xml version="1.0" encoding="UTF-8"?>
<Types xmlns="urn:schemas-microsoft-com:office:office" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet" xmlns:x="urn:schemas-microsoft-com:office:excel">
</Types>
<Workbook ss:PrReader="0" xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
<Worksheet ss:Name="${esc(sheetName)}"><Table>
${Object.keys(head).map((k) => `<Row><Cell ss:StyleID="s62"><Data ss:Type="String">${esc(k)}</Data></Cell></Row>`).join('')}
${dataRows}
</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><ProtectObjects>False</ProtectObjects></WorksheetOptions></Worksheet>
</Workbook>`;
}
function toCsv(rows, { role, mask = [] } = {}) {
  if (!rows.length) return 'no rows';
  const keys = Object.keys(rows[0]);
  const head = keys.join(',');
  const cell = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = rows.map((r) =>
    keys.map((k) => {
      let v = r[k];
      const m = (mask || [])[k];
      if (m === 'phone') v = roleSeesFullContacts(role) ? v : maskPhone(v);
      else if (m === 'email') v = roleSeesFullContacts(role) ? v : maskEmail(v);
      return cell(v);
    }).join(',')
  );
  return [head, ...lines].join('\n');
}

// ---------------------------------------------------------------- stages
const DEFAULT_STAGES = ['New', 'Registered', 'Attended', 'Hot', 'Call Booked', 'Paid', 'Lost'];
const STAGE_EVENTS = {
  registered: 'Registered',
  webinar_joined: 'Attended',
  call_booked: 'Call Booked',
  payment_success: 'Paid',
  refund: 'Lost',
};
function stageOrder(stages) {
  return (s) => {
    const i = stages.indexOf(s);
    return i === -1 ? 90 : i;
  };
}
function autoStage(stages, current, eventType) {
  const target = STAGE_EVENTS[eventType];
  if (!target || !stages.includes(target)) return current;
  const ord = stageOrder(stages);
  if (ord(target) > ord(current)) return target;
  if (target === 'Paid') return 'Paid';
  return current;
}

// ---------------------------------------------------------------- attribution
// models: last_paid_click (default, 30d window), first_click, linear, lead_source
function adClicksInWindow(tps, tsIso, days) {
  const t = Date.parse(tsIso);
  const from = t - days * 86400000;
  const to = t + 86400000; // 1-day slack for same-day clicks stored as date strings
  return tps.filter((x) => x.ad_id && Date.parse(x.ts) >= from && Date.parse(x.ts) <= to);
}
function attributeSale(leadRow, clientName, settings, tps, tpsByLead) {
  const model = settings.attribution_model || 'last_paid_click';
  const win = Number(settings.attribution_window_days) || 30;
  const clicks = adClicksInWindow(tps, leadRow.paid_at, win);
  let attributedAdId = null, amount = leadRow.amount, bucket = 'Organic / unknown';
  if (clicks.length) {
    if (model === 'first_click') { attributedAdId = clicks[0].ad_id; bucket = 'Attributed'; }
    else if (model === 'last_paid_click') {
      attributedAdId = clicks[clicks.length - 1].ad_id;
      bucket = 'Attributed';
    } else if (model === 'linear') { bucket = 'Linear (split)'; attributedAdId = null; }
    else if (model === 'lead_source') {
      const firstForm = tps.find((x) => x.utm_campaign || x.ad_id);
      attributedAdId = firstForm ? (firstForm.ad_id || null) : null;
      bucket = attributedAdId ? 'Attributed' : 'Organic / unknown';
    }
  }
  return {
    client: clientName,
    lead_name: leadRow.name || 'Unknown',
    phone: leadRow.phone,
    email: leadRow.email,
    paid_at: leadRow.paid_at,
    amount,
    net: !leadRow.refunded_at ? leadRow.amount : 0,
    status: leadRow.refunded_at ? 'refunded' : 'active',
    model,
    window_days: win,
    attributed_ad_id: attributedAdId,
    bucket,
    ad_clicks: clicks.length,
    leads: [ { id: leadRow.lead_id, name: leadRow.name, phone: leadRow.phone } ],
    is_new_lead: isWithinRange(leadRow.created_at, settings.report_from, settings.report_to),
  };
}
function isWithinRange(iso, from, to) {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return true;
  if (from && t < Date.parse(from + 'T00:00:00Z')) return false;
  if (to && t > Date.parse(to + 'T23:59:59Z')) return false;
  return true;
}

// ---------------------------------------------------------------- reports
function funnelReport(tx, clientId, settings, clientIds, live = false) {
  // clientId null -> all clients (dashboard); a number -> one client; clientIds -> portal set.
  // live (v9 DATA_MODE): when true, seed/demo leads are excluded so the funnel
  // reflects real gateway leads only. Default false keeps every prior caller.
  const dm = require('./datamode');
  const liveLeadEx = live ? dm.leadNotDemo(dm.LIVE, 'l') : '';
  const inList = clientIds && clientIds.length ? clientIds.map((n) => Number(n)).join(',') : null;
  let filter = clientId != null ? `WHERE l.client_id = ${Number(clientId)}` : inList ? `WHERE l.client_id IN (${inList})` : '';
  if (liveLeadEx && filter) filter += ` AND ${liveLeadEx}`;
  else if (liveLeadEx) filter = `WHERE ${liveLeadEx}`;
  const rows = tx.all(`
    SELECT l.id, l.stage, l.created_at, l.source_unknown,
           COALESCE(d.net,0) rev, d.refunded_at
    FROM lead l LEFT JOIN (
      SELECT lead_id,
        SUM(CASE WHEN status='success' AND refunded_at IS NULL THEN amount END) net,
        MIN(CASE WHEN refunded_at IS NOT NULL AND status='refunded' THEN 1 ELSE 0 END) refunded_at
      FROM deal GROUP BY lead_id
    ) d ON d.lead_id = l.id
    ${filter}`).map((r) => ({ ...r, refunded_at: r.refunded_at ? 1 : 0 }));

  // revenue per lead (net of refunds)
  const rev = {};
  for (const r of rows) if (r.rev > 0) rev[r.id] = r.rev;

  // attribution buckets per sale
  const sales = rows.filter((r) => rev[r.id] > 0).map((s) => ({
    ...s,
    paid_at: tx.get(`SELECT MIN(paid_at) paid_at FROM deal WHERE lead_id=? AND status='success' AND refunded_at IS NULL`, s.id)?.paid_at || null,
  }));
  let attributed = 0, organic = 0, linearSplit = 0;
  for (const s of sales) {
    const tps = tx.all(`SELECT * FROM touchpoint WHERE lead_id=? ORDER BY ts`, s.id);
    const a = attributeSale({ ...s, amount: rev[s.id], name: null, phone: null, email: null, refunded_at: s.refunded_at }, '', settings, tps);
    if (a.bucket === 'Linear (split)') linearSplit = true;
    else if (a.bucket === 'Organic / unknown') organic += 1;
    else attributed += 1;
  }

  const st = (name) => rows.filter((r) => r.stage === name).length;
  // scope spend to the same clients
  const spendWhere = inList ? `WHERE s.ad_id IN (SELECT a.id FROM meta_ad a JOIN meta_adset as_ ON as_.id=a.adset_id WHERE as_.ad_account_id IN (SELECT ad_account_id FROM meta_ad_account WHERE client_id IN (${inList})))` : '';
  const spend = (inList
    ? tx.get(`SELECT COALESCE(SUM(s.spend_inr),0) v FROM spend_daily s ${spendWhere}`)
    : tx.get(`SELECT COALESCE(SUM(spend_inr),0) v FROM spend_daily`)
  )?.v || 0;
  const leadsCount = rows.length;
  const registered = st('Registered') + st('Attended') + st('Hot') + st('Call Booked') + st('Paid') + st('Lost');
  const attended = st('Attended') + st('Hot') + st('Call Booked') + st('Paid');
  const calls = st('Call Booked') + st('Paid');
  const paidLeads = st('Paid');
  const refundedCount = rows.filter((r) => r.refunded_at).length;
  const totalNet = Object.values(rev).reduce((a, b) => a + b, 0);
  const pct = (num, den) => (den ? Math.round((num / den) * 1000) / 10 : null);
  const money = (n) => n ? Math.round(n).toLocaleString('en-IN') : '0';
  // PRD "every number links to the leads behind it": lead-id lists per bucket.
  const idsOf = (stages) => rows.filter((r) => stages.includes(r.stage)).map((r) => r.id);
  const leadIds = {
    leads: rows.map((r) => r.id),
    registered: idsOf(['Registered', 'Attended', 'Hot', 'Call Booked', 'Paid', 'Lost']),
    attended: idsOf(['Attended', 'Hot', 'Call Booked', 'Paid']),
    calls: idsOf(['Call Booked', 'Paid']),
    paid: idsOf(['Paid']),
    revenue: Object.keys(rev),
    refunded: rows.filter((r) => r.refunded_at).map((r) => r.id),
  };
  return {
    leads: leadsCount,
    registered, attended, calls, paid: paidLeads, refunded: refundedCount,
    show_up_rate: pct(attended, registered || 0),
    close_rate: pct(paidLeads, registered || 0),
    spend, cpl: leadsCount ? Math.round(spend / leadsCount) : null,
    cpl_note: 'spend is all-accounts total; filter by ad account in Ad performance',
    revenue: totalNet,
    cost_per_sale: paidLeads ? Math.round(spend / paidLeads) : null,
    attribution: { attributed, organic, linear_split: linearSplit, sales_count: sales.length },
    lead_ids: leadIds,
  };
}

// clientIds: optional array; when present, only that client's ads/spend/deals count
function adPerformance(tx, settings, clientIds, adAccount, live = false) {
  // adAccount (Master v9): optional ad_account_id ('act_…'). When set, every
  // ad + spend query is narrowed to that single account. '' / undefined = off.
  // live (v9 DATA_MODE): when true, the demo ACT- ad accounts / leads / deals
  // are excluded so ad performance reflects real data only. Default false.
  const dm = require('./datamode');
  const metaEx = live ? dm.metaNotDemo(dm.LIVE, 'ad') : '';
  const liveLeadEx = live ? dm.leadNotDemo(dm.LIVE, 'l') : '';
  const model = settings.attribution_model || 'last_paid_click';
  const win = Number(settings.attribution_window_days) || 30;
  const inClause = clientIds && clientIds.length ? clientIds.map((n) => Number(n)).join(',') : null;
  const accIn = inClause ? `(SELECT ad_account_id FROM meta_ad_account WHERE client_id IN (${inClause}) ${metaEx ? `AND ${metaEx.replace(/^ad\./, '')}` : ''})` : null;
  const salesWhere = inClause ? `WHERE l.client_id IN (${inClause})` : '';
  const adAccW = adAccount ? ` AND ad.ad_account_id = '${adAccount}'` : '';
  const metaExW = metaEx ? ` AND ${metaEx}` : '';
  // scoped query filters meta_ad by its ad_account_id (only that account's
  // client); adset has no client_id column so we scope through the account
  // unscoped where: single-account scoping + live-mode demo exclusion
  // (metaEx already carries the `ad.` alias: `NOT (ad.ad_account_id LIKE 'ACT-%')`)
  const unscopedWhere = [
    adAccount ? `ad.ad_account_id = '${adAccount}'` : null,
    metaEx || null,
  ].filter(Boolean);
  const ads = inClause
    ? tx.all(`SELECT ad.id, ad.name, ad.adset_id, ad.status, ad.creative_img,
       COALESCE(c.name,'(removed)') campaign_name FROM meta_ad ad
       LEFT JOIN meta_campaign c ON c.id = (SELECT m2.campaign_id FROM meta_adset m2 WHERE m2.id = ad.adset_id LIMIT 1)
       WHERE ad.ad_account_id IN ${accIn}${adAccW}`)
    : tx.all(`SELECT ad.id, ad.name, ad.adset_id, ad.status, ad.creative_img,
       COALESCE(c.name,'(removed)') campaign_name FROM meta_ad ad
       LEFT JOIN meta_campaign c ON c.id = (SELECT m2.campaign_id FROM meta_adset m2 WHERE m2.id = ad.adset_id LIMIT 1)
       ${unscopedWhere.length ? `WHERE ${unscopedWhere.join(' AND ')}` : ''}`);
  const adAccounts = inClause
    ? tx.all(`SELECT ad_account_id, name FROM meta_ad_account WHERE client_id IN (${inClause})`)
    : (adAccount
      ? tx.all(`SELECT ad_account_id, name FROM meta_ad_account WHERE ad_account_id = '${String(adAccount).replace(/'/g, '')}'`)
      : tx.all(`SELECT ad_account_id, name FROM meta_ad_account`));
  const accById = {}; for (const a of adAccounts) accById[a.ad_account_id] = a.name;
  const adIdList = ads.map((a) => a.id).map((x) => `'${String(x).replace(/'/g, '')}'`).join(',');
  // when scoped, the unscoped all-ads fallback must NEVER run (even if the
  // client has zero ads) — otherwise another client's spend would leak in
  // conv = SUM(s.conversions) = Meta-reported conversions for that ad (PRD §5.7
  // Meta-vs-Track: compare Meta's number against our counted sales/leads).
  const spendEx = live ? dm.spendNotDemo(dm.LIVE, 's') : '';
  const spendExW = spendEx ? ` AND ${spendEx}` : '';
  const spends = inClause
    ? (adIdList
      ? tx.all(`SELECT s.ad_id, SUM(s.spend_inr) spend, SUM(s.impressions) imp, SUM(s.clicks) clk,
              COALESCE(SUM(s.conversions),0) conv
          FROM spend_daily s WHERE s.ad_id IN (${adIdList})${spendExW} GROUP BY s.ad_id`)
      : [])
    : tx.all(`SELECT s.ad_id, SUM(s.spend_inr) spend, SUM(s.impressions) imp, SUM(s.clicks) clk,
              COALESCE(SUM(s.conversions),0) conv FROM spend_daily s WHERE 1=1${spendExW} GROUP BY s.ad_id`);
  const spendByAd = {}; for (const s of spends) spendByAd[s.ad_id] = s;

  // revenue attribution per ad — keep the client scope AND the live-mode
  // demo-lead exclusion in force at the same time (live + scoped client)
  const revByAd = {};
  const salesParts = [];
  if (inClause) salesParts.push(`l.client_id IN (${inClause})`);
  if (liveLeadEx) salesParts.push(liveLeadEx);
  const sales = tx.all(`
    SELECT l.id lead_id, l.name, l.phone, l.client_id,
      (SELECT COALESCE(SUM(d.amount),0) FROM deal d WHERE d.lead_id=l.id AND d.status='success' AND d.refunded_at IS NULL) amount,
      (SELECT MIN(d.paid_at) FROM deal d WHERE d.lead_id=l.id AND d.status='success' AND d.refunded_at IS NULL) paid_at
    FROM lead l ${salesParts.length ? `WHERE ${salesParts.join(' AND ')}` : ''}`);
  for (const s of sales) {
    if (!s.amount) continue;
    const tps = tx.all(`SELECT * FROM touchpoint WHERE lead_id=? ORDER BY ts`, s.lead_id);
    const a = attributeSale({ ...s, paid_at: s.paid_at || null, refunded_at: null }, '', settings, tps);
    if (a.model === 'linear' && a.bucket === 'Linear (split)') {
      const ids = adClicksInWindow(tps, s.paid_at, win).map((x) => x.ad_id).filter((x) => x && x !== 'unknown');
      if (ids.length) {
        for (const id of ids) revByAd[id] = (revByAd[id] || 0) + s.amount / ids.length;
      }
    } else if (a.attributed_ad_id && a.attributed_ad_id !== 'unknown') {
      revByAd[a.attributed_ad_id] = (revByAd[a.attributed_ad_id] || 0) + s.amount;
    }
  }
  const leadsByAd = {};
  const leadsTps = inClause
    ? tx.all(`SELECT t.ad_id, COUNT(DISTINCT t.lead_id) c FROM touchpoint t
        JOIN lead l ON l.id=t.lead_id
        WHERE t.ad_id IS NOT NULL AND t.ad_id != '' AND l.client_id IN (${inClause}) GROUP BY t.ad_id`)
    : tx.all(`SELECT ad_id, COUNT(DISTINCT lead_id) c FROM touchpoint WHERE ad_id IS NOT NULL AND ad_id != '' GROUP BY ad_id`);
  for (const tp of leadsTps) {
    if (tp.ad_id) leadsByAd[tp.ad_id] = (leadsByAd[tp.ad_id] || 0) + tp.c;
  }
  // which leads are attributed to each ad (PRD "every number links to the leads behind it")
  const leadsIdsByAd = {};
  for (const s of sales) {
    if (!s.amount) continue;
    const tps = tx.all(`SELECT * FROM touchpoint WHERE lead_id=? ORDER BY ts`, s.lead_id);
    const a = attributeSale({ ...s, paid_at: s.paid_at || null, refunded_at: null }, '', settings, tps);
    let ids;
    if (a.model === 'linear' && a.bucket === 'Linear (split)') {
      ids = adClicksInWindow(tps, s.paid_at, win).map((x) => x.ad_id).filter((x) => x && x !== 'unknown');
    } else if (a.attributed_ad_id && a.attributed_ad_id !== 'unknown') {
      ids = [a.attributed_ad_id];
    } else ids = [];
    for (const id of ids) (leadsIdsByAd[id] = leadsIdsByAd[id] || new Set()).add(s.lead_id);
  }

  const out = [];
  for (const ad of ads) {
    const sp = spendByAd[ad.id] || { spend: 0, imp: 0, clk: 0, conv: 0 };
    const rev = Math.round(revByAd[ad.id] || 0);
    const leads = leadsByAd[ad.id] || 0;
    const conv = sp.conv || 0; // Meta-reported conversions for this ad
    const wasted = sp.spend >= Number(settings.wasted_spend_threshold || 0) && rev === 0;
    out.push({
      ad_id: ad.id, name: ad.name, adset: ad.adset_id, campaign: ad.campaign_name,
      account: accById[ad.adset_id ? tx.get(`SELECT ad_account_id FROM meta_adset WHERE id=?`, ad.adset_id)?.ad_account_id : ''] || '',
      status: ad.status, img: ad.creative_img || null,
      spend: Math.round(sp.spend), impressions: sp.imp || 0, clicks: sp.clk || 0,
      cpc: sp.clk ? Math.round(sp.spend / sp.clk) : null, cpm: sp.imp ? Math.round((sp.spend / sp.imp) * 1000) : null,
      leads, revenue: rev, roas: sp.spend ? Math.round((rev / sp.spend) * 100) / 100 : null,
      profit: sp.spend ? rev - sp.spend : null, wasted,
      // Meta-vs-Track: Meta-reported conversions vs our counted leads, with delta.
      meta_conv: conv, our_conv: leads, conv_delta: conv - leads,
      lead_ids: leadsIdsByAd[ad.id] ? [...leadsIdsByAd[ad.id]] : [],
      model,
    });
  }
  out.sort((a, b) => b.spend - a.spend);
  const tot = { spend: 0, revenue: 0, leads: 0, cpl: null, cpo: null, wasted_ads: 0 };
  for (const r of out) {
    tot.spend += r.spend; tot.revenue += r.revenue; tot.leads += r.leads;
    if (r.wasted) tot.wasted_ads += 1;
  }
  tot.roas = tot.spend ? Math.round((tot.revenue / tot.spend) * 100) / 100 : null;
  tot.profit = tot.revenue - tot.spend;
  tot.cpl = tot.leads ? Math.round(tot.spend / tot.leads) : null;
  const plClient = inClause ? ` AND l.client_id IN (${inClause})` : '';
  const paidLeads = tx.get(`SELECT COUNT(*) c FROM lead l WHERE EXISTS (SELECT 1 FROM deal d WHERE d.lead_id=l.id AND d.status='success' AND d.refunded_at IS NULL)${plClient}`)?.c;
  tot.cpo = paidLeads ? Math.round(tot.spend / paidLeads) : null;
  return { rows: out, total: tot, model, window_days: win };
}

function wastedSpend(ap) { return ap.rows.filter((r) => r.wasted); }
function newVsOld(tx, settings, clientIds, live = false) {
  const dm = require('./datamode');
  const liveLeadEx = live ? dm.leadNotDemo(dm.LIVE, 'l') : '';
  const parts = [];
  if (clientIds && clientIds.length) parts.push(`l.client_id IN (${clientIds.map((n) => Number(n)).join(',')})`);
  if (liveLeadEx) parts.push(liveLeadEx);
  const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  const from = settings.report_from || null;
  const to = settings.report_to || null;
  const all = tx.all(`SELECT l.id, l.created_at, (SELECT COALESCE(SUM(d.amount),0) FROM deal d WHERE d.lead_id=l.id AND d.status='success' AND d.refunded_at IS NULL) rev FROM lead l ${where}`);
  const inRange = all.filter((r) => isWithinRange(r.created_at, from, to));
  const out = { in_range: [], older: [] };
  for (const r of inRange) out.in_range.push(r);
  for (const r of all) if (!inRange.includes(r) && r.rev > 0) out.older.push(r);
  const sum = (arr) => arr.reduce((a, b) => a + b.rev, 0);
  return {
    in_range_count: inRange.length, in_range_revenue: sum(inRange),
    older_count: out.older.length, older_revenue: sum(out.older),
    in_range: out.in_range.map((x) => ({ id: x.id, created_at: x.created_at, rev: x.rev })),
    older: out.older.map((x) => ({ id: x.id, created_at: x.created_at, rev: x.rev })),
  };
}
function metaVsTracker(tx, settings, clientIds, adAccount, live = false) {
  // PRD §5.7 Meta-vs-Track: per ad, Meta-reported conversions (from the spend
  // pull) vs our counted leads, with a delta column so we see where Meta
  // over/under-reports. Person-level data never comes back from Meta.
  // adAccount (v9): scope the per-ad table to one ad account.
  // live (v9): exclude demo ACT- accounts / demo leads from the comparison.
  const ap = adPerformance(tx, settings || {}, clientIds, adAccount, live);
  const dm = require('./datamode');
  const liveLeadEx = live ? dm.leadNotDemo(dm.LIVE, 'l') : '';
  // scope through the lead (event has no client_id of its own)
  let scope = clientIds && clientIds.length ? `l.client_id IN (${clientIds.map((n) => Number(n)).join(',')}) AND` : '';
  if (liveLeadEx) scope += `${liveLeadEx} AND`;
  const metaLeadTotal = tx.get(`SELECT COUNT(*) c FROM event e JOIN lead l ON l.id=e.lead_id WHERE ${scope} e.type='meta_form_lead'`)?.c || 0;
  const rows = ap.rows
    .filter((r) => r.meta_conv > 0 || r.leads > 0)
    .map((r) => ({
      ad_id: r.ad_id, ad: r.name, campaign: r.campaign,
      meta_conv: r.meta_conv, our_conv: r.our_conv, delta: r.conv_delta,
    }));
  const tot = rows.reduce((a, r) => { a.meta += r.meta_conv; a.ours += r.our_conv; return a; }, { meta: 0, ours: 0 });
  return {
    rows,
    meta_conv_total: tot.meta, our_conv_total: tot.ours, delta: tot.meta - tot.ours,
    meta_lead_total: metaLeadTotal,
    attributed_sales: ap.rows.filter((r) => r.revenue > 0).length,
    organic: ap.rows.filter((r) => r.lead_ids.length === 0 && r.leads > 0).length,
    note: 'Meta "Conversions" (from the spend pull) vs our counted leads, per ad. delta = Meta − ours; a positive delta means Meta is over-reporting. Person-level data never comes back from Meta.',
  };
}
function sourceMix(tx, clientIds, live = false) {
  const dm = require('./datamode');
  const liveLeadEx = live ? dm.leadNotDemo(dm.LIVE, 'l') : '';
  const parts = [];
  if (clientIds && clientIds.length) parts.push(`l.client_id IN (${clientIds.map((n) => Number(n)).join(',')})`);
  if (liveLeadEx) parts.push(liveLeadEx);
  const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  const srcExpr = `CASE
    WHEN EXISTS(SELECT 1 FROM event e WHERE e.lead_id=l.id AND e.type='meta_form_lead') THEN 'Meta Instant Form'
    WHEN l.phone IS NOT NULL OR l.email IS NOT NULL THEN 'Landing page form'
    ELSE 'Organic / unknown'
  END`;
  const rows = tx.all(`SELECT ${srcExpr} src, COUNT(*) c FROM lead l ${where} GROUP BY src`);
  // PRD "every number links to the leads behind it": attach the lead-id list
  // for each source bucket so the mix chips can drill into /leads?ids=…
  const bySrc = {};
  for (const r of tx.all(`SELECT l.id, ${srcExpr} src FROM lead l ${where}`)) (bySrc[r.src] = bySrc[r.src] || []).push(r.id);
  for (const r of rows) r.lead_ids = bySrc[r.src] || [];
  return rows;
}
function weeklySummary(tx, settings, clientIds, live = false) {
  const fp = funnelReport(tx, null, settings, clientIds, live);
  const ap = adPerformance(tx, settings, clientIds, null, live);
  const waste = wastedSpend(ap);
  return {
    generated_at: new Date().toISOString(),
    settings: { model: settings.attribution_model, window: settings.attribution_window_days },
    funnel: fp,
    ad_top: ap.rows.slice(0, 5),
    ad_worst: waste.slice(0, 5),
    total: ap.total,
    note: 'Auto-generated weekly summary. Revenue is net of refunds. Spend matches Meta Ads Manager within 1% when the Meta pull is up to date.',
  };
}

// ---------------------------------------------------------------- Master v9: real-data dashboard report
// One scoped query set driving the account-switcher dashboard.
//   adAccount  — a meta_ad_account.ad_account_id ('act_…'); '' = "All accounts"
//   clientIds  — client login's own ids; null = all (team role)
//   dataMode   — 'demo' (default; demo ACT- spend counts toward "All accounts")
//                | 'live' (demo rows excluded by the datamode predicates)
// Returns { accounts, kpis{d7,d30}, trend[30], topCampaigns[5], topAds[5],
//          pull, accountSpends, revenue, currency, defaultAccount }.
function metaAccountReport(tx, { adAccount = '', clientIds = null, dataMode = 'demo' } = {}) {
  const dm = require('./datamode');
  const spendEx = dm.spendNotDemo(dataMode, 's');
  const leadEx = dm.leadNotDemo(dataMode, 'l');
  const dealEx = dm.dealNotDemo(dataMode, 'd');
  const metaEx = dm.metaNotDemo(dataMode, '');
  const clientScope = (col = 'client_id') => (clientIds && clientIds.length
    ? `${col} IN (${clientIds.map((n) => Number(n)).join(',')})` : '1=1');
  // Switcher list: the operator's REAL ad accounts only (act_…), with last-pull
  // status per row. In demo mode the demo ACT- accounts are NOT offered here
  // (design: switcher = real act_ only); demo spend still feeds the "All"
  // aggregate below.
  const accounts = tx.all(`
    SELECT id, client_id, name, ad_account_id, currency, status, last_pull_at, last_error, auto_pull
    FROM meta_ad_account
    WHERE ad_account_id NOT LIKE 'ACT-%' AND ${clientScope('client_id')} ${metaEx ? `AND ${metaEx.replace(/\./g, '')}` : ''}
    ORDER BY ad_account_id`);
  // Spend scope for the numbers: a specific account, else every in-scope account.
  // The datamode spendEx predicate is what removes demo ACT- spend in live mode.
  const clean = (v) => String(v).replace(/'/g, '');
  const adScope = adAccount
    ? `s.ad_account_id = '${clean(adAccount)}'`
    : `s.ad_account_id IN (SELECT ad_account_id FROM meta_ad_account WHERE ${clientScope('client_id')})`;
  const since = (days) => new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const kpi = (from) => {
    const o = tx.get(`
      SELECT COALESCE(SUM(s.spend),0) spend, COALESCE(SUM(s.spend_inr),0) spend_inr,
        COALESCE(SUM(s.impressions),0) impressions, COALESCE(SUM(s.reach),0) reach,
        COALESCE(SUM(s.clicks),0) clicks, COALESCE(SUM(s.conversions),0) conversions
      FROM spend_daily s WHERE ${adScope}
      ${spendEx ? "AND " + spendEx : ""} AND s.date >= ?`, from) || {};
    return {
      spend: o.spend || 0, spend_inr: o.spend_inr || 0,
      impressions: o.impressions || 0, reach: o.reach || 0,
      clicks: o.clicks || 0, conversions: o.conversions || 0,
      ctr: o.impressions ? +(((o.clicks || 0) / o.impressions) * 100).toFixed(2) : null,
      cpc: o.clicks ? +(((o.spend_inr || 0) / o.clicks).toFixed(2)) : null,
    };
  };
  const kpis = { d7: kpi(since(7)), d30: kpi(since(30)) };
  // 30-day daily trend (spend INR + clicks + impressions), zero-filled.
  const tRows = tx.all(`SELECT s.date, COALESCE(SUM(s.spend_inr),0) spend,
    COALESCE(SUM(s.clicks),0) clicks, COALESCE(SUM(s.impressions),0) impressions
    FROM spend_daily s WHERE ${adScope}
      ${spendEx ? "AND " + spendEx : ""} AND s.date >= ? GROUP BY s.date`, since(30));
  const byDate = {}; for (const r of tRows) byDate[r.date] = r;
  const trend = [];
  for (let i = 29; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    const r = byDate[date] || {};
    trend.push({ date, spend: Math.round(r.spend || 0), clicks: r.clicks || 0, impressions: r.impressions || 0 });
  }
  // Per-campaign daily split (used when a single account is selected).
  // LEFT JOINs: the ad tree may lag the first pull (spend lands before
  // campaign names) — real spend must still chart, with "(untitled)" names.
  const campTrend = adAccount
    ? tx.all(`SELECT s.date, COALESCE(c.name,'(untitled)') campaign, COALESCE(SUM(s.spend_inr),0) spend
        FROM spend_daily s
        LEFT JOIN meta_ad m ON m.id=s.ad_id
        LEFT JOIN meta_adset as_ ON as_.id=m.adset_id
        LEFT JOIN meta_campaign c ON c.id=as_.campaign_id
        WHERE ${adScope}
      ${spendEx ? "AND " + spendEx : ""} AND s.date >= ? GROUP BY s.date, c.id, c.name ORDER BY s.date`, since(30))
    : [];
  // Top campaigns / top ads by 7-day spend. LEFT JOINs: the ad tree can lag
  // the first pull (spend_daily lands while campaigns/ads aren't stored yet),
  // so real spend must still show — name/status fall back to "(unknown)" / ad_id.
  const topCampaigns = tx.all(`
    SELECT COALESCE(c.id,'na') id, COALESCE(c.name,'(unknown)') name, COALESCE(c.status,'') status,
      COALESCE(SUM(s.spend_inr),0) spend, COALESCE(SUM(s.impressions),0) impressions
    FROM spend_daily s
    LEFT JOIN meta_ad m ON m.id=s.ad_id
    LEFT JOIN meta_adset as_ ON as_.id=m.adset_id
    LEFT JOIN meta_campaign c ON c.id=as_.campaign_id
    WHERE ${adScope}
      ${spendEx ? "AND " + spendEx : ""} AND s.date >= ?
    GROUP BY c.id, c.name, c.status ORDER BY spend DESC LIMIT 5`, since(7));
  const topAds = tx.all(`
    SELECT s.ad_id ad_id, COALESCE(m.name,'(unknown)') name, COALESCE(m.status,'') status, m.creative_img,
      COALESCE(SUM(s.spend_inr),0) spend, COALESCE(SUM(s.impressions),0) impressions,
      COALESCE(SUM(s.clicks),0) clicks
    FROM spend_daily s
    LEFT JOIN meta_ad m ON m.id=s.ad_id
    WHERE ${adScope}
      ${spendEx ? "AND " + spendEx : ""} AND s.date >= ?
    GROUP BY s.ad_id, m.name, m.status, m.creative_img ORDER BY spend DESC LIMIT 5`, since(7));
  // Per-account 7d spend (drives the "largest account is the default" rule).
  const accountSpends = tx.all(`
    SELECT s.ad_account_id, COALESCE(SUM(s.spend_inr),0) spend
    FROM spend_daily s
    WHERE s.date >= ? ${spendEx ? `AND ${spendEx}` : ''}
    GROUP BY s.ad_account_id`, since(7));
  const spendByAcc = {}; for (const r of accountSpends) spendByAcc[r.ad_account_id] = r.spend;
  // "default = largest account" over the IN-SCOPE switcher accounts only
  let defaultAccount = '';
  for (const a of accounts) if ((spendByAcc[a.ad_account_id] || 0) > (spendByAcc[defaultAccount] || 0)) defaultAccount = a.ad_account_id;
  // Pull status for the selected scope.
  const pull = adAccount
    ? ((tx.get(`SELECT last_pull_at, last_error FROM meta_ad_account WHERE ad_account_id=?`, adAccount)) || {})
    : accounts.map((a) => ({ ad_account_id: a.ad_account_id, name: a.name, last_pull_at: a.last_pull_at, last_error: a.last_error, auto_pull: a.auto_pull }));
  // Revenue for the ROAS slot: attributed sales in scope. In live mode pre-pilot
  // this is 0 -> the dashboard renders "N/A — pilot live", never a fake ROAS.
  const revenue = tx.get(`
    SELECT COALESCE(SUM(d.amount),0) rev FROM deal d JOIN lead l ON l.id=d.lead_id
    WHERE d.status='success' AND d.refunded_at IS NULL ${leadEx ? 'AND ' + leadEx : ''} ${dealEx ? 'AND ' + dealEx : ''}
      ${adAccount ? `AND l.client_id IN (SELECT client_id FROM meta_ad_account WHERE ad_account_id='${clean(adAccount)}')` : ''}
  `)?.rev || 0;
  return {
    accounts, kpis, trend, campTrend, topCampaigns, topAds,
    pull, accountSpends, revenue, defaultAccount,
    currency: adAccount ? (tx.get(`SELECT currency FROM meta_ad_account WHERE ad_account_id=?`, adAccount)?.currency || null) : null,
  };
}

// Zero-dep SVG line/area chart for the spend trend. data: [{date, spend,…}].
// theme-safe (uses the .spark-* CSS vars below); tooltips via <title>.
function sparklineSvg(series, { w = 560, h = 160, metric = 'spend' } = {}) {
  if (!series.length) return '';
  const pad = 8, x0 = pad, x1 = w - pad, y0 = h - 24, y1 = 12;
  const max = Math.max(1, ...series.map((d) => d[metric] || 0));
  const px = (i) => series.length === 1 ? (x0 + x1) / 2 : x0 + ((x1 - x0) * i) / (series.length - 1);
  const py = (v) => y0 - ((y0 - y1) * (v || 0)) / max;
  const pts = series.map((d, i) => `${px(i)},${py(d[metric] || 0)}`).join(' ');
  const area = `${x0},${y0} ${pts} ${px(series.length - 1)},${y0}`;
  const ticks = [0, Math.floor(series.length / 2), series.length - 1]
    .filter((i, n, a) => a.indexOf(i) === n)
    .map((i) => `<text class="spark-lbl" x="${px(i)}" y="${h - 8}" text-anchor="middle">${esc(series[i].date.slice(5))}</text>`).join('');
  const dots = series.map((d, i) => `<circle class="spark-dot" cx="${px(i)}" cy="${py(d[metric] || 0)}" r="2.5"><title>${esc(d.date)}: ${String(Math.round((d[metric] || 0) * 100) / 100)}</title></circle>`).join('');
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="daily ${metric} trend">
    <polygon class="spark-area" points="${area}"/><polyline class="spark-line" points="${pts}"/>${dots}${ticks}</svg>`;
}

// Flatten a weekly summary into { title, sections } for the PDF writer
// (server/lib/pdf.js) and the portal's "latest weekly summary" card.
function weeklyPdfLines(ws, clientName = '') {
  const fp = ws.funnel, ap = ws.total;
  const money = (n) => (n ? '₹' + Math.round(n).toLocaleString('en-IN') : '₹0');
  const sec = (heading, lines) => ({ heading, lines });
  return {
    title: 'Xacqora Track — Weekly Client Summary' + (clientName ? ' · ' + clientName : ''),
    sections: [
      sec('Period / model', [
        'Generated ' + (ws.generated_at ? ws.generated_at.slice(0, 10) : ''),
        'Attribution: ' + (ws.settings.model || 'last_paid_click') + ' (' + (ws.settings.window || 30) + 'd window)',
      ]),
      sec('Funnel', [
        'Leads: ' + fp.leads + '   Registered: ' + fp.registered + '   Attended: ' + fp.attended,
        'Calls: ' + fp.calls + '   Paid: ' + fp.paid + '   Refunded: ' + (fp.refunded || 0),
        'Revenue (net of refunds): ' + money(fp.revenue),
        'Spend: ' + money(fp.spend) + '   ROAS: ' + (ap.roas != null ? ap.roas : '—') + '   Profit: ' + money(ap.profit),
      ]),
      sec('Top ads by spend', (ws.ad_top || []).map((r) =>
        `${r.name} — ${money(r.spend)} spend, ${r.leads} leads, ${money(r.revenue)} rev, ROAS ${r.roas ?? '—'}`)),
      sec('Wasted spend', (ws.ad_worst || []).map((r) =>
        `${r.name} — ${money(r.spend)} spend, 0 sales`) || ['None']),
      sec('Note', [ws.note]),
    ],
  };
}

// ---------------------------------------------------------------- scoping
// Team roles (owner, admin, media_buyer, sales_rep, viewer) work across all
// internal clients. The client role is locked to its own client_ids.
function allowedClients(user, allClientIds) {
  if (!user || user.role !== 'client') return allClientIds || null; // null = unrestricted
  const mine = (user.client_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  return allClientIds ? allClientIds.filter((id) => mine.includes(String(id))) : mine;
}

// ---------------------------------------------------------------- UI helpers
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function fmtINR(n) {
  if (n == null) return '—';
  return '₹' + Math.round(n).toLocaleString('en-IN');
}
function fmtN(n) {
  return n == null ? '—' : n.toLocaleString('en-IN');
}
function fmtPct(n) {
  return n == null ? '—' : n + '%';
}
function fmtDT(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' IST';
}
function css() {
  return `
/* Master v9 Task 3 — SaaS dashboard design system. Single shared stylesheet,
   zero-dep: token palette + primitives, no framework, no build step.
   Class names are stable: screens.js / index.js render against these. */
:root{
/* surfaces */
--bg:#0b0e17;--bg2:#0e1322;
--panel:#12172a;--panel2:#181f34;--panel3:#1f2846;
--line:#232b45;--line2:#2e3a5c;
/* text */
--tx:#e9edf7;--mut:#8f9ab8;--mut2:#5d6a90;
/* brand + status */
--acc:#5b7cfa;--acc2:#8b9dff;--acc-soft:rgba(91,124,250,.15);
--ok:#2ed396;--ok-soft:rgba(46,211,150,.14);
--warn:#f4a53f;--warn-soft:rgba(244,165,63,.14);
--bad:#f06565;--bad-soft:rgba(240,101,101,.15);
--cy:#3fc9e4;--pur:#ab7dfc;
/* legacy aliases — inline styles in screens.js reference these names */
--blue:var(--acc);--green:var(--ok);--orange:var(--warn);--red:var(--bad);--b:var(--acc);--g:var(--ok);--o:var(--warn);--r:var(--bad);
/* geometry */
--r:12px;--r-sm:9px;--r-xs:7px;
--sh:0 1px 2px rgba(0,0,0,.35),0 8px 24px rgba(3,7,18,.35)}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1100px 520px at 85% -8%,rgba(91,124,250,.09),transparent 60%) var(--bg);color:var(--tx);font:14px/1.55 system-ui,-apple-system,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased}
::selection{background:rgba(91,124,250,.35)}
*::-webkit-scrollbar{width:10px;height:10px}
*::-webkit-scrollbar-thumb{background:var(--line2);border-radius:10px;border:2px solid var(--bg)}
a{color:var(--acc2);text-decoration:none} a:hover{text-decoration:underline}
/* top bar */
.top{display:flex;align-items:center;gap:14px;padding:0 18px;height:54px;background:rgba(11,14,23,.85);backdrop-filter:blur(10px);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:5}
.demo-band{padding:7px 18px;background:linear-gradient(90deg,var(--warn-soft),rgba(244,165,63,.04));color:#f6c57b;border-bottom:1px solid rgba(244,165,63,.22);font-size:12px;font-weight:500}
.brand{font-weight:800;font-size:13px;letter-spacing:1.2px;white-space:nowrap}
.brand span{color:var(--acc2)}
.nav{display:flex;gap:2px;flex-wrap:wrap;min-width:0}
.nav a{color:var(--mut);padding:7px 11px;border-radius:var(--r-xs);font-size:13px;font-weight:500;white-space:nowrap}
.nav a:hover{background:var(--panel2);color:var(--tx);text-decoration:none}
.nav a.on{background:var(--acc-soft);color:var(--tx);font-weight:600}
.userbox{margin-left:auto;text-align:right;font-size:11px;color:var(--mut);line-height:1.5;white-space:nowrap}
.userbox b{color:var(--tx);font-size:13px;font-weight:600;display:block}
.userbox a{color:var(--mut2);font-size:11px}
main{padding:22px 18px 40px;max-width:1240px;margin:0 auto}
/* cards + page type */
.card{background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:16px;margin-bottom:14px;box-shadow:var(--sh)}
h1{font-size:19px;font-weight:650;letter-spacing:-.2px;margin:0 0 12px} h2{font-size:14px;font-weight:600;margin:0 0 10px}
.grid{display:grid;gap:14px}.g6{grid-template-columns:repeat(6,1fr)}.g4{grid-template-columns:repeat(4,1fr)}.g3{grid-template-columns:repeat(3,1fr)}.g2{grid-template-columns:repeat(2,1fr)}
/* page title row: h1 flush-left, actions flush-right (replaces ad-hoc .row wrappers) */
.pagehead{margin-bottom:16px}
@media(max-width:1100px){.g6{grid-template-columns:repeat(3,1fr)}}
@media(max-width:900px){.g6{grid-template-columns:repeat(2,1fr)}.g4{grid-template-columns:repeat(2,1fr)}.g3{grid-template-columns:1fr}.g2{grid-template-columns:1fr}}
/* KPI cards: micro-caps label, big tabular value, hairline accent */
.kpi{position:relative;overflow:hidden;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:14px;box-shadow:var(--sh)}
.kpi::before{content:'';position:absolute;top:0;left:12px;right:40%;height:2px;background:linear-gradient(90deg,var(--acc),transparent);opacity:.7}
.kpi .l{color:var(--mut);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-bottom:5px}
.kpi .v{font-size:22px;font-weight:700;letter-spacing:-.4px;font-variant-numeric:tabular-nums}
.kpi .small{margin-top:5px}
/* tables */
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:var(--mut2);text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px}
td{padding:10px;border-bottom:1px solid rgba(35,43,69,.55);vertical-align:top}
tbody tr:hover td{background:rgba(24,31,52,.5)}
tr:last-child td{border-bottom:none}
/* pills / badges / chips */
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;font-weight:600;line-height:1.7;white-space:nowrap}
.pill.g{background:var(--ok-soft);color:var(--ok)}
.pill.o{background:var(--warn-soft);color:var(--warn)}
.pill.r{background:var(--bad-soft);color:var(--bad)}
.pill.b{background:var(--acc-soft);color:var(--acc2)}
.pill.p{background:rgba(171,125,252,.15);color:var(--pur)}
.pill.m{background:rgba(143,154,184,.15);color:var(--mut)}
.badge{display:inline-block;font-size:11px;color:var(--mut);background:var(--panel2);border:1px solid var(--line);border-radius:999px;padding:2px 9px;font-weight:500}
.chip{display:inline-block;background:var(--panel2);border:1px solid var(--line);border-radius:var(--r-sm);padding:6px 10px;font-size:12px;color:var(--mut);margin:2px 6px 2px 0}
.chip b{color:var(--tx)}
/* buttons */
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;background:var(--acc);color:#fff;border:none;border-radius:var(--r-sm);padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;text-decoration:none;line-height:1.2;transition:background .15s}
.btn:hover{background:var(--acc2);text-decoration:none}
.btn.sec{background:var(--panel2);color:var(--tx);border:1px solid var(--line2)}
.btn.sec:hover{background:var(--panel3)}
.btn.sm{padding:5px 10px;font-size:12px;border-radius:var(--r-xs)}
.btn.danger{background:var(--bad)}
.btn.danger:hover{background:#ff8585}
/* forms */
input,select,textarea{background:var(--panel2);border:1px solid var(--line);color:var(--tx);border-radius:var(--r-sm);padding:8px 11px;font-size:13px;font-family:inherit}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--acc);box-shadow:0 0 0 3px var(--acc-soft)}
label{font-size:12px;color:var(--mut);font-weight:500;display:block;margin-bottom:4px}
form.inline{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
/* meters */
.bar{height:8px;background:var(--panel2);border-radius:999px;overflow:hidden;min-width:90px}
.bar i{display:block;height:100%;background:linear-gradient(90deg,var(--acc),var(--acc2));border-radius:999px}
/* empty states (Task 2) */
.empty-state{background:var(--panel);border:1px dashed var(--line2);border-radius:var(--r);padding:28px 20px;text-align:center;color:var(--mut);font-size:13.5px;line-height:1.6;margin-bottom:14px}
.empty-state a{color:var(--acc2)}
/* sparklines */
.spark{display:block}
.spark-line{fill:none;stroke:var(--acc);stroke-width:2;vector-effect:non-scaling-stroke}
.spark-area{fill:var(--acc-soft)}
.spark-dot{fill:var(--acc)}
.spark-lbl{fill:var(--mut2);font-size:10px}
/* ad-account switcher (top bar) */
.accsel{margin-left:4px}
.accsel label{display:none}
.accsel select{max-width:230px;background:var(--panel2);border:1px solid var(--line);color:var(--tx);border-radius:var(--r-xs);padding:6px 10px;font-size:12px;font-weight:500}
/* layout helpers */
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.sp{flex:1}
.muted{color:var(--mut)} .small{font-size:12px}
/* two-tier app shell (Master v9 Task 3): fixed sidebar + sticky top bar */
.sb{position:fixed;inset:0 auto 0 0;width:212px;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;padding:14px 12px;z-index:6}
.sb-brand{font-weight:800;font-size:12px;letter-spacing:1.2px;color:var(--tx);padding:2px 8px 14px}
.sb-brand span{color:var(--acc2)}
.sb-nav{flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.sb-grp{font-size:10px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--mut2);padding:12px 8px 4px}
.sb-grp:first-child{padding-top:2px}
.sb-nav a{color:var(--mut);padding:7px 10px;border-radius:var(--r-xs);font-size:13px;font-weight:500;white-space:nowrap}
.sb-nav a:hover{background:var(--panel2);color:var(--tx);text-decoration:none}
.sb-nav a.on{background:var(--acc-soft);color:var(--tx);font-weight:600}
.main-side{margin-left:212px}
.tt{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:14px;padding:0 18px;height:52px;background:rgba(11,14,23,.85);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.tt-user{line-height:1.5}
.tt-user b{font-size:12px}
@media(max-width:900px){
.sb{position:static;width:100%;height:auto;flex-direction:row;align-items:center;border-right:none;border-bottom:1px solid var(--line);padding:10px}
.sb-brand{padding:0 10px 0 0}
.sb-nav{flex-direction:row;overflow-x:auto}
.sb-grp{display:none}
.main-side{margin-left:0}
.tt{position:static;height:auto;padding:10px 14px;flex-wrap:wrap;border-top:none}}
.tabwrap{overflow-x:auto}
.lead-img{width:52px;height:52px;object-fit:cover;border-radius:var(--r-xs);border:1px solid var(--line2);background:var(--panel2)}
/* timeline */
.tl{border-left:2px solid var(--line);margin-left:9px;padding-left:16px;position:relative}
.tl .ev{position:relative;padding:7px 0}
.tl .ev::before{content:'';position:absolute;left:-22px;top:13px;width:9px;height:9px;border-radius:50%;background:var(--acc);border:2px solid var(--bg)}
.tl .ev.g::before{background:var(--ok)}.tl .ev.o::before{background:var(--warn)}.tl .ev.r::before{background:var(--bad)}.tl .ev.p::before{background:var(--pur)}
/* code / logs */
.log{font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.55;color:var(--mut);background:var(--bg2);border:1px solid var(--line);border-radius:var(--r-sm);padding:10px 12px;white-space:pre-wrap;max-height:340px;overflow:auto}
/* callouts */
.note{background:var(--acc-soft);border:1px solid rgba(91,124,250,.28);border-radius:var(--r-sm);padding:10px 12px;font-size:13px;line-height:1.55;margin:10px 0}
.note.warn{background:var(--warn-soft);border-color:rgba(244,165,63,.32)}
/* kanban */
.kanban{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px}
.kcol{min-width:230px;flex:1;background:var(--panel);border:1px solid var(--line);border-radius:var(--r);padding:10px 12px;box-shadow:var(--sh)}
.kcol h3{margin:0 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--mut);display:flex;justify-content:space-between;align-items:center}
.kcard{background:var(--panel2);border:1px solid var(--line);border-radius:var(--r-sm);padding:9px 10px;margin-bottom:8px;font-size:12px}
.kcard a{font-weight:600}
/* footer + narrow screens */
footer{color:var(--mut2);font-size:11px;line-height:1.6;text-align:center;padding:22px 16px}
@media(max-width:900px){
.top{flex-wrap:wrap;height:auto;padding:10px 14px}
.userbox{margin-left:0;text-align:left}
.kanban{flex-wrap:nowrap}}
`;
}
// Master v7 §1.4/§6 + v9: the honest demo-data label. Tied to DATA_MODE, not
// XACQORA_LIVE: `demo` mode shows the yellow band (seed fixture figures); `live`
// mode hides it because the seed rows are excluded from every screen and the
// numbers are real. (Legacy liveMode() fallback only if the screen doesn't
// resolve a data mode.)
function layoutDemoBand(mode) {
  if (mode === 'live') return '';
  if (mode === 'demo')
    return `<div class="demo-band" title="Demo mode: seed fixture figures are included on these screens. Switch to DATA_MODE=live (Admin → Data mode) to view real data only.">Demo data — seed figures included. Real data: Admin → Data mode → live.</div>`;
  // no mode passed: legacy behaviour (mock vs live)
  if (require('./liveapi').liveMode()) return '';
  return `<div class="demo-band" title="Mock mode: every figure on these screens comes from the seed fixtures, not a live gateway or Meta pull.">Demo data — the live pilot will show real numbers.</div>`;
}
// Master v9 account switcher (top bar). accSelect = { path, options, current }:
// options = [{ value, label }] (label is plain text; screens may append a
// status marker like " · error"). Renders a self-submitting <select> driving
// ?acc= on `path` (All accounts = empty value).
function layoutAccSelect(accSelect) {
  if (!accSelect || !accSelect.options || !accSelect.options.length) return '';
  const opts = [`<option value="">All accounts</option>`,
    ...accSelect.options.map((o) =>
      `<option value="${esc(o.value)}"${o.value === accSelect.current ? ' selected' : ''}>${esc(o.label)}</option>`)].join('');
  const hidden = (accSelect.hidden || []).map((f) => `<input type="hidden" name="${esc(f.name)}" value="${esc(f.value)}">`).join('');
  return `<form class="accsel" method="get" action="${esc(accSelect.path)}" title="Scope the dashboard to one ad account"><label>Ad account</label>
    ${hidden}<select name="acc" onchange="this.form.submit()">${opts}</select></form>`;
}
function layout({ title, nav, active, user, body, notes = '', band, accSelect }) {
  const demoBand = band !== undefined ? band : layoutDemoBand();
  const switcher = accSelect ? layoutAccSelect(accSelect) : '';
  const userBox = `<div class="userbox"><b>${esc(user.name)}</b>${esc(user.role)}${user.clientNames ? ' · ' + esc(user.clientNames.join(', ')) : ''}<br><a href="/signout">Sign out</a></div>`;
  let chrome;
  if (nav && nav.length) {
    // signed-in screen: SaaS two-tier shell — vertical sidebar (grouped nav +
    // user) + slim sticky top bar (brand, ad-account switcher, sign out).
    const links = nav.map((n) => {
      const g = n.group ? `<div class="sb-grp">${esc(n.group)}</div>` : '';
      return g + `<a href="/${n.path}" class="${n.path === active ? 'on' : ''}">${esc(n.label)}</a>`;
    }).join('');
    chrome = `
<aside class="sb"><div class="sb-brand">XACQORA <span>TRACK</span></div>
<div class="sb-nav">${links}</div></aside>
<div class="tt">
${switcher}
<div class="sp"></div>
<div class="userbox tt-user"><b>${esc(user.name)}</b>${esc(user.role)}${user.clientNames ? ' · ' + esc(user.clientNames.join(', ')) : ''}<br><a href="/signout">Sign out</a></div>
</div>`;
  } else {
    // auth / 403 / 404 pages: compact single bar, no sidebar.
    chrome = `
<div class="top">
  <div class="brand">XACQORA <span>TRACK</span></div>
  ${switcher}
  ${userBox}
</div>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Xacqora Track</title><style>${css()}</style></head>
<body>
${chrome}
${demoBand}
<main class="${nav && nav.length ? 'main-side' : ''}">${notes}${body}</main>
<footer>Xacqora Track · Node ${process.versions.node} · webhooks signature-verified · CAPI deduped by event_id</footer>
</body></html>`;
}
const NAV = [
  { path: 'leads', label: 'Leads' },
  { path: 'leads.html', label: 'Lead' },
  { path: 'pipeline.html', label: 'Pipeline' },
  { path: 'reports.html', label: 'Reports' },
  { path: 'meta.html', label: 'Meta' },
  { path: 'integrations.html', label: 'Integrations' },
  { path: 'duplicates.html', label: 'Duplicates' },
  { path: 'admin.html', label: 'Admin' },
];
// Master v9 Task 3: sidebar nav groups (Workspace / Insight / Integrations /
// Ops / Admin). Every screen keeps its exact path — routing is untouched; only
// the presentation grouping changed. The SPA's /api/app/me reports the same
// paths via this function, so the SPA is unaffected.
function navFor(user) {
  if (user.role === 'client') return [
    { group: 'Workspace', path: 'dashboard.html', label: 'Dashboard' },
    { group: 'Workspace', path: 'portal-leads.html', label: 'My leads' },
    { group: 'Workspace', path: 'portal-reports.html', label: 'My reports' },
  ];
  const n = [];
  if (user.role !== 'viewer') n.push({ group: 'Workspace', path: 'dashboard.html', label: 'Dashboard' });
  n.push(
    { group: 'Workspace', path: 'leads.html', label: 'Leads' },
    { group: 'Workspace', path: 'pipeline.html', label: 'Pipeline' },
    { group: 'Insight', path: 'reports.html', label: 'Reports' },
    { group: 'Insight', path: 'meta.html', label: 'Meta' },
  );
  if (['owner', 'admin', 'media_buyer'].includes(user.role)) n.push(
    { group: 'Integrations', path: 'integrations.html', label: 'Integrations' },
    { group: 'Ops', path: 'pilot', label: 'Pilot' },
    { group: 'Ops', path: 'alerts.html', label: 'Alerts' },
  );
  if (user.role === 'owner' || user.role === 'admin') n.push(
    { group: 'Admin', path: 'duplicates.html', label: 'Duplicates' },
    { group: 'Admin', path: 'admin.html', label: 'Admin' },
  );
  return n;
}

// ---------------------------------------------------------------- meta mock (used when live Meta API unavailable)
function mockMetaPull(adAccounts) {
  const campaigns = [
    ['CAM-101', 'LeadGen Webinar', 'campaign'],
    ['CAM-102', 'Workshop Cold Reach', 'campaign'],
  ];
  const adsets = [
    ['ADS-111', 'CAM-101', 'Webinar — lookalike', 'adset'],
    ['ADS-112', 'CAM-101', 'Webinar — retargeting', 'adset'],
    ['ADS-121', 'CAM-102', 'Workshop — cold', 'adset'],
    ['ADS-122', 'CAM-102', 'Workshop — cold 2', 'adset'],
  ];
  const ads = [
    ['AD-3001', 'ADS-111', 'Webinar hook A (video)', 'active', 'CR-501', 'img1'],
    ['AD-3002', 'ADS-111', 'Webinar hook B (creative)', 'active', 'CR-502', 'img2'],
    ['AD-3003', 'ADS-112', 'Webinar retarget', 'active', 'CR-503', 'img3'],
    ['AD-4001', 'ADS-121', 'Workshop offer 1', 'active', 'CR-511', 'img4'],
    ['AD-4002', 'ADS-122', 'Workshop offer 2', 'paused', 'CR-512', 'img5'],
  ];
  const now = new Date();
  const dates = [];
  for (let i = 6; i >= 0; i--) dates.push(now.toISOString().slice(0, 10).replace(/^(\d{4}-\d{2}-\d{2})/, (m) => new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10)));
  const uniq = [...new Set(dates)];
  const rng = (min, max) => Math.floor(min + Math.random() * (max - min));
  const out = { campaigns: [], adsets: [], ads: [], spend: [] };
  for (const a of adAccounts) {
    out.campaigns.push({ id: a.ad_account_id + '-101', name: campaigns[0][1], status: 'ACTIVE' });
    out.campaigns.push({ id: a.ad_account_id + '-102', name: campaigns[1][1], status: 'ACTIVE' });
    out.adsets.push({ id: a.ad_account_id + '-111', name: adsets[0][2], campaign_id: a.ad_account_id + '-101' });
    out.adsets.push({ id: a.ad_account_id + '-112', name: adsets[1][2], campaign_id: a.ad_account_id + '-101' });
    out.adsets.push({ id: a.ad_account_id + '-121', name: adsets[2][2], campaign_id: a.ad_account_id + '-102' });
    out.adsets.push({ id: a.ad_account_id + '-122', name: adsets[3][2], campaign_id: a.ad_account_id + '-102' });
    const adList = [
      { id: a.ad_account_id + '-3001', adset_id: a.ad_account_id + '-111', name: ads[0][2], status: 'ACTIVE', creative_img: 'img1' },
      { id: a.ad_account_id + '-3002', adset_id: a.ad_account_id + '-111', name: ads[1][2], status: 'ACTIVE', creative_img: 'img2' },
      { id: a.ad_account_id + '-3003', adset_id: a.ad_account_id + '-112', name: ads[2][2], status: 'ACTIVE', creative_img: 'img3' },
      { id: a.ad_account_id + '-4001', adset_id: a.ad_account_id + '-121', name: ads[3][2], status: 'ACTIVE', creative_img: 'img4' },
      { id: a.ad_account_id + '-4002', adset_id: a.ad_account_id + '-122', name: ads[4][2], status: 'PAUSED', creative_img: 'img5' },
    ];
    for (const ad of adList) out.ads.push({ ...ad, status: ad.status });
    for (const d of uniq) {
      const sp = d === uniq[uniq.length - 1] ? rng(2000, 9000) : rng(4000, 22000);
      for (const ad of adList) {
        const share = [0.32, 0.28, 0.2, 0.13, 0.07][adList.indexOf(ad)];
        out.spend.push({
          ad_id: ad.id, date: d, ad_account_id: a.ad_account_id,
          spend: Math.round(sp * share),
          impressions: Math.round(rng(3000, 14000) * share * 100) / 100,
          reach: Math.round(rng(2000, 9000) * share * 100) / 100,
          clicks: rng(40, 300),
          // Meta-reported conversions (synthetic): a fraction of clicks, jittered
          // a touch so the Meta-vs-Track delta column has something to show.
          conversions: Math.max(0, Math.round(rng(40, 300) * share * (0.35 + Math.random() * 0.4))),
        });
      }
    }
  }
  return out;
}

module.exports = {
  normPhone, normEmail, sha256, capiHashedPhone, capiHashedEmail,
  buildCapiEvent, buildCapiPayload, maskPhone, maskEmail, roleSeesFullContacts, toCsv, toExcel,
  DEFAULT_STAGES, STAGE_EVENTS, autoStage, stageOrder,
  attributeSale, adClicksInWindow, isWithinRange,
  funnelReport, adPerformance, metaAccountReport, sparklineSvg, wastedSpend, newVsOld, metaVsTracker, sourceMix, weeklySummary, weeklyPdfLines,
  allowedClients,
  esc, fmtINR, fmtN, fmtPct, fmtDT, layout, layoutDemoBand, layoutAccSelect, NAV, navFor, mockMetaPull,
};
