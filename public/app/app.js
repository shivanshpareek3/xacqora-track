/* Xacqora Track — Phase F SPA. Hash-routed, cookie-authenticated, role-aware.
   Reads the JSON API (/api/app/*) and renders the SAME data the server-rendered
   screens show, in a polished dark UI. Zero dependencies; pairs with ui.js. */
(function () {
  'use strict';
  const { h, svg, clear, fmtINR, fmtINRk, fmtN, fmtPct, fmtDT, relTime, esc,
    stagePill, eventTone, platIcon, adThumb, spark, areaChart, donut, funnel,
    hbars, vbars, toast, modal, icon, STAGE_COLOR, hexA } = window.XT;

  const root = document.getElementById('root');
  const API = '/api/app';

  // ---------------------------------------------------------------- api
  async function api(path, opts) {
    const res = await fetch(API + path, Object.assign({ credentials: 'same-origin' }, opts));
    let body = null;
    try { body = await res.json(); } catch { /* 204 etc. */ }
    if (!res.ok && !body) throw new Error(res.status + ' ' + res.statusText);
    return body;
  }
  const get = (p) => api(p);
  const post = (p, data) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
  // surface a failed render as a card instead of a silent blank screen
  function showErr(e) {
    console.error('[app]', e);
    const m = root.querySelector('#main');
    if (m && !m.querySelector('.card.error')) {
      clear(m);
      m.append(h('div', { class: 'card error' },
        h('h1', { text: 'Something went wrong' }),
        h('div', { class: 'sub' }, String((e && e.message) || e)),
        h('button', { class: 'btn sm sec', style: { marginTop: 10 }, onclick: () => navigate() }, 'Retry')));
    } else if (!m) toast('Load failed: ' + ((e && e.message) || e), 'err');
  }

  // ---------------------------------------------------------------- state
  let ME = null;
  let LEAD_SEARCH = null;

  // ---------------------------------------------------------------- routes
  const ROUTES = {
    dashboard: { title: 'Dashboard', icon: 'dash', group: 'Workspace', roles: null, isPortal: true },
    leads: { title: 'Leads', icon: 'leads', group: 'Workspace', roles: null },
    pipeline: { title: 'Pipeline', icon: 'board', group: 'Workspace', roles: null },
    reports: { title: 'Reports', icon: 'chart', group: 'Insight', roles: null },
    meta: { title: 'Meta Hub', icon: 'bolt', group: 'Integrations', roles: 'teamOps' },
    integrations: { title: 'Integrations', icon: 'plug', group: 'Integrations', roles: 'teamOps' },
    webhooks: { title: 'Webhooks & API Keys', icon: 'key', group: 'Integrations', roles: 'teamOps' },
    duplicates: { title: 'Duplicates', icon: 'copy', group: 'Admin', roles: 'canAdmin' },
    admin: { title: 'Admin', icon: 'shield', group: 'Admin', roles: 'canAdmin' },
    pilot: { title: 'Pilot Gates', icon: 'gate', group: 'Ops', roles: 'teamOps' },
    alerts: { title: 'Alerts & Monitoring', icon: 'bell', group: 'Ops', roles: 'teamOps' },
  };
  function allowed(r) {
    if (!r.roles) return true;
    if (r.roles === 'teamOps') return ME.teamOps;
    if (r.roles === 'canAdmin') return ME.canAdmin;
    return true;
  }

  // ---------------------------------------------------------------- chrome
  function groups() {
    const order = ['Workspace', 'Insight', 'Integrations', 'Ops', 'Admin'];
    const out = {};
    for (const key of Object.keys(ROUTES)) {
      const r = ROUTES[key];
      if (!allowed(r)) continue;
      (out[r.group] = out[r.group] || []).push(key);
    }
    // keep a stable group order, drop empties
    return order.filter((g) => out[g] && out[g].length).map((g) => ({ name: g, items: out[g] }));
  }

  function chrome() {
    clear(root);
    const grps = groups();
    // portal users only see the dashboard (their workspace) + reports if allowed
    const nav = h('div', { class: 'nav' });
    grps.forEach((g) => {
      nav.append(h('div', { class: 'navgrp' }, g.name));
      g.items.forEach((key) => nav.append(navLink(key)));
   });

    const side = h('aside', { class: 'side' },
      h('div', { class: 'brand' },
        h('div', { class: 'logo' }, 'X'),
        h('div', {},
          h('div', { class: 'bt' }, 'XACQORA', h('span', { text: ' TRACK' })),
          h('div', { class: 'bs' }, 'Lead Attribution CRM'))),
      nav,
      h('div', { class: 'side-foot' },
        userCard()));

    const top = h('div', { class: 'topbar' });
    const main = h('main', { id: 'main' });
    // master v7 §1.4/§6: honest demo-data band. Rendered only while the server
    // runs in mock mode (api /me -> demo:true); once XACQORA_LIVE=1 flips it to
    // real gateways/Meta the band disappears and the numbers become real.
    if (ME && ME.demo) {
      const band = h('div', { class: 'demo-band', title: 'Mock mode: every figure on these screens comes from the seed fixtures, not a live gateway or Meta pull.' },
        'Demo data — the live pilot will show real numbers.');
      root.append(side, h('div', { class: 'content' }, band, top, main));
    } else {
      root.append(side, h('div', { class: 'content' }, top, main));
    }
    renderTopbar();
  }

  function navLink(key) {
    const r = ROUTES[key];
    const cur = hashKey();
    const a = h('a', { href: '#/' + key, class: cur === key ? 'on' : '' }, icon(r.icon, 17), r.title);
    return a;
  }

  function userCard() {
    const u = ME.user;
    const initials = (u.name || u.email || '?').split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();
    const sub = ME.clientRole
      ? 'Client · ' + (u.clientNames ? u.clientNames.join(', ') : (u.client_ids || ''))
      : (u.role || '').replace('_', ' ');
    return h('div', { class: 'usercard' },
      h('div', { class: 'avatar' }, initials),
      h('div', {},
        h('div', { class: 'un' }, u.name || u.email),
        h('div', { class: 'ur' }, sub)),
      h('a', { class: 'sign', href: '/signout', title: 'Sign out', onclick: (e) => { e.preventDefault(); window.location = '/signout'; } }, icon('out', 15)));
  }

  function renderTopbar() {
    const top = root.querySelector('.topbar');
    if (!top) return;
    clear(top);
    const key = hashKey();
    const r = ROUTES[key] || ROUTES.dashboard;
    const title = key === 'lead' ? 'Lead' : r.title;
    top.append(
      h('h1', { text: title }),
      h('span', { class: 'crumb' }, 'xacqora / ' + (key === 'lead' ? 'leads' : key)),
      h('span', { class: 'sp' }),
      h('div', { class: 'search' }, icon('search', 15),
        h('input', { type: 'text', placeholder: 'Search leads… (press /)', onKeydown: (e) => {
          if (e.key === 'Enter') { LEAD_SEARCH = e.target.value; hash('leads'); navigate(); }
        } })),
      h('a', { class: 'btn sm sec', href: '/dashboard.html' }, 'Classic UI'),
      h('span', { class: 'tag' }, ME.readOnly ? 'Read-only' : ME.teamOps ? 'Team' : ME.seesContacts ? 'Full contacts' : 'Masked contacts'));
  }

  // ---------------------------------------------------------------- router
  function parseHash() {
    let hsh = (location.hash || '#/dashboard').replace(/^#/, '');
    const qIdx = hsh.indexOf('?');
    const query = qIdx >= 0 ? hsh.slice(qIdx + 1) : '';
    if (qIdx >= 0) hsh = hsh.slice(0, qIdx);
    // drop the leading '/' and any empty segments: '/lead/101' -> ['lead','101']
    let [p1, p2] = hsh.split('/').filter(Boolean);
    p1 = p1 || 'dashboard';
    return { a: p1, b: p2 ? decodeURIComponent(p2) : null, query };
  }
  function hashKey() { return parseHash().a; }
  function hash(k, b) { location.hash = b != null ? '#/' + k + '/' + encodeURIComponent(b) : '#/' + k; }

  // route -> render function (defined as async fns below; order-independent)
  const RENDER = {
    dashboard: (m) => ME.clientRole ? renderPortal(m) : renderDashboard(m),
    leads: (m, b, q) => renderLeads(m, q),
    pipeline: (m) => renderPipeline(m),
    reports: (m, b, q) => renderReports(m, q),
    meta: (m) => renderMeta(m),
    integrations: (m, b, q) => renderIntegrations(m, q),
    webhooks: (m, b, q) => renderWebhooksKeys(m, q),
    duplicates: (m, b, q) => renderDuplicates(m, q),
    admin: (m) => renderAdmin(m),
    pilot: (m) => renderPilot(m),
    alerts: (m) => renderAlerts(m),
    lead: (m, b) => renderLead(m, b),
  };

  async function navigate() {
    if (!ME) { await boot(); if (!ME) return; }
    chrome();
    const { a, b, query } = parseHash();
    const main = root.querySelector('#main');
    clear(main);
    main.append(spin('Loading…'));
    const R = ROUTES[a];
    if (R && !allowed(R)) {
      main.clear();
      main.append(h('div', { class: 'card' }, h('h1', { text: 'Not allowed' }),
        h('div', { class: 'sub' }, 'Your role cannot open this screen. ',
          h('a', { href: '#/dashboard', text: 'Back to dashboard' }))));
      return;
    }
    const fn = RENDER[a];
    if (!fn) {
      main.clear();
      main.append(h('div', { class: 'card' }, h('h1', { text: 'Not found' }),
        h('div', { class: 'sub' }, 'Unknown screen ' + a + '. ', h('a', { href: '#/dashboard', text: 'Back to dashboard' }))));
      return;
    }
    fn(main, b, query);
  }

  function spin(label) {
    const s = h('div', { class: 'card', style: { display: 'flex', alignItems: 'center', gap: 12, padding: 40 } });
    const sp = h('span', { style: { width: 18, height: 18, border: '2px solid ' + '#24304d', borderTopColor: '#6d7cff', borderRadius: '50%', display: 'inline-block', animation: 'spin .7s linear infinite' } });
    const st = document.createElement('style');
    st.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
    s.append(st, sp, h('span', { class: 'muted', text: label || 'Loading…' }));
    return s;
  }

  // ---------------------------------------------------------------- boot
  async function boot() {
    const me = await get('/me');
    if (!me.user) { location.replace('/signin'); return; }
    ME = me;
    document.title = 'Xacqora Track — ' + ROUTES[hashKey()] ? 'Xacqora Track' : 'Xacqora Track';
    document.title = 'Xacqora Track';
  }

  // ================================================================ DASHBOARD
  const SRC_COLOR = { 'Meta Instant Form': '#6d7cff', 'Landing page form': '#2dd4bf', 'Organic / unknown': '#98a2c0' };
  function kpiCard(label, value, opts) {
    opts = opts || {};
    const sub = [];
    if (opts.delta != null) sub.push(h('span', { class: opts.delta >= 0 ? 'up' : 'dn' }, (opts.delta >= 0 ? '▲ ' : '▼ ') + Math.abs(opts.delta) + '%'));
    if (opts.spark) sub.push(opts.spark);
    if (opts.hint) sub.push(h('span', { text: opts.hint }));
    return h('div', { class: 'kpi' },
      h('div', { class: 'l' }, icon(opts.icon || 'chart', 14), label),
      h('div', { class: 'v', text: value }),
      sub.length ? h('div', { class: 's' }, sub) : null);
  }

  async function renderDashboard(main) {
    const d = await get('/dashboard');
    const fp = d.funnel.steps;
    const spendPts = (d.spendTrend || []).map((p) => ({ label: p.date.slice(5), y: p.spend }));
    const clickPts = (d.spendTrend || []).map((p) => ({ label: p.date.slice(5), y: p.clicks }));
    const k = d.kpis;
    // section 1: KPI strip — v14: new-leads rate (today / 7d) so live
    // FlexiFunnels / gateway webhooks make the dashboard move in real time.
    const kpis = h('div', { class: 'grid g4' },
      kpiCard('Leads today', fmtN(k.leadsToday != null ? k.leadsToday : 0), { icon: 'leads', hint: 'created in the last 24h' }),
      kpiCard('Leads (7d)', fmtN(k.leads7d != null ? k.leads7d : 0), { icon: 'chart', hint: 'created in the last 7 days' }),
      kpiCard('Total leads', fmtN(k.totalLeads), { icon: 'leads', spark: spark(spendPts.map((p) => p.y), '#6d7cff'), hint: 'all clients' }),
      kpiCard('Net revenue', fmtINRk(k.revenue), { icon: 'dollar', hint: fmtINR(k.revenue) }),
      kpiCard('Ad spend', fmtINRk(k.spend), { icon: 'bolt', hint: fmtINR(k.spend) }),
      kpiCard('ROAS', k.roas != null ? k.roas.toFixed(2) + '×' : '—', { icon: 'chart', hint: 'revenue ÷ spend' }),
      kpiCard('Show-up rate', fmtPct(k.showUp), { icon: 'clock', hint: 'attended ÷ registered' }),
      kpiCard('Close rate', fmtPct(k.close), { icon: 'gate', hint: 'paid ÷ registered' }),
      kpiCard('Cost / lead', k.cpl != null ? fmtINR(k.cpl) : '—', { icon: 'layers', hint: 'spend ÷ leads' }),
      kpiCard('Profit', fmtINRk(k.profit), { icon: 'dollar', hint: 'revenue − spend' }));

    // section 2: funnel + spend trend + source mix
    const funnelCard = h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', {}, h('h2', { text: 'Sales funnel' }), h('div', { class: 'sub' }, 'Leads → paid, with step conversion')), h('span', { class: 'sp' })),
      funnel([
        { label: 'Leads', value: fp.leads, color: '#38bdf8' },
        { label: 'Registered', value: fp.registered, color: '#6d7cff' },
        { label: 'Attended', value: fp.attended, color: '#fbbf24' },
        { label: 'Calls', value: fp.calls, color: '#a78bfa' },
        { label: 'Paid', value: fp.paid, color: '#34d399' },
      ]),
      h('div', { class: 'row small muted', style: { marginTop: 8 } },
        h('span', { text: 'Refunded ' + (fp.refunded || 0) }), h('span', { text: '·' }),
        h('span', { text: 'Attributed ' + fp.attribution.attributed }),
        h('span', { text: '· Organic ' + fp.attribution.organic })));
    const spendCard = h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('div', {}, h('h2', { text: 'Ad spend — 14 days' }), h('div', { class: 'sub' }, '₹ INR, all connected accounts')),
        h('div', { class: 'row', style: { gap: 12 } }, legendDot('#fb7185', 'Spend'), legendDot('#38bdf8', 'Clicks'))),
      h('div', { style: { marginTop: 12 } },
        areaChart([
          { color: '#fb7185', noArea: false, points: spendPts },
          { color: '#38bdf8', noArea: true, points: clickPts },
        ], { fmtY: fmtINRk, yLabel: '₹' })));
    const mixCard = h('div', { class: 'card' },
      h('h2', { text: 'Lead source mix' }),
      h('div', { class: 'sub' }, 'Where leads came from'),
      mixDonut(d.sourceMix));
    const charts = h('div', { class: 'grid g3' }, funnelCard, spendCard, mixCard);

    // section 3: top ads + recent leads
    const topAdsCard = h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { text: 'Top ads — spend vs revenue' }), h('span', { class: 'sp' }),
        h('a', { class: 'btn sm sec', href: '#/reports' }, 'Full report')),
      adMini((d.adPerf || {}).rows || []));
    const recentCard = h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('div', {}, h('h2', { text: 'New leads' }), h('div', { class: 'sub' }, 'Latest webhook / form events with their source')),
        h('span', { class: 'sp' }),
        h('a', { class: 'btn sm sec', href: '#/leads' }, 'All leads')),
      newLeadsTable(d.recent));
    const bottom = h('div', { class: 'grid g2' }, topAdsCard, recentCard);

    clear(main);
    main.append(
      banner('Attribution model ' + d.settings.attribution_model + ' · ' + d.settings.attribution_window_days + 'd window · revenue net of refunds. Every number drills into the leads behind it.', d.settings),
      kpis, charts, bottom);
  }

  // compact "top ads" card on the dashboard (reuses the dual-bar list)
  function adMini(rows) {
    if (!rows.length) return h('div', { class: 'empty' }, 'No ads pulled yet — open the Meta hub and run a pull.');
    const top = rows.slice(0, 6);
    return hbars(top.map((r) => ({ label: r.name, sub: r.campaign, spend: r.spend, revenue: r.revenue, roas: r.roas })),
      { dual: true, fmt: fmtINRk, valueLabel: (it) => it.roas != null ? it.roas.toFixed(2) + '×' : '—',
        valueColor: (it) => (it.roas != null ? (it.roas >= 1 ? 'var(--ok)' : 'var(--bad)') : 'var(--mut)') });
  }

  function legendDot(color, label) {
    return h('span', { class: 'small muted' }, h('span', { style: { display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: color, margin: '0 4px 0 0', verticalAlign: 'middle' } }), label);
  }
  function mixDonut(mix) {
    const segs = (mix || []).map((m) => ({ label: m.src, value: m.c, color: SRC_COLOR[m.src] || '#98a2c0' }));
    const total = segs.reduce((a, s) => a + s.value, 0);
    return segs.length ? donut(segs, { centerLabel: 'leads', centerValue: fmtN(total) }) : h('div', { class: 'empty' }, 'No leads yet');
  }

  // v14: dashboard "New leads" card — real webhook events (FlexiFunnels etc.)
  // fill this the moment they land: source platform, the form title the lead
  // came from, masked phone, and when it happened. Empty state is gone.
  function newLeadsTable(rows) {
    const t = h('div', { class: 'tblwrap', style: { marginTop: 10 } });
    if (!rows || !rows.length) { t.append(h('div', { class: 'empty' }, 'No leads yet — connect a webhook (Webhooks & API Keys) or wait for your first FlexiFunnels form.')); return t; }
    const th = h('thead', {}, h('tr', {}, h('th', {}, 'Lead'), h('th', {}, 'Source'), h('th', {}, 'Form / page'), h('th', {}, 'Phone'), h('th', {}, 'When')));
    const tb = h('tbody', {}, rows.map((r) => {
      // source: the event's platform; form title / page / UTM from the payload
      const src = r.source ? platIcon(r.source) : (r.utm_source ? h('span', { class: 'pill b' }, r.utm_source) : h('span', { class: 'td-muted' }, r.form_title ? 'form' : '—'));
      const formBit = r.page_url ? h('div', { class: 'td-muted small' }, r.page_url) : (r.form_title ? h('div', { class: 'td-muted small' }, 'form: ' + r.form_title) : null);
      return h('tr', {},
        h('td', {}, h('a', { class: 'leadlink', href: '#/lead/' + r.id, text: r.name || '—' })),
        h('td', {}, src),
        h('td', { class: 'td-muted small' }, formBit || '—'),
        h('td', { class: 'td-muted' }, r.phone || '—'),
        h('td', { class: 'td-muted', text: relTime(r.created_at) || fmtDT(r.created_at) }));
    }));
    t.append(th, tb);
    return t;
  }

  // ---------------------------------------------------------------- leads table
  function recentTable(rows) {
    const t = h('div', { class: 'tblwrap', style: { marginTop: 10 } });
    if (!rows || !rows.length) { t.append(h('div', { class: 'empty' }, 'No leads yet')); return t; }
    const th = h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Client'), h('th', {}, 'Stage'), h('th', {}, 'Phone'), h('th', {}, 'Added')));
    const tb = h('tbody', {}, rows.map((r) => h('tr', {},
      h('td', {}, h('a', { class: 'leadlink', href: '#/lead/' + r.id, text: r.name || '—' })),
      h('td', { class: 'td-muted', text: r.client_name || '—' }),
      h('td', {}, stagePill(r.stage)),
      h('td', { class: 'td-muted', text: r.phone || '—' }),
      h('td', { class: 'td-muted', text: relTime(r.created_at) || fmtDT(r.created_at) }))));
    t.append(th, tb);
    return t;
  }

  // ================================================================ LEADS
  // query = the raw hash query string (?q=&stage=&client=&ids=) so deep links
  // (e.g. #/leads?ids=1,2,3 from a report) work.
  async function renderLeads(main, query) {
    main.append(spin('Loading leads…'));
    const d = await get('/leads' + (query ? '?' + query : ''));
    clear(main);
    const idsCount = d.ids ? d.ids.length : 0;
    main.append(banner(
      idsCount ? 'Showing ' + idsCount + ' leads behind a report number. ' : ''
      + (ME.readOnly ? 'Read-only view — your role cannot edit.' : 'Click any lead for its full timeline. Filter by search, stage or client.'), null));
    main.append(filterBar(d, query));
    if (idsCount) main.append(h('div', { class: 'banner', style: { marginBottom: 0 } }, icon('chart', 18),
      h('span', {}, 'Drilled in from a report — showing ' + idsCount + ' leads behind it. ', h('a', { href: '#/leads' }, 'clear'))));
    main.append(leadsTable(d));
  }

  function filterBar(d, query) {
    const us = new URLSearchParams(query || '');
    const q0 = us.get('q') || '';
    const st0 = us.get('stage') || '';
    const cl0 = us.get('client') || '';
    function applyFilters() {
      const q = document.getElementById('lf-q').value;
      const st = document.getElementById('lf-stage').value;
      const cl = document.getElementById('lf-client').value;
      const us2 = new URLSearchParams();
      if (q) us2.set('q', q); if (st) us2.set('stage', st); if (cl) us2.set('client', cl);
      const s = us2.toString();
      LEAD_SEARCH = q || null;
      location.hash = '#/leads' + (s ? '?' + s : ''); // hashchange -> navigate() re-renders
    }
    return h('div', { class: 'card tight' },
      h('div', { class: 'formrow' },
        h('div', { class: 'fld grow' }, h('label', { text: 'Search' }),
          h('input', { type: 'text', value: q0, placeholder: 'name / phone / email', id: 'lf-q' })),
        h('div', { class: 'fld' }, h('label', { text: 'Stage' }),
          h('select', { id: 'lf-stage' },
            [h('option', { value: '', text: 'All' })].concat(d.stages.map((s) => h('option', { value: s, text: s, selected: s === st0 }))))),
        h('div', { class: 'fld' }, h('label', { text: 'Client' }),
          h('select', { id: 'lf-client' },
            [h('option', { value: '', text: 'All' })].concat(d.clients.map((c) => h('option', { value: c.id, text: c.name, selected: String(c.id) === cl0 }))))),
        h('button', { class: 'btn', onclick: applyFilters }, 'Apply'),
        h('span', { class: 'sp' }),
        h('a', { class: 'btn sm sec', href: '/export/leads?fmt=csv' }, 'Export CSV'),
        h('a', { class: 'btn sm sec', href: '/export/leads?fmt=excel' }, 'Excel')));
  }
  function leadsTable(d) {
    const t = h('div', { class: 'tblwrap' });
    if (!d.rows.length) { t.append(h('div', { class: 'empty' }, icon('leads', 30), 'No leads match. Clear the filters.')); return t; }
    const th = h('thead', {}, h('tr', {},
      h('th', {}, 'Name'), h('th', {}, 'Client'), h('th', {}, 'Phone'), h('th', {}, 'Email'),
      h('th', {}, 'Stage'), h('th', {}, 'Owner'), h('th', { class: 'num' }, 'Paid'), h('th', { class: 'num' }, 'Events')));
    const tb = h('tbody', {}, d.rows.map((r) => h('tr', {},
      h('td', {},
        h('a', { class: 'leadlink', href: '#/lead/' + r.id, text: r.name || '—' }),
        r.source_unknown ? h('span', { class: 'pill m', style: { marginLeft: 8 } }, 'unknown') : null),
      h('td', { class: 'td-muted', text: r.client_name || '—' }),
      h('td', { text: r.phone || '—' }),
      h('td', { class: 'td-muted', text: r.email || '—' }),
      h('td', {}, stagePill(r.stage)),
      h('td', { class: 'td-muted', text: r.owner || '—' }),
      h('td', { class: 'num', text: fmtINR(r.paid) }),
      h('td', { class: 'num td-muted', text: String(r.ev) }))));
    t.append(th, tb);
    return t;
  }

  // ================================================================ LEAD TIMELINE
  async function renderLead(main, id) {
    const L = await get('/lead/' + id);
    clear(main);
    const l = L.lead;
    // header card
    main.append(
      h('div', { class: 'card' },
        h('div', { class: 'row', style: { justifyContent: 'space-between' } },
          h('div', {},
            h('div', { class: 'row' },
              h('h1', { style: { fontSize: 22, margin: 0 } }, l.name || 'Unnamed lead'),
              stagePill(l.stage)),
            h('div', { class: 'row', style: { marginTop: 8, gap: 16 } },
              contactChip('phone', l.phone || '—'),
              contactChip('mail', l.email || '—'),
              l.city ? chip(l.city) : null,
              l.client_name ? chip(l.client_name) : null),
            h('div', { class: 'td-muted small', style: { marginTop: 6 } }, 'Owner: ' + (l.owner || 'unassigned') + ' · Total paid ' + fmtINR(L.totalPaid))),
          editLeadForm(L))),

      // v14: source card — where this lead came from. Ad-driven leads show the
      // ad creative; FlexiFunnels / UTM-driven leads (pages without xt.js) show
      // the form's ad link (utm_* / page_url captured on the webhook payload).
      L.sourceCard && L.sourceCard.kind !== 'organic' ? sourceCardBlock(L.sourceCard, L) : null,
      // ad source cards
      h('div', { class: 'grid g2' },
        adCardBlock('First ad clicked', L.adCards.first, L.adCards),
        adCardBlock('Last ad clicked', L.adCards.last, L.adCards)),

      // KPI strip
      h('div', { class: 'grid g3' },
        kpiCard('Ad clicks on this lead', fmtN(L.adCards.clicks), { icon: 'bolt' }),
        kpiCard('Total touchpoints', fmtN(L.touchpoints.length), { icon: 'layers' }),
        kpiCard('Events', fmtN(L.events.length), { icon: 'clock' })),

      // payments + notes
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('h2', { text: 'Payments' }),
          dealsTable(L.deals)),
        h('div', { class: 'card' }, h('h2', { text: 'Notes & tasks' }), notesBlock(L.notes, L.tasks, L.calls, l.id))),

      // timeline feed
      h('div', { class: 'card' },
        h('h2', { text: 'Timeline' }),
        h('div', { class: 'sub' }, 'Newest first · IST · with ad-thumbnail source cards'),
        h('div', { style: { marginTop: 14 } }, timeline(L))));
  }

  function contactChip(ic, val) {
    return h('span', { class: 'row', style: { gap: 6, color: 'var(--mut)', fontSize: 12.5 } }, icon(ic, 14), val);
  }
  function chip(txt) { return h('span', { class: 'tag', text: txt }); }

  function editLeadForm(L) {
    if (L.readOnly) return h('span', { class: 'tag' }, 'Read-only');
    const sel = h('select', { id: 'l-stage' }, L.stages.map((s) => h('option', { value: s, text: s, selected: s === L.lead.stage })));
    const own = h('input', { type: 'text', value: L.lead.owner || '', placeholder: 'rep name', id: 'l-owner' });
    const btn = h('button', { class: 'btn sm', onclick: saveLead }, 'Update');
    return h('div', { class: 'formrow' }, h('div', {}, h('label', { text: 'Stage' }), sel), h('div', {}, h('label', { text: 'Assign' }), own), btn);
  }
  async function saveLead() {
    const id = parseHash().b;
    const stage = document.getElementById('l-stage').value;
    const owner = document.getElementById('l-owner').value;
    await post('/lead/' + id, { stage, owner });
    toast('Lead updated', 'ok');
    navigate();
  }

  // v14: the ad attribution for leads that arrived WITHOUT xt.js (FlexiFunnels
  // pages) — the form's UTM hidden fields / page URL that the webhook captured.
  function sourceCardBlock(sc, L) {
    const isAd = sc.kind === 'ad';
    const title = isAd ? 'Ad source' : 'Ad source (from form UTM)';
    const sub = isAd ? 'Meta ad click via pixel / CAPI' : 'Captured on the FlexiFunnels form — pages without xt.js';
    const utmLine = [sc.utm_source, sc.utm_medium, sc.utm_campaign].filter(Boolean).join(' · ');
    const bigLine = isAd ? ((sc.ad && sc.ad.name) || 'Ad') : (sc.landing_url || 'Landing page');
    const detail = isAd
      ? ((sc.ad && sc.ad.status || '') + (sc.utm_campaign ? ' · campaign ' + sc.utm_campaign : ''))
      : utmLine;
    return h('div', { class: 'card' },
      h('div', { class: 'row', style: { justifyContent: 'space-between' } },
        h('div', {},
          h('h2', { text: title, style: { fontSize: 15 } }),
          h('div', { class: 'sub' }, sub)),
        h('span', { class: 'tag' }, isAd ? 'ad click' : 'UTM attribution')),
      h('div', { class: 'src', style: { marginTop: 10 } },
        isAd && sc.ad ? adThumb(sc.ad.name, sc.ad.name) : platIcon(isAd ? 'meta_leadgen' : 'flexifunnels'),
        h('div', { style: { marginLeft: 10 } },
          h('div', { style: { fontWeight: 700 } }, bigLine),
          detail ? h('div', { class: 'small muted' }, detail) : null)));
  }
  function adCardBlock(label, card, adCards) {
    if (!card) return h('div', { class: 'card' },
      h('h2', { text: label }),
      h('div', { class: 'sub' }, 'Not from an ad — this lead had no ad-click touchpoint.'));
    return h('div', { class: 'card' },
      h('h2', { text: label }),
      h('div', { class: 'src', style: { marginTop: 8 } },
        adThumb(card.name, card.name),
        h('div', {},
          h('div', { style: { fontWeight: 700 } }, card.name),
          h('div', { class: 'small muted' }, card.creative + ' · ' + card.status),
          card.campaign ? h('div', { class: 'small muted' }, 'Campaign: ' + card.campaign) : null)),
      adCards && adCards.clicks ? h('div', { class: 'row', style: { marginTop: 10 } },
        h('span', { class: 'pill b' }, adCards.clicks + ' ad click(s)')) : null);
  }

  function dealsTable(deals) {
    if (!deals || !deals.length) return h('div', { class: 'empty' }, 'No payments');
    const t = h('div', { class: 'tblwrap' });
    t.append(
      h('thead', {}, h('tr', {}, h('th', {}, 'Product'), h('th', {}, 'Amount'), h('th', {}, 'Gateway'), h('th', {}, 'Status'), h('th', {}, 'Paid'))),
      h('tbody', {}, deals.map((d) => h('tr', {},
        h('td', { text: d.product || '—' }),
        h('td', { class: 'num' }, fmtINR(d.amount)),
        h('td', { class: 'td-muted', text: d.gateway || '—' }),
        h('td', {}, statusPill(d.status)),
        h('td', { class: 'td-muted' }, fmtDT(d.paid_at))))));
    return t;
  }
  function statusPill(s) {
    const c = s === 'success' ? 'g' : s === 'refunded' ? 'r' : 'o';
    return h('span', { class: 'pill ' + c }, h('span', { class: 'dot' }), s || '—');
  }

  function notesBlock(notes, tasks, calls, leadId) {
    const wrap = h('div', {});
    const row = (n) => h('div', { class: 'small', style: { padding: '8px 0', borderBottom: '1px solid var(--line)' } },
      h('div', { class: 'row' }, h('span', { class: 'tag' }, n.user_name || 'Note'), h('span', { class: 'sp' }), h('span', { class: 'td-muted', text: relTime(n.ts) })),
      h('div', { class: 'td-muted', style: { marginTop: 3 } }, n.body || n.notes || ''));
    if (notes && notes.length) notes.forEach((n) => wrap.append(row(n)));
    if (tasks && tasks.length) tasks.forEach((n) => wrap.append(row({ ...n, ts: n.ts })));
    if (calls && calls.length) calls.forEach((n) => wrap.append(row({ user_name: 'Call · ' + n.outcome, body: n.notes, ts: n.ts })));
    if (!wrap.firstChild) wrap.append(h('div', { class: 'empty' }, 'No notes, tasks or calls yet.'));
    return wrap;
  }

  function timeline(L) {
    const wrap = h('div', { class: 'tl' });
    // combine events + deals as payment events + notes into a single time-sorted feed
    const items = [];
    (L.events || []).forEach((e) => items.push({ ts: e.ts, kind: 'event', e }));
    (L.deals || []).forEach((d) => { if (d.paid_at) items.push({ ts: d.paid_at, kind: 'deal', d }); });
    items.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    items.forEach((it) => {
      const tone = it.kind === 'deal' ? 'g' : eventTone(it.e.type);
      const e = it.kind === 'deal' ? { type: 'payment_success', source_platform: it.d.gateway, value: it.d.amount } : it.e;
      let extra = '';
      if (e.type === 'payment_success') extra = ' · ' + fmtINR(e.value) + (it.kind === 'deal' && it.d.status === 'refunded' ? ' (refunded)' : '');
      if (e.type === 'refund') extra = ' · refund' + (e.value != null ? ' ' + fmtINR(e.value) : '');
      if (e.type === 'stage_changed') { try { const dd = JSON.parse(e.raw_payload || '{}'); extra = ' · ' + (dd.from || '') + ' → ' + (dd.to || ''); } catch {} }
      const metaTag = e.sent_to_meta ? h('span', { class: 'pill g' }, '→ Meta' + (e.meta_match_quality ? ' · MQ ' + e.meta_match_quality : '')) : null;
      wrap.append(h('div', { class: 'ev ' + tone },
        h('div', { class: 'nd' }),
        h('div', { class: 'er' },
          h('span', { class: 'pill ' + (e.sent_to_meta ? 'g' : tone) }, e.type),
          e.source_platform ? platIcon(e.source_platform) : null,
          metaTag,
          h('span', { class: 'sp' }),
          h('span', { class: 'tm' }, fmtDT(e.ts))),
        extra ? h('div', { class: 'ex' }, extra) : null));
   });
    if (!items.length) wrap.append(h('div', { class: 'empty' }, 'No events yet for this lead.'));
    return wrap;
  }

  // ================================================================ PIPELINE (kanban DnD)
  let PIPE = null;
  async function renderPipeline(main) {
    const us = new URLSearchParams(parseHash().query || '');
    PIPE = await get('/pipeline' + (us.get('client') ? '?client=' + us.get('client') : ''));
    clear(main);
    const cur = String(PIPE.client || '');
    const clientSel = h('select', { style: { minWidth: 160 },
      onchange: (e) => { location.hash = '#/pipeline' + (e.target.value ? '?client=' + e.target.value : ''); } },
      [h('option', { value: '', text: 'All clients' })].concat(
        PIPE.clients.map((c) => h('option', { value: c.id, text: c.name, selected: String(c.id) === cur }))));
    const header = h('div', { class: 'card tight' },
      h('div', { class: 'row' },
        h('h2', { text: 'Pipeline' }),
        h('span', { class: 'sub' }, ME.readOnly ? 'Read-only — drag is disabled for your role' : 'Drag a card to a new stage'),
        h('span', { class: 'sp' }),
        clientSel));
    const board = h('div', {}, kanban());
    main.append(header, board);
  }
  function kanban() {
    const wrap = h('div', { class: 'kanban' });
    PIPE.columns.forEach((col) => {
      const color = STAGE_COLOR[col.stage] || '#98a2c0';
      const body = h('div', { class: 'kb' });
      col.cards.forEach((c) => body.append(kcard(c)));
      const colEl = h('div', { class: 'kcol' },
        h('div', { class: 'khead' },
          h('span', { class: 'dot', style: { width: 9, height: 9, borderRadius: '50%', background: color } }),
          h('span', { style: { fontWeight: 700, fontSize: 13, textTransform: 'uppercase', letterSpacing: '.04em', color } }, col.stage),
          h('span', { class: 'kc', text: String(col.count) })),
        body);
      colEl.addEventListener('dragover', (e) => { e.preventDefault(); colEl.classList.add('dragover'); });
      colEl.addEventListener('dragleave', () => colEl.classList.remove('dragover'));
      colEl.addEventListener('drop', (e) => {
        e.preventDefault(); colEl.classList.remove('dragover');
        const id = e.dataTransfer.getData('text/lead');
        if (id) onDrop(id, col.stage);
     });
      wrap.append(colEl);
   });
    return wrap;
  }
  function kcard(c) {
    const el = h('div', { class: 'kcard' },
      h('div', { class: 'kn' }, h('a', { href: '#/lead/' + c.id, text: c.name })),
      h('div', { class: 'km' },
        c.client ? h('span', { text: c.client }) : null,
        c.phone ? h('span', { class: 'ph', text: c.phone }) : null));
    if (!ME.readOnly) {
      el.setAttribute('draggable', 'true');
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/lead', String(c.id)); el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
    }
    return el;
  }
  async function onDrop(id, stage) {
    if (!id || ME.readOnly) return;
    if (!confirm('Move lead #' + id + ' to “' + stage + '”?')) return;
    const r = await post('/pipeline', { id: Number(id), stage });
    if (r && r.ok) {
      toast('Lead moved → ' + stage, 'ok');
      const m = root.querySelector('#main');
      await renderPipeline(m);
    } else toast('Could not move lead', 'err');
  }

  // ================================================================ REPORTS
  let REP = null;
  function reportsQS() {
    const u = new URLSearchParams(parseHash().query || '');
    const model = u.get('model'), win = u.get('window'), client = u.get('client');
    return [model && 'model=' + model, win && 'window=' + win, client && 'client=' + client].filter(Boolean).join('&');
  }
  async function renderReports(main, query) {
    const qs = query != null ? query : reportsQS();
    REP = await get('/reports' + (qs ? '?' + qs : ''));
    clear(main);
    renderReportsBody(main);
  }
  async function applyReportFilters() {
    const model = document.getElementById('rp-model').value;
    const win = document.getElementById('rp-window').value;
    const client = document.getElementById('rp-client').value;
    const qs = [model && 'model=' + model, win && 'window=' + win, client && 'client=' + client].filter(Boolean).join('&');
    location.hash = '#/reports' + (qs ? '?' + qs : ''); // hashchange -> navigate() re-renders
  }
  function renderReportsBody(main) {
    const fp = REP.funnel, ap = REP.adPerf, mvt = REP.metaVsTrack;
    // KPI strip
    main.append(
      banner(REP.modelNames[REP.settings.attribution_model] + ' · ' + REP.settings.attribution_window_days + 'd window · ' + REP.scopeLabel + '. Revenue net of refunds.', REP.settings),
      h('div', { class: 'card tight' },
        h('div', { class: 'formrow' },
          (REP.clients.length && !ME.readOnly ? h('div', { class: 'fld' }, h('label', { text: 'Client' }), h('select', { id: 'rp-client' },
            [h('option', { value: '', text: 'All clients' })].concat(REP.clients.map((c) => h('option', { value: c.id, text: c.name, selected: String(c.id) === String(REP.clientFilter) }))))) : null),
          h('div', { class: 'fld' }, h('label', { text: 'Model' }),
            h('select', { id: 'rp-model' }, REP.models.map((m) => h('option', { value: m, text: REP.modelNames[m], selected: m === REP.settings.attribution_model })))),
          h('div', { class: 'fld' }, h('label', { text: 'Window' }),
            h('select', { id: 'rp-window' }, [7, 14, 30, 60].map((w) => h('option', { value: String(w), text: w + 'd', selected: String(w) === String(REP.settings.attribution_window_days) })))),
          h('button', { class: 'btn', onclick: applyReportFilters }, 'Apply'),
          h('span', { class: 'sp' }),
          h('a', { class: 'btn sm sec', href: '/export/report?model=' + REP.settings.attribution_model + '&window=' + REP.settings.attribution_window_days + '&fmt=csv' }, 'Export ad perf CSV'),
          h('a', { class: 'btn sm sec', href: '/export/funnel?fmt=csv' }, 'Funnel CSV'))),

      h('div', { class: 'grid g4' },
        kpiCard('Leads', fmtN(fp.leads), { icon: 'leads' }),
        kpiCard('Revenue (net)', fmtINRk(fp.revenue), { icon: 'dollar' }),
        kpiCard('Ad spend', fmtINRk(fp.spend), { icon: 'bolt' }),
        kpiCard('ROAS', ap.total.roas != null ? ap.total.roas.toFixed(2) + '×' : '—', { icon: 'chart', hint: 'revenue ÷ spend' }),
        kpiCard('Show-up', fmtPct(fp.show_up_rate), { icon: 'clock' }),
        kpiCard('Close rate', fmtPct(fp.close_rate), { icon: 'gate' }),
        kpiCard('Cost / sale', fp.cost_per_sale != null ? fmtINR(fp.cost_per_sale) : '—', { icon: 'layers' }),
        kpiCard('Profit', fmtINRk(ap.total.profit), { icon: 'dollar', hint: 'revenue − spend' })),

      h('div', { class: 'grid g2' },
        // spend vs revenue per ad
        h('div', { class: 'card' },
          h('h2', { text: 'Spend vs revenue — per ad' }),
          h('div', { class: 'sub' }, 'Red = ad spend, green = attributed revenue'),
          h('div', { style: { marginTop: 12 } },
            hbars(ap.rows.map((r) => ({ label: r.name, sub: r.campaign, spend: r.spend, revenue: r.revenue, roas: r.roas })),
              { dual: true, fmt: fmtINRk, valueLabel: (it) => it.roas != null ? it.roas.toFixed(2) + '×' : '—',
                valueColor: (it) => (it.roas != null ? (it.roas >= 1 ? 'var(--ok)' : 'var(--bad)') : 'var(--mut)') })),
          h('div', { class: 'small muted', style: { marginTop: 8 } },
            'Total: spend ' + fmtINR(ap.total.spend) + ' · revenue ' + fmtINR(ap.total.revenue) + ' · ' + ap.total.leads + ' leads · ' + (ap.total.wasted_ads || 0) + ' wasted ads'))),

        // ROAS ranking
        h('div', { class: 'card' },
          h('h2', { text: 'ROAS ranking' }),
          h('div', { class: 'sub' }, 'Attributed revenue ÷ spend, worst first'),
          h('div', { style: { marginTop: 12 } },
            vbars(ap.rows.slice().sort((a, b) => (a.roas || 0) - (b.roas || 0)).map((r) => ({
              label: r.name, sub: r.campaign, value: r.roas, color: r.roas >= 1 ? '#34d399' : r.roas != null ? '#fbbf24' : '#fb7185' })),
              { fmt: (v) => v != null ? v.toFixed(2) + '×' : '—' })))),

      // wasted + source mix + meta vs track
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' },
          h('div', { class: 'row' }, h('h2', { text: 'Wasted spend' }), h('span', { class: 'sp' }), h('span', { class: 'tag' }, '≥ ' + fmtINR(Number(REP.settings.wasted_spend_threshold || 0)) + ', 0 sales')),
          wastedTable(REP.wasted)),
        h('div', { class: 'card' },
          h('h2', { text: 'Lead source mix' }),
          h('div', { style: { marginTop: 10 } }, mixDonut(REP.sourceMix)))),

      // ad performance table
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: 'Ad performance' }), h('span', { class: 'sp' }),
          h('a', { class: 'btn sm sec', href: '/export/report?fmt=excel' }, 'Excel')),
        adPerfTable(ap.rows)),

      // meta vs track
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: 'Meta vs Xacqora Track' }),
          h('span', { class: 'tag' }, 'Meta ' + mvt.meta_conv_total + ' · Ours ' + mvt.our_conv_total + ' · Δ ' + (mvt.delta >= 0 ? '+' : '') + mvt.delta)),
        mvtRows(mvt));
  }

  function wastedTable(waste) {
    if (!waste.length) return h('div', { class: 'empty' }, 'No wasted spend detected 🎉');
    const t = h('div', { class: 'tblwrap' });
    const thead = h('thead', {}, h('tr', {}, h('th', {}, 'Ad'), h('th', {}, 'Spend'), h('th', {}, 'Impr.'), h('th', {}, 'Leads'), h('th', {}, '')));
    const rows = waste.map((r) => h('tr', {},
      h('td', {}, adThumb(r.ad_id, r.name), h('span', { style: { marginLeft: 8, fontWeight: 600 } }, r.name)),
      h('td', { class: 'num' }, fmtINR(r.spend)),
      h('td', { class: 'num td-muted' }, fmtN(r.impressions)),
      h('td', { class: 'num' }, r.leads),
      h('td', {}, h('span', { class: 'pill r' }, '0 sales'))));
    t.append(thead, h('tbody', {}, rows));
    return t;
  }
  function adPerfTable(rows) {
    if (!rows.length) return h('div', { class: 'empty' }, 'No ads pulled yet — run a Meta pull in the Meta hub.');
    const t = h('div', { class: 'tblwrap' });
    const thead = h('thead', {}, h('tr', {}, h('th', {}, 'Ad'), h('th', {}, 'Status'),
      h('th', { class: 'num' }, 'Spend'), h('th', { class: 'num' }, 'Impr.'),
      h('th', { class: 'num' }, 'Clicks'), h('th', { class: 'num' }, 'Leads'),
      h('th', { class: 'num' }, 'Revenue'), h('th', { class: 'num' }, 'ROAS'), h('th', { class: 'num' }, 'Profit')));
    const trs = rows.map((r) => h('tr', {},
      h('td', {}, adThumb(r.ad_id, r.name), h('div', { style: { marginLeft: 8 } },
        h('div', { style: { fontWeight: 600 } }, r.name), h('div', { class: 'td-muted small' }, r.campaign + ' · ' + r.account))),
      h('td', {}, statusPill(r.status)),
      h('td', { class: 'num' }, fmtINR(r.spend)),
      h('td', { class: 'num td-muted' }, fmtN(r.impressions)),
      h('td', { class: 'num td-muted' }, fmtN(r.clicks)),
      h('td', { class: 'num' }, r.leads, r.lead_ids && r.lead_ids.length ? h('a', { class: 'small', href: '#/leads?ids=' + r.lead_ids.join(','), style: { marginLeft: 4 } }, 'see') : null),
      h('td', { class: 'num' }, fmtINR(r.revenue)),
      h('td', { class: 'num', style: { color: r.roas >= 1 ? 'var(--ok)' : 'var(--bad)', fontWeight: 700 } }, r.roas != null ? r.roas.toFixed(2) + '×' : '—'),
      h('td', { class: 'num', style: { color: r.profit >= 0 ? 'var(--ok)' : 'var(--bad)' } }, fmtINR(r.profit) + (r.wasted ? h('span', { class: 'pill r', style: { marginLeft: 6 } }, 'wasted') : null))));
    t.append(thead, h('tbody', {}, trs));
    return t;
  }
  function mvtRows(mvt) {
    if (!mvt.rows.length) return h('div', { class: 'empty' }, 'No Meta conversion data yet — run a Meta pull.');
    const t = h('div', { class: 'tblwrap' });
    t.append(h('thead', {}, h('tr', {}, h('th', {}, 'Ad'), h('th', { class: 'num' }, 'Meta conv'), h('th', { class: 'num' }, 'Our leads'), h('th', { class: 'num' }, 'Δ'))),
      h('tbody', {}, mvt.rows.map((r) => h('tr', {},
        h('td', {}, h('div', { style: { fontWeight: 600 } }, r.ad), h('div', { class: 'td-muted small' }, r.campaign)),
        h('td', { class: 'num' }, r.meta_conv),
        h('td', { class: 'num' }, r.our_conv),
        h('td', { class: 'num' }, deltaPill(r.delta)))))
    );
    t.append(h('div', { class: 'small muted', style: { padding: 10 } }, mvt.note));
    return t;
  }
  function deltaPill(d) {
    if (d > 0) return h('span', { class: 'pill o' }, '+' + d + ' · Meta over');
    if (d < 0) return h('span', { class: 'pill b' }, d + ' · Meta under');
    return h('span', { class: 'pill g' }, 'match');
  }

  // ================================================================ META HUB
  async function renderMeta(main) {
    const d = await get('/meta');
    clear(main);
    main.append(
      banner('Connected ad accounts. Spend is pulled every 3h + nightly. CAPI events are deduplicated by event_id and never sent twice; Purchase is suppressed for refunded payments.', null),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: 'Ad accounts' }), h('span', { class: 'sp' })),
        accountsTable(d.accounts)),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: 'Daily spend — recent' }), h('span', { class: 'sp' })),
        spendTable(d.spend)),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: 'CAPI push log' }), h('span', { class: 'sp' }), h('span', { class: 'tag' }, 'dry-run in mock mode')),
        capiTable(d.capi)));
  }
  function accountsTable(accs) {
    const t = h('div', { class: 'tblwrap' });
    t.append(h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', {}, 'ID'), h('th', {}, 'Status'), h('th', {}, 'Last pull'), h('th', {}, 'Error'), h('th', {}, ''))),
      h('tbody', {}, accs.map((a) => h('tr', {},
        h('td', {}, h('div', { style: { fontWeight: 600 } }, a.name), h('div', { class: 'td-muted small' }, a.client_name || '')),
        h('td', { class: 'td-muted mono small' }, a.ad_account_id),
        h('td', {}, a.status === 'connected' ? h('span', { class: 'pill g' }, 'connected') : h('span', { class: 'pill o' }, a.status)),
        h('td', { class: 'td-muted' }, a.last_pull_at ? relTime(a.last_pull_at) : 'never'),
        h('td', { class: 'td-muted small' }, a.last_error || 'ok'),
        h('td', {}, h('button', { class: 'btn sm sec', onclick: () => pullMeta(a.id) }, 'Pull now'))))));
    return t;
  }
  async function pullMeta(id) {
    toast('Enqueued Meta pull…');
    const r = await post('/meta/pull?acc=' + id, {});
    toast(r && r.ok ? 'Pull queued for ' + r.enqueued : 'Pull requested', 'ok');
  }
  function spendTable(rows) {
    if (!rows.length) return h('div', { class: 'empty' }, 'Run a pull to load spend.');
    const t = h('div', { class: 'tblwrap' });
    t.append(h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', {}, 'Ad'), h('th', { class: 'num' }, 'Spend'), h('th', { class: 'num' }, 'Impr.'), h('th', { class: 'num' }, 'Clicks'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'td-muted' }, r.date),
        h('td', {}, adThumb(r.ad_id, r.name), h('span', { style: { marginLeft: 8 } }, r.name || r.ad_id)),
        h('td', { class: 'num' }, fmtINR(r.spend)),
        h('td', { class: 'num td-muted' }, fmtN(r.impressions)),
        h('td', { class: 'num td-muted' }, fmtN(r.clicks))))));
    return t;
  }
  function capiTable(rows) {
    if (!rows.length) return h('div', { class: 'empty' }, 'No CAPI events pushed yet.');
    const t = h('div', { class: 'tblwrap' });
    t.append(h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Event'), h('th', {}, 'Lead'), h('th', {}, 'Pixel'), h('th', {}, 'Match'), h('th', {}, 'Mode'), h('th', {}, 'event_id'))),
      h('tbody', {}, rows.map((r) => h('tr', {},
        h('td', { class: 'td-muted small' }, fmtDT(r.sent_at)),
        h('td', {}, h('span', { class: 'pill c' }, r.event_name)),
        h('td', { class: 'td-muted' }, r.lead_name || '—'),
        h('td', { class: 'td-muted mono small' }, r.pixel_id),
        h('td', {}, r.match_quality != null ? h('span', { class: 'pill ' + (r.match_quality >= 7 ? 'g' : 'o') }, 'MQ ' + r.match_quality) : h('span', { class: 'td-muted' }, '—')),
        h('td', {}, r.dry_run ? h('span', { class: 'pill m' }, 'dry-run') : h('span', { class: 'pill g' }, 'sent')),
        h('td', { class: 'td-muted mono small' }, String(r.event_id || '').slice(0, 12) + '…')))));
    return t;
  }

  // ================================================================ INTEGRATIONS
  async function renderIntegrations(main, query) {
    const us = new URLSearchParams(query || '');
    const client = us.get('client') || '';
    const d = await get('/integrations' + (client ? '?client=' + client : ''));
    clear(main);
    main.append(
      banner('Each platform adapter lands events on the right lead within ~1 minute. Platforms without a direct webhook are routed through Pabbly first.', null),
      h('div', { class: 'card' },
        h('h2', { text: 'Platform adapters' }),
        h('div', { class: 'grid g4', style: { marginTop: 12 } },
          d.platforms.map((p) => h('div', { class: 'kpi tight' }, platIcon(p[0]), h('div', { style: { fontWeight: 700, marginTop: 8 } }, p[1]), h('div', { class: 'td-muted small', style: { marginTop: 2 } }, p[2]))))),
      h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('div', {}, h('h2', { text: 'Webhooks for client' }), h('div', { class: 'sub' }, 'Pick a client to see its configured endpoints')),
          h('span', { class: 'sp' }),
          h('div', { class: 'fld', style: { minWidth: 180 } },
            h('select', { onchange: (e) => { location.hash = '#/integrations?client=' + e.target.value; } },
              d.clients.map((c) => h('option', { value: c.id, text: c.name, selected: String(c.id) === String(d.cid) }))))),
        integrationsEndpoints(d)),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: 'Inbound webhook log' }), h('span', { class: 'sp' }), h('span', { class: 'tag' }, 'processed / failed / duplicate + retry')),
        webhookTable(d.log)));
  }
  function integrationsEndpoints(d) {
    const wrap = h('div', { style: { marginTop: 14 } });
    if (!d.endpoints.length) { wrap.append(h('div', { class: 'empty' }, 'No endpoints configured for this client.')); return wrap; }
    d.endpoints.forEach((e) => {
      wrap.append(h('div', { class: 'row', style: { padding: '12px 0', borderBottom: '1px solid var(--line)' } },
        platIcon(e.platform),
        h('div', {},
          h('div', { style: { fontWeight: 600 } }, e.platform),
          h('div', { class: 'td-muted mono small' }, 'POST ' + e.url + ' · secret ' + e.secret + ' · client ' + e.client_id)),
        h('span', { class: 'sp' }),
        h('button', { class: 'btn sm sec', onclick: () => testEvent(e) }, 'Send test event')));
   });
    return wrap;
  }
  async function testEvent(e) {
    toast('Sending test ' + e.platform + ' event…');
    const r = await post('/integrations/test', { platform: e.platform, client_id: Number(e.client_id) });
    toast(r && r.ok ? 'Test event queued — check the log in a moment' : 'Test sent', 'ok');
    setTimeout(navigate, 700);
  }
  function webhookTable(log) {
    if (!log.length) return h('div', { class: 'empty' }, 'No webhooks yet — use the test buttons above.');
    const t = h('div', { class: 'tblwrap' });
    t.append(
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Platform'), h('th', {}, 'Ref'), h('th', {}, 'Status'), h('th', {}, 'Error'), h('th', {}, ''))),
      h('tbody', {}, log.map((r) => h('tr', {},
        h('td', { class: 'td-muted small' }, fmtDT(r.ingested_at)),
        h('td', {}, platIcon(r.platform)),
        h('td', { class: 'td-muted mono small' }, r.ref || '—'),
        h('td', {}, webStatus(r.status)),
        h('td', { class: 'td-muted small' }, r.error || ''),
        h('td', {}, r.test ? h('span', { class: 'pill p' }, 'test') : null))))
    );
    return t;
  }
  function webStatus(s) {
    const c = s === 'processed' ? 'g' : s === 'failed' ? 'r' : 'o';
    return h('span', { class: 'pill ' + c }, h('span', { class: 'dot' }), s);
  }

  // ================================================================ WEBHOOKS & API KEYS
  // v14: team-only. Section A = inbound token-URL endpoints (generate / copy /
  // pause / revoke, FlexiFunnels setup guide + field mapping). Section B = the
  // app's bearer API keys (xak_... read-only / read-write, revoke).
  async function renderWebhooksKeys(main, query) {
    const d = await get('/webhooks');
    clear(main);
    main.append(
      banner('Generate a webhook URL per client + platform and paste it into the platform (FlexiFunnels: Forms → Webhook and Products/Purchases → Webhook). The URL token is the endpoint\'s auth; every event is logged. API keys (xak_…) give scripts read access to the app.', null),
      baseNotice(d),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('div', {}, h('h2', { text: 'Webhook endpoints' }), h('div', { class: 'sub' }, 'token-in-URL · status · last event · total events')),
          h('span', { class: 'sp' }),
          createEndpointForm(d)),
      d.endpoints.length ? endpointsTable(d) : h('div', { class: 'empty', style: { marginTop: 10 } }, 'No endpoints yet — create one. For FlexiFunnels: one form webhook (events “leads”) + one product webhook (events “purchases”).')),
      d.endpoints.length ? flexiGuide(d) : null,
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: 'FlexiFunnels field mapping' }), h('span', { class: 'sp' }),
          h('span', { class: 'tag' }, 'per client · optional override')),
        flexiFieldMapForm(d)),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('div', {}, h('h2', { text: 'API keys' }), h('div', { class: 'sub' }, 'Bearer auth for /api/app/* — plaintext shown once, then only the hash is kept')),
          h('span', { class: 'sp' }),
          createKeyForm(d)),
      d.apikeys.length ? apiKeysTable(d) : h('div', { class: 'empty', style: { marginTop: 10 } }, 'No API keys yet.')),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: 'Recent inbound events' }), h('span', { class: 'sp' }),
          h('a', { class: 'btn sm sec', href: '#/integrations' }, 'Full log in Integrations')),
        webhookTable(d.log || [])));
  }

  function baseNotice(d) {
    if (d.baseIsProd) return null;
    return h('div', { class: 'banner', style: { borderColor: 'var(--warn, #fbbf24)', background: 'rgba(251,191,36,.08)' } },
      icon('bell', 18),
      h('span', {}, 'Dev notice — generated URLs use this host (', h('span', { class: 'mono' }, d.base), '). FlexiFunnels can only POST to a PUBLIC URL: either deploy (docs/deploy.md, Arpit) or run a tunnel in dev: ',
        h('code', { style: { background: '#0b0d13', border: '1px solid var(--line)', borderRadius: 6, padding: '1px 6px' }, text: 'ngrok http ' + String(d.base || 'http://localhost:4100').replace(/^https?:\/\//, '') }),
        h('span', {}, ' — then copy that public ngrok URL as the base.')));
  }

  function epActionCell(e, clients) {
    const b = h('div', { class: 'row', style: { gap: 6, justifyContent: 'flex-end' } });
    b.append(copyBtn(e.url, e.url));
    if (e.status === 'active') b.append(h('button', { class: 'btn sm sec', onclick: () => epStatus(e.id, 'paused') }, 'Pause'));
    else if (e.status === 'paused') b.append(h('button', { class: 'btn sm', onclick: () => epStatus(e.id, 'active') }, 'Resume'));
    else b.append(h('button', { class: 'btn sm danger', onclick: () => epStatus(e.id, 'revoked') }, 'Revoke'));
    if (e.status !== 'revoked') b.append(h('button', { class: 'btn sm sec', onclick: () => epTest(e) }, 'Test'));
    if (e.status !== 'revoked') b.append(h('button', { class: 'btn sm sec', title: 'New token; old URL stops working', onclick: () => epRotate(e) }, 'Rotate'));
    return b;
  }
  function epTest(e) {
    return e.platform === 'flexifunnels' ? epFlexiTest(e) : epGenericTest(e);
  }
  async function epGenericTest(e) {
    toast('Queueing test ' + e.platform + ' event…');
    const r = await post('/integrations/test', { platform: e.platform, client_id: e.client_id });
    toast(r && r.ok ? 'Test queued — watch the recent events below' : 'Could not queue test', 'ok');
    setTimeout(navigate, 800);
  }
  async function epFlexiTest(e) {
    toast('Queueing sample FlexiFunnels form event…');
    const r = await post('/webhooks/flexi_test', { client_id: e.client_id });
    toast(r && r.ok ? 'Test queued — watch the recent events below' : 'Could not queue test', 'ok');
    setTimeout(navigate, 800);
  }
  function endpointsTable(d) {
    const t = h('div', { class: 'tblwrap', style: { marginTop: 12 } });
    const head = h('thead', {}, h('tr', {},
      h('th', {}, 'Platform'), h('th', {}, 'Description'), h('th', {}, 'Client'), h('th', {}, 'URL'),
      h('th', {}, 'Events'), h('th', {}, 'Status'), h('th', {}, 'Last event'), h('th', { class: 'num' }, 'Total'), h('th', {}, '')));
    const body = h('tbody', {}, d.endpoints.map((e) => {
      const tr = h('tr', {});
      const cName = d.clients.find((c) => String(c.id) === String(e.client_id));
      tr.append(
        h('td', {}, platIcon(e.platform), h('span', { style: { marginLeft: 6, fontWeight: 600 } }, e.platform)),
        h('td', { class: 'td-muted small' }, e.description || '—'),
        h('td', { class: 'td-muted' }, cName ? cName.name : 'client ' + e.client_id),
        h('td', { class: 'td-muted mono small' }, e.url_masked || e.url || ''),
        h('td', {}, h('span', { class: 'pill m' }, e.events || 'all')),
        h('td', {}, epStatusPill(e.status)),
        h('td', { class: 'td-muted small' }, e.last_event_at ? relTime(e.last_event_at) : 'never'),
        h('td', { class: 'num td-muted' }, String(e.events_total || 0)),
        h('td', {}, epActionCell(e, d.clients)));
      return tr;
    }));
    t.append(head, body);
    return t;
  }
  function epStatusPill(s) {
    const c = s === 'active' ? 'g' : s === 'paused' ? 'o' : 'r';
    return h('span', { class: 'pill ' + c }, h('span', { class: 'dot' }), s);
  }
  async function epStatus(id, status) {
    const msg = status === 'revoked' ? 'Revoke? The URL stops accepting events (history stays).' : 'Set status ' + status + '?';
    if (!confirm(msg)) return;
    const r = await post('/webhooks/status', { id, status });
    toast(r && r.ok ? 'Endpoint ' + status : 'Could not change status', r && r.ok ? 'ok' : 'err');
    navigate();
  }
  async function epRotate(ep) {
    if (!confirm('Rotate token for ' + ep.platform + '? A new URL is generated — the old one is revoked.')) return;
    // delete the old endpoint + create a fresh one with the same client/platform/desc
    await post('/webhooks/delete', { id: ep.id });
    const r = await post('/webhooks/endpoint', { client_id: ep.client_id, platform: ep.platform, description: ep.description, events: ep.events });
    showOneTimeUrl(r && r.created, ep.platform);
    navigate();
  }
  function copyBtn(label, value) {
    const b = h('button', { class: 'btn sm sec', onclick: async () => {
      try { await navigator.clipboard.writeText(value || label); toast('Copied', 'ok'); }
      catch { toast('Copy failed — select the URL manually', 'err'); }
    } }, 'Copy');
    return b;
  }
  function showOneTimeUrl(created, platform) {
    if (!created) return;
    modal(h('div', {},
      h('h2', { text: (platform || 'Webhook') + ' endpoint created' }),
      h('div', { class: 'note', style: { marginTop: 10 } }, 'Copy this URL now — it contains the endpoint token (your only secret). In live mode the URL must be public (prod domain or tunnel).'),
      h('div', { class: 'mono', style: { background: '#0b0d13', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginTop: 10, wordBreak: 'break-all' }, text: created.url }),
      h('div', { class: 'row', style: { marginTop: 12, gap: 8 } },
        h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(created.url); toast('URL copied', 'ok'); } catch {} } }, 'Copy URL'),
        created.secret ? h('button', { class: 'btn sm sec', onclick: async () => { try { await navigator.clipboard.writeText(created.secret); toast('Secret copied', 'ok'); } catch {} } }, 'Copy legacy secret') : null)),
      () => {});
  }

  function createEndpointForm(d) {
    const clSel = h('select', { id: 'wk-cl' }, d.clients.map((c) => h('option', { value: c.id, text: c.name })));
    const plSel = h('select', { id: 'wk-pl' }, d.platforms.map((p) => h('option', { value: p[0], text: p[1] + ' — ' + p[2] })));
    const evSel = h('select', { id: 'wk-ev' }, [h('option', { value: 'all', text: 'all events' }), h('option', { value: 'leads', text: 'leads (forms)' }), h('option', { value: 'purchases', text: 'purchases' })]);
    const dIn = h('input', { type: 'text', placeholder: 'e.g. Webinar form (FlexiFunnels)', id: 'wk-desc' });
    const out = h('div', { style: { marginTop: 10 } });
    const mk = async () => {
      const r = await post('/webhooks/endpoint', {
        client_id: Number(clSel.value), platform: plSel.value, events: evSel.value, description: dIn.value,
      });
      clear(out);
      if (r && r.created) { showOneTimeUrl(r.created, r.created.platform); out.append(h('div', { class: 'note' }, 'Endpoint generated (copy the URL from the box).')); }
      else { toast('Could not create endpoint', 'err'); navigate(); }
    };
    return h('div', { style: { minWidth: 260 } },
      h('div', { class: 'formrow' },
        h('div', { class: 'fld' }, h('label', { text: 'Client' }), clSel),
        h('div', { class: 'fld' }, h('label', { text: 'Platform' }), plSel),
        h('div', { class: 'fld' }, h('label', { text: 'Events' }), evSel),
        h('div', { class: 'fld grow' }, h('label', { text: 'Description' }), dIn),
        h('button', { class: 'btn', onclick: mk }, 'Generate URL')),
      out);
  }

  function createKeyForm(d) {
    const clSel = h('select', { id: 'ak-cl' },
      [h('option', { value: '', text: 'workspace (all clients)' })].concat(d.clients.map((c) => h('option', { value: c.id, text: c.name }))));
    const pmSel = h('select', { id: 'ak-pm' }, [h('option', { value: 'read_only', text: 'read-only' }), h('option', { value: 'read_write', text: 'read-write' })]);
    const lIn = h('input', { type: 'text', placeholder: 'label (e.g. billing scraper)', id: 'ak-lb' });
    const out = h('div', { style: { marginTop: 10 } });
    const mk = async () => {
      const r = await post('/webhooks/key', { scope_client_id: clSel.value || null, permission: pmSel.value, label: lIn.value });
      clear(out);
      if (r && r.created) {
        const k = r.created;
        const hint = h('span', { class: 'td-muted small' }, 'use it as ', h('code', {}, 'Authorization: Bearer ' + k.key.slice(0, 10) + '…'));
        out.append(h('div', {},
          h('div', { class: 'note' }, h('b', { text: 'Copy the key now — it is shown only once (stored as a hash):' })),
          h('div', { class: 'mono', style: { background: '#0b0d13', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginTop: 8, wordBreak: 'break-all' }, text: k.key }),
          h('div', { class: 'row', style: { marginTop: 8, gap: 10 } },
            h('button', { class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(k.key); toast('Key copied', 'ok'); } catch {} } }, 'Copy key'),
            hint)));
      } else toast('Could not create key', 'err');
    };
    return h('div', { style: { minWidth: 260 } },
      h('div', { class: 'formrow' },
        h('div', { class: 'fld' }, h('label', { text: 'Scope' }), clSel),
        h('div', { class: 'fld' }, h('label', { text: 'Permission' }), pmSel),
        h('div', { class: 'fld grow' }, h('label', { text: 'Label' }), lIn),
        h('button', { class: 'btn', onclick: mk }, 'Create key')),
      out);
  }

  function apiKeysTable(d) {
    const t = h('div', { class: 'tblwrap', style: { marginTop: 12 } });
    t.append(
      h('thead', {}, h('tr', {}, h('th', {}, 'Label'), h('th', {}, 'Scope'), h('th', {}, 'Permission'), h('th', {}, 'Created'), h('th', {}, 'Last used'), h('th', {}, 'Status'), h('th', {}, ''))),
      h('tbody', {}, d.apikeys.map((k) => h('tr', {},
        h('td', { style: { fontWeight: 600 } }, k.label || '—'),
        h('td', { class: 'td-muted' }, k.scope_name || 'workspace'),
        h('td', {}, h('span', { class: 'pill ' + (k.permission === 'read_write' ? 'o' : 'm') }, k.permission)),
        h('td', { class: 'td-muted small' }, fmtDT(k.created_at)),
        h('td', { class: 'td-muted small' }, k.last_used_at ? relTime(k.last_used_at) : 'never'),
        h('td', {}, k.status === 'revoked' ? h('span', { class: 'pill r' }, 'revoked') : h('span', { class: 'pill g' }, 'active')),
        h('td', {},
          h('div', { class: 'row', style: { gap: 6, justifyContent: 'flex-end' } },
            k.status !== 'revoked' ? h('button', { class: 'btn sm danger', onclick: async () => { if (!confirm('Revoke this key?')) return; const r = await post('/webhooks/key_revoke', { id: k.id }); toast(r && r.ok ? 'Key revoked' : 'Could not revoke', 'ok'); navigate(); } }, 'Revoke') :
            h('button', { class: 'btn sm sec', onclick: async () => { if (!confirm('Delete this key row?')) return; await post('/webhooks/key_delete', { id: k.id }); navigate(); } }, 'Delete')))))));
    return t;
  }

  // per-client FlexiFunnels field-mapping editor (PRD §5.2 style): map the
  // payload field names FlexiFunnels sends to phone / email / name / city +
  // an optional event_type override (form_submit vs registered).
  function flexiFieldMapForm(d) {
    const clSel = h('select', { id: 'fm-cl' }, d.clients.map((c) => h('option', { value: c.id, text: c.name })));
    const F = ['phone', 'email', 'name', 'city', 'form_title', 'page_url', 'event_type'];
    const inputs = F.map((f) => h('input', { type: 'text', placeholder: f, id: 'fm-' + f, class: f === 'event_type' ? 'td-muted' : '', style: f === 'event_type' ? { fontSize: 12 } : {} }));
    const note = h('div', { class: 'td-muted small', style: { marginTop: 6 } },
      'Default keys already cover FlexiFunnels form fields (phone, email, name, city, form_title, page_url). Override here only if your forms use custom names, or set event_type=registered to move form leads to the Registered stage.');
    const sv = async () => {
      const m = {};
      F.forEach((f) => { const v = document.getElementById('fm-' + f).value.trim(); if (v) m[f] = v; });
      const r = await post('/webhooks/fieldmap', { client_id: Number(clSel.value), platform: 'flexifunnels', mapping: m });
      toast(r && r.ok ? 'Field mapping saved' : 'Could not save', 'ok');
    };
    const load = async () => {
      // re-GET to pull the current mapping for the chosen client (best-effort)
      const cur = d.fieldMaps && d.fieldMaps[clSel.value];
      if (cur) F.forEach((f) => { const el = document.getElementById('fm-' + f); if (el) el.value = cur[f] || ''; });
    };
    return h('div', { style: { marginTop: 12 } },
      h('div', { class: 'formrow' },
        h('div', { class: 'fld' }, h('label', { text: 'Client' }), clSel),
        h('div', { class: 'formrow', style: { flex: 1, gap: 6 } },
          inputs.map((i) => h('div', { class: 'fld grow' }, i))),
        h('button', { class: 'btn', onclick: sv }, 'Save mapping'),
        h('button', { class: 'btn sm sec', onclick: load }, 'Reload')));
  }

  // copy-paste ready FlexiFunnels setup (the two paste points FlexiFunnels
  // support confirmed: Forms → Webhook + Products/Purchases → Webhook).
  function flexiGuide(d) {
    const formEp = d.endpoints.find((e) => e.platform === 'flexifunnels' && (e.events || 'all') !== 'purchases');
    const purchEp = d.endpoints.find((e) => e.platform === 'flexifunnels' && e.events === 'purchases');
    const step = (n, title, body) => h('div', { class: 'row', style: { padding: '10px 0', borderBottom: '1px solid var(--line)', gap: 10, alignItems: 'flex-start' } },
      h('span', { class: 'pill b', style: { minWidth: 22, textAlign: 'center' } }, String(n)),
      h('div', { style: { flex: 1 } },
        h('div', { style: { fontWeight: 600 } }, title),
        h('div', { class: 'td-muted small', style: { marginTop: 2 } }, body)));
    const flexis = d.endpoints.filter((e) => e.platform === 'flexifunnels');
    const body = h('div', { style: { marginTop: 12 } });
    if (!flexis.length) {
      body.append(h('div', { class: 'empty' }, 'Create a FlexiFunnels endpoint above (client + platform FlexiFunnels + events “leads” for the form, and one with “purchases” for orders), then follow these steps in FlexiFunnels:'));
    }
    body.append(
      step(1, 'Form webhook', 'FlexiFunnels → Forms → Page Editor → select form → Form Settings → Webhooks → paste your “leads” URL ' + (formEp ? '(generated: ' + (formEp.url_masked || '') + ')' : '') + ' → Save & Publish.'),
      step(2, 'Product/purchase webhook', 'FlexiFunnels → Products → select product → Set Product Rules → Webhook → paste your “purchases” URL ' + (purchEp ? '(generated: ' + (purchEp.url_masked || '') + ')' : '') + ' → Save.'),
      step(3, 'Ad attribution (recommended)', 'FlexiFunnels pages don\'t run xt.js, so ad clicks aren\'t tracked there. Add utm_source / utm_medium / utm_campaign / utm_content / utm_term as HIDDEN fields on each form (or set them in the page URL) — they flow into the webhook payload and the lead gets an ad source card + attribution.'),
      step(4, 'Public URL requirement', 'The URL must be reachable by FlexiFunnels — a localhost URL only works behind a tunnel (ngrok / cloudflared) or on your production domain (docs/deploy.md). Dev: ', h('code', {}, 'cloudflared tunnel --url http://localhost:4100') + ' and swap the URL\'s host for the tunnel address.'));
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { text: 'FlexiFunnels setup guide' }), h('span', { class: 'sp' }), h('span', { class: 'tag' }, 'copy-paste ready')),
      body);
  }

  // ================================================================ DUPLICATES
  async function renderDuplicates(main, query) {
    const us = new URLSearchParams(query || '');
    const client = us.get('client') || '';
    const d = await get('/duplicates' + (client ? '?client=' + client : ''));
    clear(main);
    main.append(
      banner('Same email, different phone → merge by a human. Same phone across different clients is never merged.', null),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: 'Likely duplicates' }),
          h('div', { class: 'fld', style: { minWidth: 160, marginLeft: 'auto' } },
            h('select', { onchange: (e) => { location.hash = '#/duplicates?client=' + e.target.value; renderDuplicates(root.querySelector('#main'), 'client=' + e.target.value).catch(showErr); } },
              d.clients.map((c) => h('option', { value: c.id, text: c.name, selected: String(c.id) === String(d.cid) }))))),
        dupsTable(d.pairs)));
  }
  function dupsTable(pairs) {
    if (!pairs.length) return h('div', { class: 'empty' }, 'No likely duplicates found 🎉');
    const t = h('div', { class: 'tblwrap' });
    t.append(h('thead', {}, h('tr', {}, h('th', {}, 'Keep'), h('th', {}, 'Merge into'), h('th', {}, 'Email'), h('th', {}, 'Action'))),
      h('tbody', {}, pairs.map((p) => h('tr', {},
        leadCell(p.a), leadCell(p.b),
        h('td', { class: 'td-muted' }, p.email),
        h('td', {}, h('button', { class: 'btn sm sec', onclick: () => mergeDup(p) }, 'Merge'))))));
    return t;
  }
  function leadCell(x) {
    return h('td', {}, h('a', { class: 'leadlink', href: '#/lead/' + x.id, text: x.name || '—' }),
      h('span', { class: 'td-muted small', style: { marginLeft: 8 } }, x.phone || '(no phone)'));
  }
  async function mergeDup(p) {
    if (!confirm('Merge lead #' + p.b.id + ' into #' + p.a.id + '?')) return;
    const r = await post('/duplicates/merge', { keep: p.a.id, drop: p.b.id, phone: p.a.phone });
    toast(r && r.ok ? 'Merged ' + p.b.id + ' → ' + p.a.id : 'Merged', 'ok');
    navigate();
  }

  // ================================================================ ADMIN
  async function renderAdmin(main) {
    const d = await get('/admin');
    clear(main);
    main.append(
      banner('Users, global settings and the audit trail. Roles: Owner · Admin · Media Buyer · Sales Rep · Viewer · Client.', null),
      h('div', { class: 'grid g2' },
        h('div', { class: 'card' }, h('h2', { text: 'Users & roles' }), usersTable(d.users)),
        settingsCard(d.settings, d.me)),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: 'Audit log' }), h('span', { class: 'sp' }), h('span', { class: 'tag' }, 'who viewed / exported / changed what')),
        auditTable(d.audit)));
  }
  function usersTable(users) {
    const t = h('div', { class: 'tblwrap' });
    const thead = h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Email'), h('th', {}, 'Role'), h('th', {}, 'Clients'), h('th', {}, '2FA')));
    const rows = users.map((u) => h('tr', {},
      h('td', { style: { fontWeight: 600 } }, u.name),
      h('td', { class: 'td-muted' }, u.email),
      h('td', {}, h('span', { class: 'pill b' }, u.role)),
      h('td', { class: 'td-muted' }, u.client_ids || 'all'),
      h('td', {}, u.totp_enabled ? h('span', { class: 'pill g' }, '2FA on') : h('span', { class: 'pill m' }, '2FA off'))));
    t.append(thead, h('tbody', {}, rows));
    return t;
  }
  function settingsCard(s, me) {
    const opt = (arr, sel, v, l) => h('option', { value: v, text: l, selected: v === sel });
    const mSel = h('select', { id: 'ad-model' }, ['last_paid_click', 'first_click', 'linear', 'lead_source'].map((m) => opt(null, s.model, m, m)));
    const wIn = h('input', { type: 'text', value: s.window, id: 'ad-window' });
    const thIn = h('input', { type: 'text', value: s.threshold, id: 'ad-thresh' });
    const cSel = h('select', { id: 'ad-capi' }, opt(null, s.capi, 'dry', 'dry-run'), opt(null, s.capi, 'live', 'live'));
    const card = h('div', { class: 'card' },
      h('h2', { text: 'Settings' }),
      h('div', { class: 'formrow' },
        h('div', {}, h('label', { text: 'Attribution model' }), mSel),
        h('div', {}, h('label', { text: 'Window (days)' }), wIn),
        h('div', {}, h('label', { text: 'Wasted ≥ spend' }), thIn),
        h('div', {}, h('label', { text: 'CAPI mode' }), cSel),
        h('button', { class: 'btn', onclick: saveSettings }, 'Save')),
      h('div', { class: 'note', style: { marginTop: 14 } },
        'Security: RLS by client_id at the DB level · encrypted Meta/gateway/webhook secrets · every inbound webhook signature-verified · 2FA on team logins · phone/email masked for roles without need · daily backups · rate-limited public ingest.'),
      h('div', { class: 'row', style: { marginTop: 14 } },
        h('label', { text: 'Two-factor login for your account', style: { margin: 0 } }),
        h('button', { class: 'btn sm sec', onclick: toggle2fa }, me.totp_enabled ? 'Disable 2FA' : 'Enroll in 2FA')),
      h('div', { class: 'row', style: { marginTop: 10 } },
        h('input', { type: 'text', placeholder: 'lead id', style: { width: 110 }, id: 'ad-prune' }),
        h('button', { class: 'btn sm danger', onclick: pruneLead }, 'Delete lead + stop CAPI')));
    return card;
  }
  async function saveSettings() {
    const r = await post('/admin/settings', {
      model: document.getElementById('ad-model').value,
      window: document.getElementById('ad-window').value,
      threshold: document.getElementById('ad-thresh').value,
      capi: document.getElementById('ad-capi').value,
   });
    toast('Settings saved', 'ok'); navigate();
  }
  async function toggle2fa() {
    const me = await get('/admin');
    const action = me.me.totp_enabled ? 'disable' : 'enroll';
    const r = await post('/admin/2fa', { action });
    if (action === 'enroll' && r && r.secret) {
      modal(h('div', {},
        h('h2', { text: 'Set up your authenticator' }),
        h('div', { class: 'note', style: { marginTop: 10 } }, 'Scan in Google Authenticator / 1Password, or enter the secret manually:'),
        h('div', { class: 'mono', style: { background: '#0b0d13', border: '1px solid var(--line)', borderRadius: 8, padding: 12, marginTop: 10, wordBreak: 'break-all' }, text: r.secret }),
        h('div', { class: 'td-muted small', style: { marginTop: 8 } }, 'Sign-in will now require the 6-digit code.')),
        () => {});
    } else toast('2FA ' + (action === 'enroll' ? 'enabled' : 'disabled'), 'ok');
    navigate();
  }
  async function pruneLead() {
    const id = document.getElementById('ad-prune').value;
    if (!id) return toast('Enter a lead id', 'err');
    if (!confirm('Delete lead #' + id + ' and stop all future CAPI events? (privacy deletion, logged)')) return;
    await post('/admin/prune', { lead_id: Number(id) });
    toast('Lead ' + id + ' deleted', 'ok'); navigate();
  }
  function auditTable(audit) {
    if (!audit.length) return h('div', { class: 'empty' }, 'No audit entries yet.');
    const t = h('div', { class: 'tblwrap' });
    const thead = h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'User'), h('th', {}, 'Action'), h('th', {}, 'Entity'), h('th', {}, 'Detail')));
    const rows = audit.map((a) => h('tr', {},
      h('td', { class: 'td-muted small' }, fmtDT(a.ts)),
      h('td', {}, a.user_email || 'system'),
      h('td', {}, h('span', { class: 'pill m' }, a.action)),
      h('td', { class: 'td-muted small' }, (a.entity || '') + (a.entity_id ? ' #' + a.entity_id : '')),
      h('td', { class: 'td-muted small' }, a.detail || '')));
    t.append(thead, h('tbody', {}, rows));
    return t;
  }

  // ================================================================ PORTAL (client home)
  async function renderPortal(main) {
    const d = await get('/portal');
    clear(main);
    main.append(
      h('div', { class: 'row' }, h('h1', { style: { fontSize: 22, margin: 0 } }, 'Client portal'),
        ME.clientRole ? h('span', { class: 'tag' }, 'read-only') : null),
      ME.clientRole ? h('div', { class: 'banner' }, icon('shield', 18), 'You are in a read-only client view. Only your own leads, funnels and reports are visible; exports are logged to the audit trail.') : null,
      weeklyCard(d),
      h('div', { class: 'card' },
        h('h2', { text: 'My leads' }),
        recentTable(d.leads)));
  }
  function weeklyCard(d) {
    if (!d.weekly) return h('div', { class: 'card' }, h('h2', { text: 'Weekly client summary' }), h('div', { class: 'empty' }, 'No client selected yet.'));
    const ws = d.weekly, fp = ws.funnel, t = ws.total;
    const pdfBtn = d.hasPdf ? h('a', { class: 'btn sm', href: '/weekly.pdf' + (ME.clientRole ? '' : '?client=' + d.cid) }, 'Download PDF') : h('span', { class: 'td-muted small' }, 'PDF generated Monday 9 AM IST');
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('div', {}, h('h2', { text: 'Weekly client summary' }), h('div', { class: 'sub' }, 'Auto · every Monday 9 AM IST')),
        h('span', { class: 'sp' }), pdfBtn),
      h('div', { class: 'grid g4', style: { marginTop: 12 } },
        kpiCard('Leads', fmtN(fp.leads), { icon: 'leads' }),
        kpiCard('Attended', fmtN(fp.attended), { icon: 'clock' }),
        kpiCard('Paid (net)', fmtN(fp.paid), { icon: 'gate' }),
        kpiCard('Revenue (net)', fmtINRk(fp.revenue), { icon: 'dollar' }),
        kpiCard('Ad spend', fmtINRk(t.spend), { icon: 'bolt' }),
        kpiCard('ROAS', t.roas != null ? t.roas.toFixed(2) + '×' : '—', { icon: 'chart' }),
        kpiCard('Profit', fmtINRk(t.profit), { icon: 'dollar' }),
        kpiCard('Model', ws.settings.model || '—', { icon: 'layers' })),
      h('div', { class: 'small muted', style: { marginTop: 8 } }, 'Top ads: ' + (ws.ad_top || []).map((r) => r.name).join(', ') || '—'));
  }

  // ================================================================ PILOT GATES
  async function renderPilot(main) {
    const d = await get('/pilot');
    clear(main);
    main.append(
      banner('Pilot self-verification on fake/seed data. The gate suite is a live read-only state check; the accuracy checkers compare what you paste from the gateways / Meta Ads Manager each week.', null),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: 'Gate assertion suite' }), h('span', { class: 'sp' }),
          h('span', { class: 'pill ' + (d.allPass ? 'g' : 'r') }, d.allPass ? 'ALL PASS' : 'FAILING')),
        gatesTable(d.gates.gates || [])),
      h('div', { class: 'grid g2' },
        // URL checker
        h('div', { class: 'card' },
          h('h2', { text: 'Ad URL checker' }),
          h('div', { class: 'sub' }, 'Paste a destination URL; we flag missing ad/adset/campaign tokens + fbclid'),
          urlChecker()),
        // accuracy checkers
        h('div', { class: 'card' },
          h('h2', { text: 'Accuracy checkers (pilot month)' }),
          h('div', { class: 'sub' }, 'Paste gateway settlement + Meta spend; we compare to our counts'),
          accuracyForm(d))));
  }
  function gatesTable(gates) {
    const t = h('div', { class: 'tblwrap', style: { marginTop: 12 } });
    const thead = h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Gate'), h('th', {}, 'Detail')));
    const rows = gates.map((g) => h('tr', {},
      h('td', {}, h('span', { class: 'pill ' + (g.pass ? 'g' : 'r') }, g.pass ? 'PASS' : 'FAIL')),
      h('td', {}, h('b', { text: g.id + ' ' }), g.name),
      h('td', { class: 'td-muted small' }, g.detail)));
    t.append(thead, h('tbody', {}, rows));
    return t;
  }
  function urlChecker() {
    const inp = h('input', { type: 'text', placeholder: 'https://landing.com?utm_source=facebook{{ad.id}}={{ad.id}}…', style: { marginTop: 10 } });
    const out = h('div', { style: { marginTop: 10 } });
    const run = async () => {
      const r = await get('/pilot?url=' + encodeURIComponent(inp.value));
      clear(out);
      if (!r.urlCheck) return;
      const c = r.urlCheck;
      out.append(h('div', { class: 'small muted' }, c.host || c.url));
      const tbody = h('tbody', {}, c.findings.map((f) => h('tr', {},
        h('td', {}, f.item),
        h('td', {}, h('span', { class: 'pill ' + (f.present ? 'g' : f.severity === 'info' ? 'm' : 'r') }, f.present ? 'yes' : 'missing')),
        h('td', { class: 'td-muted small' }, f.note))));
      out.append(h('div', { class: 'tblwrap', style: { marginTop: 8 } }, tbody));
      if (c.utm_missing && c.utm_missing.length) out.append(h('div', { class: 'td-muted small', style: { marginTop: 6 } }, 'Missing UTM: ' + c.utm_missing.join(', ')));
    };
    return h('div', { class: 'row', style: { marginTop: 8, alignItems: 'flex-start' } }, inp, h('button', { class: 'btn sm', onclick: run }, 'Check'));
  }
  function accuracyForm(d) {
    const rev = h('input', { type: 'number', placeholder: 'our week revenue (₹)', style: { marginTop: 8 } });
    const sp = h('input', { type: 'number', placeholder: 'Meta spend export (₹)', style: { marginTop: 8 } });
    const out = h('div', { style: { marginTop: 10 } });
    if (d.lastAccuracy) out.append(h('div', { class: 'small muted' }, 'Last check: ' + d.lastAccuracy));
    const run = async () => {
      const r = await post('/pilot/accuracy', { rev_ext: rev.value, spend_ext: sp.value });
      clear(out);
      const res = r && r.results; if (!res) return;
      const line = (label, x) => h('div', { class: 'row small', style: { padding: '6px 0', borderBottom: '1px solid var(--line)' } },
        h('span', {}, label), h('span', { class: 'sp' }),
        x ? h('span', { class: 'pill ' + (x.pass ? 'g' : 'r') }, (x.pass ? 'PASS' : 'FAIL') + ' · ' + x.diff_pct + '% diff (≤ ' + x.threshold + ')') : h('span', { class: 'td-muted' }, '—'));
      out.append(line('Revenue vs gateways', res.revenue), line('Spend vs Meta', res.spend),
        h('div', { class: 'row small', style: { padding: '6px 0' } }, h('span', {}, 'CAPI match quality'), h('span', { class: 'sp' }),
          h('span', { class: 'pill ' + (res.capi.avg_mq >= 7 ? 'g' : 'o') }, 'avg MQ ' + res.capi.avg_mq + ' · ' + res.capi.pct_good + '% ≥7')));
    };
    return h('div', {}, h('label', { text: 'Our week revenue vs gateways (₹ external settlement)' }), rev,
      h('label', { text: 'Our week spend vs Meta Ads Manager (₹ external total)', style: { marginTop: 10 } }), sp,
      h('button', { class: 'btn sm', style: { marginTop: 10 }, onclick: run }, 'Run checkers'), out);
  }

  // ================================================================ ALERTS
  async function renderAlerts(main) {
    const d = await get('/alerts');
    clear(main);
    const A = d.alerts, DB = d.db, M = d.mode;
    const sig = (label, bad, detail) => h('div', { class: 'sig ' + (bad ? 'bad' : 'ok') },
      h('span', { class: 'ind' }),
      h('div', {}, h('div', { class: 'st' }, label), h('div', { class: 'sd' }, detail)),
      h('span', { class: 'tag' }, bad ? 'ALERT' : 'OK'));
    main.append(
      banner('Production signal board (PRD §11). Five checks; a red signal is currently breaching. Engine ' + d.engine + ' · ' + modeChips(M), null),
      h('div', { class: 'card' },
        h('h2', { text: 'Signal checks' }),
        h('div', { style: { marginTop: 12 } },
          sig('Webhook failures (24h)', A.webhook_failures, DB.webhook_failures_24h + ' failed delivery(ies)'),
          sig('Queue age > 10 min', A.queue_age_over_10min, DB.queue.stale_over_10min + ' stale, ' + DB.queue.pending + ' pending, oldest due ' + DB.queue.age_min + 'm ago'),
          sig('Meta pull failures', A.meta_pull_failures, DB.meta_pull_failures.length ? DB.meta_pull_failures.map((m) => m.ad_account + ': ' + m.error).join('; ') : 'no errors recorded'),
          sig('CAPI send failures', A.capi_send_failures, DB.capi_stuck_unsent + ' unsent (' + DB.capi_suppressed_refund + ' suppressed for refunds)'),
          sig('Backup (daily)', !A.backup_not_recorded === false ? A.backup_not_recorded : A.backup_not_recorded, DB.backup.last_date ? 'last ' + DB.backup.last_date + ' · ' + (DB.backup.latest_file || '') : 'no daily backup recorded yet')),
        DB.webhook_failures && DB.webhook_failures.length ? h('div', { style: { marginTop: 14 } },
          h('h2', { text: 'Recent webhook failures' }),
          failTable(DB.webhook_failures)) : null),
      h('div', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { text: 'Prod toggles' }), h('span', { class: 'sp' })),
        h('div', { class: 'row' },
          h('button', { class: 'btn sm ' + (M.meta_business_verified ? 'sec' : ''), onclick: toggleMetaVerify }, M.meta_business_verified ? 'Mark Meta business unverified' : 'Mark Meta business verified'),
          h('button', { class: 'btn sm sec', onclick: toggleCapi }, 'Flip CAPI to ' + (M.capi === 'live' ? 'dry-run' : 'live'))),
        h('div', { class: 'td-muted small', style: { marginTop: 10 } },
          M.xt_subdomain ? 'xt.js served at https://' + M.xt_subdomain + '/xt.js for third-party CSP pages.' : 'Set XACQORA_XT_SUBDOMAIN (or host xt.js on your own subdomain) so third-party CSP pages can load it.')));
  }
  function modeChips(m) {
    return h('span', { class: 'row', style: { gap: 6 } },
      chip2(m.live ? 'live' : 'mock', m.live),
      chip2('CAPI ' + (m.capi === 'live' ? 'live' : 'dry'), m.capi === 'live'),
      chip2(m.secret_key_set ? 'secret set' : 'insecure dev key', m.secret_key_set),
      chip2(m.meta_business_verified ? 'Meta verified' : 'Meta not verified', m.meta_business_verified));
  }
  function chip2(label, good) {
    return h('span', { class: 'pill ' + (good ? 'g' : 'm') }, label);
  }
  function failTable(rows) {
    const t = h('div', { class: 'tblwrap', style: { marginTop: 8 } });
    t.append(h('thead', {}, h('tr', {}, h('th', {}, 'Platform'), h('th', {}, 'Client'), h('th', {}, 'Ref'), h('th', {}, 'Error'), h('th', {}, 'At'))),
      h('tbody', {}, rows.map((f) => h('tr', {},
        h('td', {}, platIcon(f.platform)), h('td', { class: 'td-muted' }, 'client ' + f.client),
        h('td', { class: 'td-muted mono small' }, f.ref || '—'), h('td', { class: 'td-muted small' }, f.error || '—'),
        h('td', { class: 'td-muted small' }, fmtDT(f.at))))));
    return t;
  }
  async function toggleMetaVerify() {
    const r = await post('/alerts/meta-verify', {});
    toast('Meta business ' + (r && r.verified ? 'verified' : 'unverified'), 'ok'); navigate();
  }
  async function toggleCapi() {
    const r = await post('/alerts/capi', {});
    toast('CAPI → ' + (r && r.capi), 'ok'); navigate();
  }

  // ================================================================ helpers
  function banner(text, ctx) {
    return h('div', { class: 'banner' }, icon('shield', 18), h('span', {}, text));
  }

  // wire up
  window.addEventListener('hashchange', navigate);
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); const s = root.querySelector('.search input'); if (s) s.focus(); }
 });
  boot().then(() => { if (ME) navigate(); });
  if (!location.hash) location.hash = '#/dashboard';
})();
