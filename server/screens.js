// Server-rendered screens. Each function: (db, user, params) -> html.
const S = require('./lib/shared');
const { makeTx } = require('./db');

const H = {
  esc: S.esc, inr: S.fmtINR, n: S.fmtN, pct: S.fmtPct, dt: S.fmtDT,
};

function userHasPhone(u) {
  return S.roleSeesFullContacts(u.role);
}
function phoneOf(u, lead) {
  if (!lead) return '';
  return userHasPhone(u) ? (lead.phone || '') : S.maskPhone(lead.phone);
}
// S.4: emails are masked for every role that does not see full contacts
function emailOf(u, lead) {
  if (!lead || !lead.email) return '—';
  return userHasPhone(u) ? lead.email : S.maskEmail(lead.email);
}

// ---------------------------------------------------------------- Dashboard
function dashboard(db, user, p) {
  const tx = makeTx(db);
  const settings = {
    attribution_model: tx.get(`SELECT value FROM settings WHERE key='attribution_model'`)?.value || 'last_paid_click',
    attribution_window_days: tx.get(`SELECT value FROM settings WHERE key='attribution_window_days'`)?.value || '30',
    wasted_spend_threshold: tx.get(`SELECT value FROM settings WHERE key='wasted_spend_threshold'`)?.value || '0',
  };
  // client logins are scoped to their own data; team roles see all internal clients
  const scopeIds = user.role === 'client' ? (user.client_ids || '').split(',').filter(Boolean) : null;
  const fp = S.funnelReport(tx, null, settings, scopeIds);
  const ap = S.adPerformance(tx, settings, scopeIds);
  const mix = S.sourceMix(tx, scopeIds);
  const totalLeads = scopeIds
    ? tx.get(`SELECT COUNT(*) c FROM lead WHERE client_id IN (${scopeIds.map((n) => Number(n)).join(',')})`)?.c || 0
    : tx.get(`SELECT COUNT(*) c FROM lead`)?.c || 0;
  const recentWhere = scopeIds ? `WHERE l.client_id IN (${scopeIds.map((n) => Number(n)).join(',')})` : '';
  const recent = tx.all(`SELECT l.id, l.name, l.phone, l.email, l.stage, l.client_id, l.created_at, c.name client_name
    FROM lead l LEFT JOIN client c ON c.id=l.client_id ${recentWhere} ORDER BY l.id DESC LIMIT 8`);

  const funnelSteps = [
    { l: 'Leads', v: fp.leads, max: fp.leads || 1, c: 'b' },
    { l: 'Registered', v: fp.registered, max: fp.leads || 1, c: 'p' },
    { l: 'Attended', v: fp.attended, max: fp.leads || 1, c: 'o' },
    { l: 'Calls', v: fp.calls, max: fp.leads || 1, c: 'g' },
    { l: 'Paid', v: fp.paid, max: fp.leads || 1, c: 'g' },
  ];
  const funnelBars = funnelSteps.map((s) => `
    <div style="margin-bottom:9px">
      <div class="row" style="gap:8px"><div style="width:96px" class="muted small">${s.l}</div>
      <div class="bar" style="flex:1"><i style="width:${Math.max(2, (s.v / s.max) * 100)}%;background:var(--${s.c})"></i></div>
      <div style="width:64px;text-align:right" class="small">${S.fmtN(s.v)}</div></div>
    </div>`).join('');

  const mixChips = mix.map((m) => `<span class="chip"><b>${S.esc(m.src)}</b> ${m.c}</span>`).join('');

  const kpis = [
    { l: 'Total leads', v: S.fmtN(totalLeads) },
    { l: 'Show-up rate', v: S.fmtPct(fp.show_up_rate) },
    { l: 'Close rate', v: S.fmtPct(fp.close_rate) },
    { l: 'Cost per lead', v: fp.cpl != null ? S.fmtINR(fp.cpl) : '—' },
    { l: 'Net revenue', v: S.fmtINR(fp.revenue) },
    { l: 'Ad spend', v: S.fmtINR(fp.spend) },
    { l: 'ROAS', v: ap.total.roas != null ? ap.total.roas : '—' },
    { l: 'Profit', v: S.fmtINR(ap.total.profit) },
  ].map((k) => `<div class="kpi"><div class="l">${k.l}</div><div class="v">${k.v}</div></div>`).join('');

  const recentRows = recent.map((r) => `<tr>
    <td><a href="/lead/${r.id}">${S.esc(r.name || '—')}</a></td>
    <td class="small muted">${S.esc(r.client_name || '')}</td>
    <td class="small">${phoneOf(user, r)}</td>
    <td><span class="pill ${stagePillClass(r.stage)}">${S.esc(r.stage)}</span></td>
    <td class="small muted">${S.fmtDT(r.created_at)}</td></tr>`).join('');

  const body = `
  <h1>Dashboard</h1>
  <div class="grid g4">${kpis}</div>
  <div class="grid g2" style="margin-top:14px">
    <div class="card"><h2>Funnel</h2>${funnelBars}
      <div class="note">Attribution model: <b>${S.esc(settings.attribution_model)}</b> · window ${settings.attribution_window_days}d · revenue net of refunds.</div></div>
    <div class="card"><h2>Lead source mix</h2>${mixChips || '<span class="muted">No leads yet</span>'}
      <h2 style="margin-top:14px">Recent leads</h2>
      <div class="tabwrap"><table>${recentRows || '<tr><td class="muted">No leads</td></tr>'}</table></div></div>
  </div>`;
  return S.layout({ title: 'Dashboard', nav: S.navFor(user), active: 'dashboard.html', user, body });
}
function stagePillClass(s) {
  if (['Paid'].includes(s)) return 'g';
  if (['Attended', 'Hot', 'Call Booked', 'Registered'].includes(s)) return 'o';
  if (['Lost'].includes(s)) return 'r';
  return 'b';
}

// ---------------------------------------------------------------- Lead list
function leads(db, user, p) {
  const tx = makeTx(db);
  const q = (p.q || '').trim();
  const stage = p.stage || '';
  // client logins only ever see their own client; team roles can filter
  const scopeIds = user.role === 'client' ? (user.client_ids || '').split(',').filter(Boolean) : [];
  const client = user.role === 'client' ? String(scopeIds[0] || '') : (p.client || '');
  let where = `1=1`;
  const args = [];
  if (q) { where += ` AND (l.phone LIKE ? OR l.email LIKE ? OR l.name LIKE ?)`; args.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  if (stage) { where += ` AND l.stage = ?`; args.push(stage); }
  if (client) { where += ` AND l.client_id = ?`; args.push(client); }
  const rows = tx.all(`SELECT l.*, c.name client_name,
      (SELECT COUNT(*) FROM event e WHERE e.lead_id=l.id) ev,
      (SELECT COALESCE(SUM(d.amount),0) FROM deal d WHERE d.lead_id=l.id AND d.status='success' AND d.refunded_at IS NULL) paid
    FROM lead l LEFT JOIN client c ON c.id=l.client_id WHERE ${where}
    ORDER BY l.id DESC LIMIT 200`, ...args);
  const stages = S.DEFAULT_STAGES;
  // a client login only sees its own client in the filter; team roles see all
  const clients = user.role === 'client'
    ? tx.all(`SELECT id, name FROM client WHERE id IN (${scopeIds.map((n) => Number(n)).join(',')})`)
    : tx.all(`SELECT id, name FROM client`);
  const rowsHtml = rows.map((r) => `<tr>
    <td><a href="/lead/${r.id}">${S.esc(r.name || '—')} ${r.source_unknown ? '<span class="pill m">unknown source</span>' : ''}</a></td>
    <td class="small muted">${S.esc(r.client_name || '')}</td>
    <td class="small">${phoneOf(user, r)}</td>
    <td class="small muted">${S.esc(emailOf(user, r))}</td>
    <td><span class="pill ${stagePillClass(r.stage)}">${S.esc(r.stage)}</span></td>
    <td class="small">${S.esc(r.owner || '—')}</td>
    <td class="small">${S.fmtINR(r.paid)}</td>
    <td class="small muted">${r.ev}</td>
  </tr>`).join('');
  const body = `
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <h1 style="margin:0">Leads <span class="badge">${rows.length} shown</span></h1>
      <a class="btn sec" href="/import">Import CSV</a>
    </div>
    <form class="inline" method="get" action="/leads" style="margin-top:12px">
      <div><label>Search</label><input name="q" placeholder="phone / email / name" value="${S.esc(q)}"></div>
      <div><label>Stage</label><select name="stage"><option value="">All</option>${stages.map((s) => `<option ${s === stage ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label>Client</label><select name="client"><option value="">All</option>${clients.map((c) => `<option value="${c.id}" ${String(c.id) === client ? 'selected' : ''}>${S.esc(c.name)}</option>`).join('')}</select></div>
      <button class="btn" type="submit">Filter</button>
    </form>
  </div>
  <div class="card">
    <div class="tabwrap"><table>
      <thead><tr><th>Name</th><th>Client</th><th>Phone</th><th>Email</th><th>Stage</th><th>Owner</th><th>Paid</th><th>Events</th></tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="8" class="muted">No leads match</td></tr>'}</tbody>
    </table></div>
  </div>`;
  return S.layout({ title: 'Leads', nav: S.navFor(user), active: 'leads', user, body });
}

// ---------------------------------------------------------------- Lead timeline
function leadTimeline(db, user, p) {
  const tx = makeTx(db);
  const lead = tx.get(`SELECT l.*, c.name client_name FROM lead l LEFT JOIN client c ON c.id=l.client_id WHERE l.id=?`, p.id);
  if (!lead) return notFound(user);
  // PRD §10: row-level isolation at the route too. A client login may only
  // view leads of its own client_ids; everyone else gets a not-found.
  const sec = require('./lib/security');
  if (!sec.canAccessClient(user, lead.client_id)) return notFound(user);
  const tps = tx.all(`SELECT * FROM touchpoint WHERE lead_id=? ORDER BY ts`, lead.id);
  const events = tx.all(`SELECT * FROM event WHERE lead_id=? ORDER BY ts DESC`, lead.id);
  const deals = tx.all(`SELECT * FROM deal WHERE lead_id=?`, lead.id);
  const totalPaid = deals.filter((d) => d.status === 'success' && !d.refunded_at).reduce((a, b) => a + b.amount, 0);
  const adTps = tps.filter((t) => t.ad_id && t.ad_id !== 'unknown');
  const firstAd = adTps[0], lastAd = adTps[adTps.length - 1];
  const adMeta = (id) => id ? tx.get(`SELECT * FROM meta_ad WHERE id=?`, id) : null;
  const firstMeta = adMeta(firstAd?.ad_id), lastMeta = adMeta(lastAd?.ad_id);

  const adCard = (meta, tp, label) => {
    if (!meta) return `<div class="kpi"><div class="l">${label}</div><div class="v muted" style="font-size:15px">Not from an ad</div></div>`;
    return `<div class="kpi">
      <div class="l">${label}</div>
      <div class="row" style="gap:10px;margin-top:6px">
        <img class="lead-img" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='52' height='52'><rect width='52' height='52' rx='8' fill='%23252c40'/><text x='50%25' y='55%25' font-size='11' fill='%234f8cff' text-anchor='middle'>${S.esc((meta.name || '').slice(0, 4))}</text></svg>" alt="ad">
        <div><div style="font-weight:600">${S.esc(meta.name)}</div>
        <div class="small muted">${S.esc(meta.creative_img || '')} · ${S.esc(meta.status)}</div>
        ${tp ? `<div class="small muted">${S.esc(tp.utm_campaign || 'UTM campaign')}</div>` : ''}
        </div></div>
      </div>`;
  };

  const evIcon = (t) => ({ payment_success: 'g', refund: 'r', webinar_joined: 'o', call_booked: 'p', registered: 'b', meta_form_lead: 'b', ad_click: 'm' }[t] || 'm');
  const evRows = events.map((e) => {
    let extra = '';
    if (e.type === 'payment_success') extra = ` · ${S.fmtINR(e.value)}`;
    if (e.type === 'refund') extra = ` · refund${e.value != null ? ' ' + S.fmtINR(e.value) : ''}`;
    if (e.type === 'stage_changed') { try { const d = JSON.parse(e.raw_payload || '{}'); extra = ` · ${S.esc(d.from || '')} → ${S.esc(d.to || '')}`; } catch {} }
    const metaTag = e.sent_to_meta ? ` <span class="pill g">→ Meta${e.meta_match_quality ? ' (MQ ' + e.meta_match_quality + ')' : ''}</span>` : '';
    return `<div class="ev ${e.sent_to_meta ? 'g' : ''}"><div class="row" style="gap:8px">
      <span class="pill ${e.sent_to_meta ? 'g' : 'b'}">${S.esc(e.type)}</span>
      <span class="small muted">${S.esc(e.source_platform || '')}</span>${metaTag}
      <div class="sp"></div><span class="small muted">${S.fmtDT(e.ts)}</span></div>
      <div class="small muted">${extra}</div></div>`;
  }).join('');
  const dealRows = deals.map((d) => `<tr><td>${S.esc(d.product || '—')}</td><td>${S.fmtINR(d.amount)}</td>
    <td>${S.esc(d.gateway)}</td><td>${S.esc(d.gateway_txn_id || '')}</td>
    <td><span class="pill ${d.status === 'success' ? 'g' : d.status === 'refunded' ? 'r' : 'm'}">${S.esc(d.status)}</span></td>
    <td class="small muted">${S.fmtDT(d.paid_at)}</td></tr>`).join('');

  const stages = S.DEFAULT_STAGES;
  const body = `
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <div>
        <h1 style="margin:0">${S.esc(lead.name || 'Unnamed lead')}</h1>
        <div class="small muted">${S.esc(lead.client_name || '')} · ${phoneOf(user, lead)} · ${S.esc(emailOf(user, lead))} · ${S.esc(lead.city || '')}</div>
      </div>
      <div style="text-align:right">
        <span class="pill ${stagePillClass(lead.stage)}">${S.esc(lead.stage)}</span>
        <div class="small muted">Owner: ${S.esc(lead.owner || 'unassigned')} · Total paid ${S.fmtINR(totalPaid)}</div>
      </div>
    </div>
    <form class="inline" method="post" action="/lead/${lead.id}/update" style="margin-top:12px">
      <div><label>Stage</label><select name="stage">${stages.map((s) => `<option ${s === lead.stage ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label>Assign to</label><input name="owner" value="${S.esc(lead.owner || '')}" placeholder="reps name"></div>
      <button class="btn sec">Update</button>
      <a class="btn sec" href="/lead/${lead.id}/events/new">+ Note / Task</a>
    </form>
  </div>
  <div class="grid g2">
    ${adCard(firstMeta, firstAd, 'First ad clicked')}
    ${adCard(lastMeta, lastAd, 'Last ad clicked')}
  </div>
  <div class="grid g3" style="margin-top:12px">
    <div class="kpi"><div class="l">Ad clicks on this lead</div><div class="v">${adTps.length}</div></div>
    <div class="kpi"><div class="l">Total touchpoints</div><div class="v">${tps.length}</div></div>
    <div class="kpi"><div class="l">Events</div><div class="v">${events.length}</div></div>
  </div>
  <div class="card" style="margin-top:14px"><h2>Payments</h2>
    <div class="tabwrap"><table><thead><tr><th>Product</th><th>Amount</th><th>Gateway</th><th>Txn</th><th>Status</th><th>Paid at</th></tr></thead>
    <tbody>${dealRows || '<tr><td class="muted">No payments</td></tr>'}</tbody></table></div></div>
  <div class="card"><h2>Timeline <span class="badge">newest first, IST</span></h2>
    <div class="tl">${evRows || '<div class="muted">No events yet</div>'}</div></div>`;
  return S.layout({ title: lead.name || 'Lead', nav: S.navFor(user), active: 'leads.html', user, body });
}

// ---------------------------------------------------------------- Pipeline kanban
function pipeline(db, user, p) {
  const tx = makeTx(db);
  const sec = require('./lib/security');
  // a client login is locked to its own clients; the ?client= filter cannot widen it
  let client = p.client || '';
  if (user.role === 'client') client = String((user.client_ids || '').split(',')[0] || '');
  const stages = S.DEFAULT_STAGES;
  const where = client ? `AND l.client_id=?` : '';
  const args = client ? [client] : [];
  const cols = stages.map((s) => {
    const rows = tx.all(`SELECT l.*, c.name client_name FROM lead l LEFT JOIN client c ON c.id=l.client_id WHERE l.stage=? ${where} ORDER BY l.id DESC LIMIT 40`, s, ...args);
    const cards = rows.map((r) => `<div class="kcard"><a href="/lead/${r.id}">${S.esc(r.name || '—')}</a>
      <div class="small muted">${S.esc(r.client_name || '')} · ${phoneOf(user, r)}</div></div>`).join('');
    return `<div class="kcol"><h3>${s} <span class="badge">${rows.length}</span></h3>${cards || '<div class="muted small">empty</div>'}</div>`;
  }).join('');
  const clients = user.role === 'client'
    ? tx.all(`SELECT id, name FROM client WHERE id IN (${(user.client_ids || '').split(',').filter(Boolean).map((n) => Number(n)).join(',') || '0'})`)
    : tx.all(`SELECT id, name FROM client`);
  const body = `
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <h1 style="margin:0">Pipeline</h1>
      <form method="get" action="/pipeline.html" class="inline">
        <div><label>Client</label><select name="client"><option value="">All</option>${clients.map((c) => `<option value="${c.id}" ${String(c.id) === client ? 'selected' : ''}>${S.esc(c.name)}</option>`).join('')}</select></div>
        <button class="btn sec">Apply</button></form>
    </div>
  </div>
  <div class="kanban">${cols}</div>`;
  return S.layout({ title: 'Pipeline', nav: S.navFor(user), active: 'pipeline.html', user, body });
}

// ---------------------------------------------------------------- Reports
function reports(db, user, p) {
  const tx = makeTx(db);
  const settings = {
    attribution_model: p.model || tx.get(`SELECT value FROM settings WHERE key='attribution_model'`)?.value || 'last_paid_click',
    attribution_window_days: p.window || tx.get(`SELECT value FROM settings WHERE key='attribution_window_days'`)?.value || '30',
    wasted_spend_threshold: tx.get(`SELECT value FROM settings WHERE key='wasted_spend_threshold'`)?.value || '0',
    report_from: p.from || null, report_to: p.to || null,
  };
  // client-scoped reports: a client login sees only their own numbers
  const clientFilter = String(p.client || '');
  const scopeIds = user.role === 'client'
    ? (user.client_ids || '').split(',').filter(Boolean)
    : (clientFilter ? [clientFilter] : null);
  const allClients = tx.all(`SELECT id, name FROM client`);
  const ap = S.adPerformance(tx, settings, scopeIds);
  const fp = S.funnelReport(tx, null, settings, scopeIds);
  const waste = S.wastedSpend(ap);
  const mix = S.sourceMix(tx, scopeIds);
  const models = ['last_paid_click', 'first_click', 'linear', 'lead_source'];
  const modelNames = { last_paid_click: 'Last paid click (default)', first_click: 'First click', linear: 'Linear', lead_source: 'Lead source' };

  const adRows = ap.rows.map((r) => `<tr>
    <td><img class="lead-img" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='52' height='52'><rect width='52' height='52' rx='8' fill='%23252c40'/></svg>" style="width:34px;height:34px">
      <a href="/lead-ads?ad=${r.ad_id}"><b>${S.esc(r.name)}</b></a>
      <div class="small muted">${S.esc(r.campaign)} · ${S.esc(r.account || '')}</div></td>
    <td>${S.esc(r.status)}</td>
    <td>${S.fmtINR(r.spend)}</td>
    <td class="small">${S.fmtN(r.impressions)}</td>
    <td class="small">${S.fmtN(r.clicks)}</td>
    <td>${r.cpm != null ? S.fmtINR(r.cpm) : '—'}</td>
    <td>${S.fmtN(r.leads)}</td>
    <td>${S.fmtINR(r.revenue)}</td>
    <td>${r.roas != null ? r.roas : '—'}</td>
    <td>${S.fmtINR(r.profit)} ${r.wasted ? '<span class="pill r">wasted</span>' : ''}</td>
  </tr>`).join('');

  const wasteRows = waste.map((r) => `<tr><td>${S.esc(r.name)}</td><td>${S.fmtINR(r.spend)}</td><td class="muted">${S.fmtN(r.impressions)} imp</td>
    <td>${r.leads} leads</td><td><span class="pill r">0 sales</span></td></tr>`).join('');

  const fv = [
    ['Ad spend', S.fmtINR(fp.spend)], ['Leads', S.fmtN(fp.leads)],
    ['CPL', fp.cpl != null ? S.fmtINR(fp.cpl) : '—'], ['Registered', S.fmtN(fp.registered)],
    ['Attended', S.fmtN(fp.attended)], ['Show-up rate', S.fmtPct(fp.show_up_rate)],
    ['Calls', S.fmtN(fp.calls)], ['Sales (net)', S.fmtN(fp.paid)], ['Revenue', S.fmtINR(fp.revenue)],
    ['Cost per sale', fp.cost_per_sale != null ? S.fmtINR(fp.cost_per_sale) : '—'],
    ['Close rate', S.fmtPct(fp.close_rate)], ['ROAS', ap.total.roas != null ? ap.total.roas : '—'],
  ].map((x) => `<div class="kpi"><div class="l">${x[0]}</div><div class="v" style="font-size:18px">${x[1]}</div></div>`).join('');

  const mixChips = mix.map((m) => `<span class="chip"><b>${S.esc(m.src)}</b> ${m.c}</span>`).join('');
  const attr = fp.attribution;
  const body = `
  <div class="card">
    <div class="row" style="justify-content:space-between">
      <h1 style="margin:0">Reports <span class="badge">attribution: ${modelNames[settings.attribution_model] || settings.attribution_model}, ${settings.attribution_window_days}d window</span></h1>
    </div>
    <form class="inline" method="get" action="/reports.html" style="margin-top:10px">
      ${user.role !== 'client' ? `<div><label>Client</label><select name="client"><option value="">All clients</option>${allClients.map((c) => `<option value="${c.id}" ${clientFilter === String(c.id) ? 'selected' : ''}>${S.esc(c.name)}</option>`).join('')}</select></div>` : ''}
      <div><label>Model</label><select name="model">${models.map((m) => `<option value="${m}" ${m === settings.attribution_model ? 'selected' : ''}>${modelNames[m]}</option>`).join('')}</select></div>
      <div><label>Window</label><select name="window">${[7, 14, 30, 60].map((w) => `<option ${String(w) === settings.attribution_window_days ? 'selected' : ''}>${w}d</option>`).join('')}</select></div>
      <div><label>From</label><input type="date" name="from" value="${S.esc(settings.report_from || '')}"></div>
      <div><label>To</label><input type="date" name="to" value="${S.esc(settings.report_to || '')}"></div>
      <button class="btn">Apply</button>
    </form>
    <div class="note">Every sale is credited to one ad by this fixed rule and the report states which rule it used. Sales with no ad click in the window go to <b>Organic / unknown</b>. Every number links to the leads behind it; revenue is net of refunds. ${user.role === 'client' ? '<b>This report is limited to your own client data.</b>' : ''}</div>
  </div>

  <div class="card"><h2>Funnel ${user.role === 'client' ? '(your client)' : clientFilter ? '(selected client)' : '(all clients)'}</h2><div class="grid g4" style="grid-template-columns:repeat(4,1fr)">${fv}</div>
    <div class="small muted" style="margin-top:8px">Attribution buckets: <span class="pill b">${attr.attributed} attributed</span>
      <span class="pill m">${attr.organic} organic/unknown</span> <span class="badge">${settings.attribution_model}</span></div></div>

  <div class="card"><h2>Ad performance</h2>
    <div class="tabwrap"><table><thead><tr><th>Ad</th><th>Status</th><th>Spend</th><th>Impr.</th><th>Clicks</th><th>CPM</th><th>Leads</th><th>Revenue</th><th>ROAS</th><th>Profit</th></tr></thead>
    <tbody>${adRows || '<tr><td class="muted">No ads pulled yet (Meta pull pending)</td></tr>'}</tbody></table></div>
    <div class="small muted" style="margin-top:8px">Total: spend ${S.fmtINR(ap.total.spend)} · revenue ${S.fmtINR(ap.total.revenue)} · leads ${ap.total.leads} · ROAS ${ap.total.roas ?? '—'} · wasted ads ${ap.total.wasted_ads}</div>
  </div>

  <div class="grid g2">
    <div class="card"><h2>Wasted spend <span class="badge">≥ ${settings.wasted_spend_threshold} spend, 0 sales</span></h2>
      <div class="tabwrap"><table><thead><tr><th>Ad</th><th>Spend</th><th>Impr.</th><th>Leads</th><th></th></tr></thead>
      <tbody>${wasteRows || '<tr><td class="muted">No wasted spend</td></tr>'}</tbody></table></div></div>
    <div class="card"><h2>Lead source mix</h2>${mixChips || '<span class="muted">—</span>'}
      <h2 style="margin-top:14px">Meta vs Xacqora Track</h2>
      <div class="small muted">Meta-reported lead events: <b>${fp.attribution.sales_count ?? ''}</b> sales in funnel vs ${attr.organic} unattributed.
      Compare Meta Ads Manager "Conversions" column against the Ad performance table; the delta is where Meta over/under-reports. (Person-level data never comes back from Meta.)</div>
      </div>
  </div>`;
  return S.layout({ title: 'Reports', nav: S.navFor(user), active: 'reports.html', user, body });
}

// ---------------------------------------------------------------- Meta hub
function meta(db, user, p) {
  const tx = makeTx(db);
  const accounts = tx.all(`SELECT a.*, c.name client_name FROM meta_ad_account a LEFT JOIN client c ON c.id=a.client_id`);
  const accRows = accounts.map((a) => `<tr>
    <td>${S.esc(a.name)} <span class="small muted">(${S.esc(a.client_name || '')})</span></td>
    <td class="small muted">${S.esc(a.ad_account_id)}</td>
    <td><span class="pill ${a.status === 'connected' ? 'g' : 'o'}">${S.esc(a.status)}</span></td>
    <td class="small muted">${S.fmtDT(a.last_pull_at)}</td>
    <td class="small muted">${a.last_error ? S.esc(a.last_error) : 'ok'}</td>
    <td><a class="btn sm sec" href="/meta/pull?acc=${a.id}">Pull now</a></td></tr>`).join('');
  const spend = tx.all(`SELECT s.ad_id, ad.name, s.date, s.spend, s.spend_inr, s.impressions, s.clicks FROM spend_daily s LEFT JOIN meta_ad ad ON ad.id=s.ad_id ORDER BY s.date DESC LIMIT 40`);
  const spendRows = spend.map((r) => `<tr><td class="small muted">${r.date}</td><td>${S.esc(r.name || r.ad_id)}</td>
    <td>${S.fmtINR(r.spend)}</td><td>${S.fmtINR(r.spend_inr)}</td><td class="small">${S.fmtN(r.impressions)}</td><td class="small">${S.fmtN(r.clicks)}</td></tr>`).join('');
  const capi = tx.all(`SELECT cl.*, e.lead_id, l.name lead_name FROM capi_log cl LEFT JOIN event e ON e.id=cl.event_row_id LEFT JOIN lead l ON l.id=e.lead_id ORDER BY cl.id DESC LIMIT 20`);
  const capiRows = capi.map((r) => `<tr><td class="small muted">${S.fmtDT(r.sent_at)}</td><td>${S.esc(r.event_name)}</td>
    <td>${S.esc(r.lead_name || '')}</td><td class="small muted">${S.esc(r.pixel_id)}</td>
    <td><span class="pill ${r.match_quality >= 7 ? 'g' : 'o'}">MQ ${r.match_quality ?? '—'}</span></td>
    <td>${r.dry_run ? '<span class="pill m">dry-run</span>' : '<span class="pill g">sent</span>'}</td>
    <td class="small muted">${S.esc((r.event_id || '').slice(0, 12))}…</td></tr>`).join('');
  const body = `
  <div class="card"><h2>Connected ad accounts <span class="badge">system-user token preferred, auto-pull every 3h + nightly</span></h2>
    <div class="tabwrap"><table><thead><tr><th>Account</th><th>ID</th><th>Status</th><th>Last pull</th><th>Error</th><th></th></tr></thead>
    <tbody>${accRows || '<tr><td class="muted">No ad accounts</td></tr>'}</tbody></table></div></div>
  <div class="card"><h2>Daily spend (recent)</h2>
    <div class="tabwrap"><table><thead><tr><th>Date</th><th>Ad</th><th>Spend</th><th>INR</th><th>Impr.</th><th>Clicks</th></tr></thead>
    <tbody>${spendRows || '<tr><td class="muted">Run a pull to load spend</td></tr>'}</tbody></table></div></div>
  <div class="card"><h2>CAPI push log <span class="badge">Lead / CompleteRegistration / Attended / Schedule / Purchase, dedup by event_id</span></h2>
    <div class="tabwrap"><table><thead><tr><th>When</th><th>Event</th><th>Lead</th><th>Pixel</th><th>Match</th><th></th><th>event_id</th></tr></thead>
    <tbody>${capiRows || '<tr><td class="muted">No CAPI events pushed yet</td></tr>'}</tbody></table></div>
    <div class="note">Rule: an event is never sent twice. A Purchase is never sent for a refunded payment — the refund stays in our records. Phone/email are SHA-256 hashed before leaving the server.</div>
  </div>`;
  return S.layout({ title: 'Meta', nav: S.navFor(user), active: 'meta.html', user, body });
}

// ---------------------------------------------------------------- Integrations
function integrations(db, user, p) {
  const tx = makeTx(db);
  const PLATFORMS = [
    ['meta_leadgen', 'Meta Lead Forms', 'Instant Form leads with ad IDs'],
    ['tagmango', 'TagMango', 'Course / workshop purchases'],
    ['razorpay', 'Razorpay', 'Payments'],
    ['cashfree', 'Cashfree', 'Payments'],
    ['cosmofeed', 'Cosmofeed', 'Purchases'],
    ['aevent', 'Aevent', 'Webinar registration & attendance'],
    ['zoom', 'Zoom', 'Webinar registration & attendance'],
    ['calendly', 'Calendly', 'Booked / cancelled calls'],
    ['flexifunnels', 'FlexiFunnels', 'Opt-ins & orders'],
    ['pabbly', 'Pabbly Connect', 'Anything + WhatsApp flows'],
    ['whatsapp', 'WhatsApp (WATI/Interakt/AiSensy)', 'Messages sent & replies'],
    ['google_sheets', 'Google Sheets / CSV', 'Old leads & sales backfill'],
  ];
  const clients = tx.all(`SELECT id, name FROM client`);
  const client1 = clients[0];
  const endpoints = tx.all(`SELECT * FROM webhook_endpoint`);
  const log = tx.all(`SELECT * FROM webhook_log ORDER BY id DESC LIMIT 30`);
  const logRows = log.map((r) => `<tr><td class="small muted">${S.fmtDT(r.ingested_at)}</td><td>${S.esc(r.platform)}</td>
    <td class="small muted">${S.esc(r.ref || '')}</td>
    <td><span class="pill ${r.status === 'processed' ? 'g' : r.status === 'failed' ? 'r' : 'o'}">${S.esc(r.status)}</span></td>
    <td class="small muted">${r.error ? S.esc(r.error) : ''}</td>
    ${r.test ? '<td class="small"><span class="pill p">test</span></td>' : '<td class="small muted"></td>'}</tr>`).join('');

  // per-client webhook cards for one selected client
  const cid = p.client || (client1 ? client1.id : '');
  const epRows = endpoints.filter((e) => String(e.client_id) === String(cid)).map((e) => `<div class="card">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">${S.esc(e.platform)}</h2>
      <button class="btn sm sec" data-test="${e.platform}" data-client="${e.client_id}">Send test event</button></div>
    <div class="small muted">Endpoint: <code>POST ${e.url}</code> · secret: <code>${S.esc(e.secret.slice(0, 4))}•••</code> · client ${S.esc(e.client_id)}</div>
  </div>`).join('');

  const body = `
  <div class="card"><h2>Platform adapters <span class="badge">each lands events on the right lead within 1 minute</span></h2>
    <div class="grid g3">${PLATFORMS.map((x) => `<div class="kpi"><div class="l">${S.esc(x[1])}</div><div class="small muted">${S.esc(x[2])}</div></div>`).join('')}</div>
    <div class="note">Where a platform has no direct webhook it is routed through Pabbly first. Every platform has a test button that sends a fake event and shows where it landed.</div>
  </div>
  <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">Webhooks for client</h2>
    <form method="get" class="inline" action="/integrations.html">
      <select name="client" onchange="this.form.submit()">${clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(cid) ? 'selected' : ''}>${S.esc(c.name)}</option>`).join('')}</select>
    </form></div>
    ${epRows || '<div class="muted" style="margin-top:10px">No endpoints configured for this client.</div>'}
  </div>
  <div class="card"><h2>Inbound webhook log <span class="badge">processed / failed / duplicate + retry</span></h2>
    <div class="tabwrap"><table><thead><tr><th>When</th><th>Platform</th><th>Ref</th><th>Status</th><th>Error</th><th></th></tr></thead>
    <tbody>${logRows || '<tr><td class="muted">No webhooks yet — use the test buttons above.</td></tr>'}</tbody></table></div>
  </div>
  <script>
    document.querySelectorAll('[data-test]').forEach(b=>b.onclick=async()=>{
      const r=await fetch('/api/ingest/'+b.dataset.test+'/test',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({client_id:Number(b.dataset.client)})});
      alert('Test event sent: '+r.status+' — refresh log');location.reload();});
  </script>`;
  return S.layout({ title: 'Integrations', nav: S.navFor(user), active: 'integrations.html', user, body });
}

// ---------------------------------------------------------------- Duplicates
function duplicates(db, user, p) {
  const tx = makeTx(db);
  const { likelyDuplicates } = require('./lib/identity');
  const clients = tx.all(`SELECT id, name FROM client`);
  const cid = p.client || clients[0]?.id;
  const dups = cid ? likelyDuplicates(tx, cid) : [];
  const rows = dups.map((d) => `<tr>
    <td><a href="/lead/${d.a.id}">${S.esc(d.a.name || '—')}</a> <span class="small muted">${S.esc(d.a.phone || '')}</span></td>
    <td><a href="/lead/${d.b.id}">${S.esc(d.b.name || '—')}</a> <span class="small muted">${S.esc(d.b.phone || '')}</span></td>
    <td class="small muted">${S.esc(d.email)}</td>
    <td><form class="inline" method="post" action="/duplicates/merge" style="gap:4px">
      <input type="hidden" name="keep" value="${d.a.id}"><input type="hidden" name="drop" value="${d.b.id}">
      <input type="hidden" name="client" value="${cid}">
      <select name="phone" id="ph-${d.a.id}"><option value="${S.esc(d.a.phone || '')}">${S.esc(d.a.phone || '(no phone)')}</option><option value="${S.esc(d.b.phone || '')}">${S.esc(d.b.phone || '(no phone)')}</option></select>
      <button class="btn sm sec">Merge</button></form></td>
  </tr>`).join('');
  const body = `
  <div class="card"><div class="row" style="justify-content:space-between"><h1 style="margin:0">Duplicate review</h1>
    <form method="get" class="inline" action="/duplicates.html"><select name="client">${clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(cid) ? 'selected' : ''}>${S.esc(c.name)}</option>`).join('')}</select></form></div>
    <div class="small muted" style="margin:10px 0">Same email, different phone — merge by a human. Same phone for different clients is never merged.</div>
  </div>
  <div class="card"><div class="tabwrap"><table><thead><tr><th>Keep</th><th>Merge into</th><th>Email</th><th>Action</th></tr></thead>
  <tbody>${rows || '<tr><td class="muted">No likely duplicates</td></tr>'}</tbody></table></div></div>`;
  return S.layout({ title: 'Duplicates', nav: S.navFor(user), active: 'duplicates.html', user, body });
}

// ---------------------------------------------------------------- Admin
function admin(db, user, p) {
  const tx = makeTx(db);
  const sec = require('./lib/security');
  // after enrolling, ?2fa=setup shows the current user's secret for the app
  const setupCard = (p && p['2fa'] === 'setup' && user.totp_enabled) ? (() => {
    const secret = sec.decryptSecret((tx.get(`SELECT totp_secret FROM user WHERE id=?`, user.id)?.totp_secret) || '');
    return `<div class="card" style="border-color:var(--green)"><h2>Set up your authenticator</h2>
      <div class="note">Scan this in Google Authenticator / 1Password, or enter the secret manually:</div>
      <div class="log" style="max-height:60px">${S.esc(secret)}</div>
      <div class="small muted" style="margin-top:6px">otpauth://totp/XacqoraTrack:${S.esc(user.email)}?secret=${S.esc(secret)} · Once set up, sign-in will ask for the 6-digit code.</div>
    </div>`;
  })() : '';
  const users = tx.all(`SELECT id, email, name, role, client_ids, totp_enabled FROM user`);
  const audit = tx.all(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 30`);
  const userRows = users.map((u) => `<tr><td>${S.esc(u.name)}</td><td class="small muted">${S.esc(u.email)}</td>
    <td><span class="pill b">${S.esc(u.role)}</span></td><td class="small muted">${S.esc(u.client_ids || 'all')}</td>
    <td>${u.totp_enabled ? '<span class="pill g">2FA on</span>' : '<span class="pill m">2FA off</span>'}</td></tr>`).join('');
  const auditRows = audit.map((a) => `<tr><td class="small muted">${S.fmtDT(a.ts)}</td><td>${S.esc(a.user_email || 'system')}</td>
    <td><span class="pill m">${S.esc(a.action)}</span></td><td class="small muted">${S.esc(a.entity || '')} ${S.esc(a.entity_id || '')}</td></tr>`).join('');
  const settings = {
    model: tx.get(`SELECT value FROM settings WHERE key='attribution_model'`)?.value || 'last_paid_click',
    window: tx.get(`SELECT value FROM settings WHERE key='attribution_window_days'`)?.value || '30',
    threshold: tx.get(`SELECT value FROM settings WHERE key='wasted_spend_threshold'`)?.value || '0',
    capi: tx.get(`SELECT value FROM settings WHERE key='capi'`)?.value || 'dry',
  };
  const body = `
  ${setupCard}
  <div class="grid g2">
    <div class="card"><h2>Users & roles <span class="badge">Owner · Admin · Media Buyer · Sales Rep · Viewer · Client</span></h2>
      <div class="tabwrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Clients</th><th>2FA</th></tr></thead>
      <tbody>${userRows}</tbody></table></div></div>
    <div class="card"><h2>Settings</h2>
      <form class="inline" method="post" action="/admin/settings">
        <div><label>Attribution model</label><select name="model">${['last_paid_click', 'first_click', 'linear', 'lead_source'].map((m) => `<option ${m === settings.model ? 'selected' : ''}>${m}</option>`).join('')}</select></div>
        <div><label>Window (days)</label><input name="window" value="${S.esc(settings.window)}" style="width:70px"></div>
        <div><label>Wasted ≥ spend</label><input name="threshold" value="${S.esc(settings.threshold)}" style="width:90px"></div>
        <div><label>CAPI mode</label><select name="capi"><option value="dry" ${settings.capi === 'dry' ? 'selected' : ''}>dry-run</option><option value="live" ${settings.capi === 'live' ? 'selected' : ''}>live</option></select></div>
        <button class="btn">Save</button>
      </form>
      <div class="note">Security checklist: RLS by client_id at DB level · encrypted Meta/gateway/webhook secrets · every inbound webhook signature-verified · 2FA on team logins · phone/email masked for roles without need · daily backups (restore tested monthly) · rate-limited public ingest.</div>
      <form class="inline" method="post" action="/admin/prune" style="margin-top:8px">
        <div><label>Delete a lead (privacy request)</label><input name="lead_id" placeholder="lead id" style="width:120px"></div>
        <button class="btn sec danger">Delete lead + stop CAPI</button>
      </form>
      <div style="margin-top:14px" class="note">
        <b>Two-factor login (TOTP)</b> for your account (owner@xacqora.local · ${user.name ? 'you' : ''}).
        ${user.totp_enabled ? '2FA is <b>enabled</b>.' : '2FA is <b>off</b>.'}
        <form class="inline" method="post" action="/admin/2fa" style="margin-top:8px">
          <input type="hidden" name="action" value="${user.totp_enabled ? 'disable' : 'enroll'}">
          <button class="btn sec sm">${user.totp_enabled ? 'Disable 2FA' : 'Enroll in 2FA'}</button>
        </form>
        ${user.totp_enabled ? '' : '<div class="small muted" style="margin-top:6px">Enrolling gives you an authenticator-app code; sign-in then requires the 6-digit code.</div>'}
      </div>
    </div>
  </div>
  <div class="card"><h2>Audit log <span class="badge">who viewed / exported / changed what</span></h2>
    <div class="tabwrap"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>Entity</th></tr></thead>
    <tbody>${auditRows || '<tr><td class="muted">No audit entries</td></tr>'}</tbody></table></div></div>`;
  return S.layout({ title: 'Admin', nav: S.navFor(user), active: 'admin.html', user, body });
}

// ---------------------------------------------------------------- Client portal
function portal(db, user, p) {
  const tx = makeTx(db);
  // client role: only their own client
  const myClients = user.role === 'client' ? (user.client_ids || '').split(',').filter(Boolean) : [];
  const cid = myClients[0];
  const where = user.role === 'client' ? `WHERE l.client_id=${cid}` : 'WHERE 1=1';
  const leads = tx.all(`SELECT l.*, c.name client_name FROM lead l LEFT JOIN client c ON c.id=l.client_id ${where} ORDER BY l.id DESC LIMIT 50`);
  const leadsRows = leads.map((r) => `<tr><td><a href="/lead/${r.id}">${S.esc(r.name || '—')}</a></td>
    <td class="small muted">${S.esc(r.client_name || '')}</td><td class="small">${phoneOf(user, r)}</td>
    <td><span class="pill ${stagePillClass(r.stage)}">${S.esc(r.stage)}</span></td></tr>`).join('');
  const body = `
  <h1>Client portal ${user.role === 'client' ? `· ${S.esc(myClients.join(','))}` : ''}</h1>
  <div class="note ${user.role === 'client' ? 'warn' : ''}">${user.role === 'client' ? 'You are in read-only client view. Only your own leads, funnels and reports are visible; export is logged to the audit trail.' : 'Switch to a client role (e.g. arpit@xacqora.local) to preview the client portal.'}</div>
  <div class="card"><h2>My leads</h2><div class="tabwrap"><table>
    <thead><tr><th>Name</th><th>Client</th><th>Phone</th><th>Stage</th></tr></thead>
    <tbody>${leadsRows || '<tr><td class="muted">No leads</td></tr>'}</tbody></table></div></div>`;
  return S.layout({ title: 'Portal', nav: S.navFor(user), active: 'dashboard.html', user, body });
}

function notFound(user) {
  return S.layout({ title: 'Not found', nav: S.navFor(user), active: '', user, body: '<div class="card"><h1>Not found</h1><div class="muted">That lead does not exist.</div></div>' });
}

module.exports = {
  dashboard, leads, leadTimeline, pipeline, reports, meta, integrations, duplicates, admin, portal,
  stagePillClass, notFound,
};
