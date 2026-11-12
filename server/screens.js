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
// ---------------------------------------------------------------- Dashboard
// Master v9: real Meta spend front and center. The top-bar account switcher
// (layout accSelect) scopes KPIs, the 30-day trend, top campaigns/ads, the
// pull-status card and Reports to one ad account. Default (no ?acc) = the
// largest real account by 7-day spend. DATA_MODE=live swaps demo figures for
// real-only and renders clean empty states.
function dashboard(db, user, p) {
  const tx = makeTx(db, user); // Phase P: pins this user's RLS scope on Postgres
  const dm = require('./lib/datamode');
  const dataMode = dm.mode(tx);
  const settings = {
    attribution_model: tx.get(`SELECT value FROM settings WHERE key='attribution_model'`)?.value || 'last_paid_click',
    attribution_window_days: tx.get(`SELECT value FROM settings WHERE key='attribution_window_days'`)?.value || '30',
    wasted_spend_threshold: tx.get(`SELECT value FROM settings WHERE key='wasted_spend_threshold'`)?.value || '0',
  };
  // client logins are scoped to their own data; team roles see all internal clients
  const scopeIds = user.role === 'client' ? (user.client_ids || '').split(',').filter(Boolean) : null;

  // v11: a CLIENT-level select in the top-bar switcher (?client=). team roles
  // may pick any real client; a client login is locked to their own. In live
  // mode the switcher lists real (non-demo) clients only — dm.clientOptions
  // drops the client.demo=1 rows. Selecting a client scopes the account list,
  // KPIs, trend, top campaigns/ads, ROAS and funnel to that client's real
  // accounts (never a cross-client leak).
  const clientParam = user.role === 'client' ? String(scopeIds?.[0] || '') : String(p.client || '');
  const clientOpts = dm.clientOptions(tx, dataMode, scopeIds);
  const clientSel = clientOpts.some((c) => String(c.id) === clientParam) ? Number(clientParam) : 0;
  const repClientIds = clientSel ? [clientSel] : scopeIds; // the scope for THIS report

  // ---- real-data report (Meta spend front and center) ----
  // Design: opening the dashboard with no ?acc auto-selects the LARGEST
  // account by 7-day spend (base.defaultAccount), so real numbers show first.
  // ?acc=all = the explicit "All accounts (aggregate)" choice; any other ?acc
  // must be one of the caller's in-scope real accounts (invalid/foreign ->
  // falls back to the largest, never a cross-client leak).
  // v10: user-picked custom date range (?from=&to=, YYYY-MM-DD). Validated +
  // capped by S.parseDashboardRange (from<=to, span<=92d, no earlier than 365d
  // back); an invalid/over-cap range is ignored so the page always renders a
  // real-data preset window. When valid, KPIs/trend/top-tables are computed
  // over that exact window (rep.range) from genuine Meta spend.
  const rangeReq = S.parseDashboardRange(p);
  const rangeOpt = rangeReq.ok ? { from: rangeReq.from, to: rangeReq.to } : undefined;
  const base = S.metaAccountReport(tx, { adAccount: '', clientIds: repClientIds, dataMode, range: rangeOpt });
  const accParam = p.acc === undefined ? null : String(p.acc);
  let selected;
  if (accParam === null) selected = base.defaultAccount;                    // default = largest
  else if (accParam === '' || accParam === 'all') selected = '';            // aggregate
  else selected = base.accounts.some((a) => a.ad_account_id === accParam) ? accParam : base.defaultAccount;
  const rep = selected
    ? S.metaAccountReport(tx, { adAccount: selected, clientIds: repClientIds, dataMode, range: rangeOpt })
    : base;
  const range = rep.range; // the custom-window bundle, or null (preset mode)
  const kpis = rep.kpis;
  const win = p.win === '30' ? 'd30' : 'd7';
  const k = range ? range.kpi : kpis[win];
  const winLabel = range ? 'custom range' : (win === 'd7' ? 'last 7d' : 'last 30d');
  // Spend-accuracy fix (v13): label KPI currency HONESTLY — the "inr" column is
  // spend × fx_rate (AED accounts have no rate yet, so it is the raw AED
  // number). ₹ is only right for INR accounts.
  const kCur = rep.currency ? rep.currency.toUpperCase() : 'INR';
  const money2 = (n) => (n == null ? '—' : (kCur === 'INR' ? '₹' : kCur + ' ') + Math.round(n).toLocaleString('en-IN'));
  // truth label for the preset windows: KPIs now cover COMPLETE days
  // (N-7..N-1 / N-30..N-1, today excluded — Ads Manager basis). The 30-day
  // trend still includes today and says so.
  const todayStr = new Date().toISOString().slice(0, 10);
  const d1 = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const pullAt = Array.isArray(rep.pull) ? rep.pull.map((x) => x.last_pull_at).filter(Boolean).sort().pop() : (rep.pull && rep.pull.last_pull_at);
  const pullAgeH = pullAt ? Math.max(0, Math.round((Date.now() - new Date(pullAt).getTime()) / 3600000)) : null;
  const dataThroughNote = range ? ''
    : `<div class="small muted" style="margin-top:6px">
      <b>Data through ${d1}</b> · ${win === 'd7' ? 'last 7 complete days' : 'last 30 complete days'} (today ${todayStr} excluded — Meta finalises today's spend at T+1, so it is not in this KPI)
      ${pullAgeH != null ? ` · last Meta pull ${pullAgeH} h ago${pullAgeH > 24 ? ' · <a href="/meta/pull" class="small">Pull now</a>' : ''}` : ' · never pulled'}</div>`;
  const roasOk = rep.revenue > 0 && k.spend_inr > 0;
  const kpiCards = [
    { l: `${winLabel} spend (${kCur})`, v: money2(k.spend_inr), sub: [range ? range.rangeLabel : (rep.currency && rep.currency.toUpperCase() !== kCur ? `billing ${rep.currency}` : '')].filter(Boolean).join(' · ') },
    { l: 'Impressions', v: S.fmtN(k.impressions) },
    { l: 'Reach', v: S.fmtN(k.reach) },
    { l: 'Clicks · CTR', v: `${S.fmtN(k.clicks)} · ${k.ctr != null ? k.ctr + '%' : '—'}` },
    { l: 'Avg CPC', v: k.cpc != null ? money2(k.cpc) : '—' },
    { l: 'ROAS', v: roasOk ? (k.spend_inr ? Math.round(rep.revenue / k.spend_inr * 100) / 100 : '—') : '<span class="muted">N/A — pilot live</span>', noraos: !roasOk },
  ].map((x) => `<div class="kpi"><div class="l">${x.l}</div><div class="v" ${x.noraos ? 'style="font-size:16px"' : ''}>${x.v}</div>${x.sub ? `<div class="small muted">${S.esc(x.sub)}</div>` : ''}</div>`).join('');

  // ---- spend trend (30-day preset, or the chosen custom range) ----
  const trendSeries = range ? range.trend : rep.trend;
  const trendChart = S.sparklineSvg(trendSeries, { metric: 'spend' });
  const trendNote = selected
    ? `<div class="small muted" style="margin-top:6px">Per-campaign daily (click "All accounts" to view the aggregate):</div>`
    : `<div class="small muted" style="margin-top:6px">Daily spend across all real ad accounts.</div>`;
  // campaign split for a single account (custom range when one is chosen)
  let campSplit = '';
  const campSeries = range ? range.campTrend : rep.campTrend;
  if (campSeries.length) {
    const byCamp = {};
    for (const r of campSeries) byCamp[r.campaign] = (byCamp[r.campaign] || 0) + r.spend;
    const camps = Object.entries(byCamp).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const max = Math.max(1, ...camps.map((c) => c[1]));
    campSplit = `<div style="margin-top:10px">${camps.map((c) => `
      <div class="row" style="gap:8px;margin-bottom:6px"><div style="width:150px" class="small muted">${S.esc(c[0].slice(0, 22))}</div>
      <div class="bar" style="flex:1"><i style="width:${Math.max(2, (c[1] / max) * 100)}%"></i></div>
      <div style="width:70px;text-align:right" class="small">${money2(c[1])}</div></div>`).join('')}</div>`;
  }

  // ---- pull-status card (last pull + next auto-pull + per-account Pull now) ----
  const canPull = ['owner', 'admin', 'media_buyer'].includes(user.role);
  const pullRows = (Array.isArray(rep.pull) ? rep.pull : [rep.pull]).map((a) => {
    const rowId = rep.accounts.find((x) => x.ad_account_id === a.ad_account_id)?.id || '';
    if (!a || !a.last_pull_at) {
      return `<tr><td><b>${S.esc(a && a.name || a && a.ad_account_id || '—')}</b></td>
        <td><span class="pill r">never pulled</span></td><td class="small muted">—</td><td class="small muted">—</td>
        ${canPull ? `<td>${rowId ? `<a class="btn sm sec" href="/meta/pull?acc=${rowId}">Pull now</a>` : ''}</td>` : ''}</tr>`;
    }
    const ageH = Math.max(0, Math.round((Date.now() - new Date(a.last_pull_at).getTime()) / 3600000));
    const next = new Date(new Date(a.last_pull_at).getTime() + 3 * 3600000);
    const due = next.getTime() < Date.now();
    const err = a.last_error;
    return `<tr>
      <td><b>${S.esc(a.name || a.ad_account_id)}</b><div class="small muted">${S.esc(a.ad_account_id || '')}</div></td>
      <td>${err ? `<span class="pill r" title="${S.esc(String(err))}">${S.esc(String(err).slice(0, 30))}…</span>` : `<span class="pill g">ok · ${ageH}h ago</span>`}</td>
      <td class="small muted">${S.fmtDT(a.last_pull_at)}</td>
      <td>${due ? `<span class="pill o">due now</span>` : `<span class="small muted">next ${S.fmtDT(next.toISOString())}</span>`}</td>
      ${canPull ? `<td>${rowId ? `<a class="btn sm sec" href="/meta/pull?acc=${rowId}">Pull now</a>` : ''}</td>` : ''}</tr>`;
  }).join('');
  const pullHead = `<thead><tr><th>Account</th><th>Status</th><th>Last pull</th><th>Next auto-pull</th>${canPull ? '<th></th>' : ''}</tr></thead>`;
  const pullCard = `
  <div class="card"><h2>Meta pull status <span class="badge">auto every 3h + nightly</span></h2>
    <div class="tabwrap"><table>${pullHead}
    <tbody>${pullRows || `<tr><td colspan="${canPull ? 5 : 4}" class="muted">No real ad accounts yet — fill META_AD_ACCOUNT_IDS in .env and restart the server</td></tr>`}</tbody></table></div>
    <div class="row" style="margin-top:8px;gap:8px"><a class="btn sm sec" href="/meta.html">Manage accounts →</a>
      <span class="small muted">Failures show here + on <a href="/alerts.html">Alerts</a> (classified, retried with backoff).</span></div></div>`;

  // ---- top campaigns / top ads (over the chosen window in range mode) ----
  const topCampSrc = range ? range.topCampaigns : rep.topCampaigns;
  const topAdsSrc = range ? range.topAds : rep.topAds;
  const campRows = topCampSrc.map((c) => `<tr>
    <td><b>${S.esc(c.name)}</b></td><td><span class="pill ${c.status === 'ACTIVE' ? 'g' : 'o'}">${S.esc(c.status || '—')}</span></td>
    <td>${money2(c.spend)}</td><td class="small">${S.fmtN(c.impressions)} imp</td></tr>`).join('');
  const adThumb = (img) => `<img class="lead-img" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='52' height='52'><rect width='52' height='52' rx='8' fill='%23252c40'/></svg>" style="width:34px;height:34px" alt="">`;
  const adRows = topAdsSrc.map((a) => `<tr>
    <td>${adThumb(a.creative_img)} <b>${S.esc(a.name || a.ad_id)}</b><div class="small muted">${S.esc(a.ad_id)} · ${S.esc(a.creative_img || '')}</div></td>
    <td><span class="pill ${a.status === 'ACTIVE' ? 'g' : 'o'}">${S.esc(a.status || '—')}</span></td>
    <td>${money2(a.spend)}</td><td class="small">${S.fmtN(a.impressions)} imp</td><td class="small">${S.fmtN(a.clicks)} clk</td></tr>`).join('');

  // ---- bottom: funnel + recent leads (compact, demo-aware empty states) ----
  // scoped to the chosen client (repClientIds) so the funnel/recent-leads
  // match the KPIs above, never the whole workspace.
  const live = dataMode === 'live';
  const fp = S.funnelReport(tx, null, settings, repClientIds, live);
  const totalLeads = repClientIds
    ? tx.get(`SELECT COUNT(*) c FROM lead WHERE client_id IN (${repClientIds.map((n) => Number(n)).join(',')})`)?.c || 0
    : tx.get(`SELECT COUNT(*) c FROM lead`)?.c || 0;
  const funnelSteps = [
    { l: 'Leads', v: fp.leads, max: fp.leads || 1, c: 'b' },
    { l: 'Paid', v: fp.paid, max: fp.leads || 1, c: 'g' },
  ];
  const funnelBars = funnelSteps.map((s) => `
    <div style="margin-bottom:9px">
      <div class="row" style="gap:8px"><div style="width:96px" class="muted small">${s.l}</div>
      <div class="bar" style="flex:1"><i style="width:${Math.max(2, (s.v / s.max) * 100)}%;background:var(--${s.c})"></i></div>
      <div style="width:64px;text-align:right" class="small">${S.fmtN(s.v)}</div></div>
    </div>`).join('');
  const leadsEmpty = dataMode === 'live' ? `<div class="empty-state">${S.esc(dm.EMPTY.leads)}</div>` : '';
  const recentRows = (() => {
    const ex = dm.leadEx(dataMode, 'l'); // v11: seed + demo-client leads hide in live
    const where = repClientIds ? `WHERE l.client_id IN (${repClientIds.map((n) => Number(n)).join(',')}) ${ex ? 'AND ' + ex : ''}` : (ex ? `WHERE ${ex}` : '');
    return tx.all(`SELECT l.id, l.name, l.phone, l.email, l.stage, l.client_id, l.created_at, c.name client_name
      FROM lead l LEFT JOIN client c ON c.id=l.client_id ${where} ORDER BY l.id DESC LIMIT 8`);
  })().map((r) => `<tr>
    <td><a href="/lead/${r.id}">${S.esc(r.name || '—')}</a></td>
    <td class="small muted">${S.esc(r.client_name || '')}</td>
    <td class="small">${phoneOf(user, r)}</td>
    <td><span class="pill ${stagePillClass(r.stage)}">${S.esc(r.stage)}</span></td>
    <td class="small muted">${S.fmtDT(r.created_at)}</td></tr>`).join('');

  // ---- switcher options (real act_ accounts, status marker) ----
  const dotMark = (a) => a.last_error ? ' · error' : (a.last_pull_at ? '' : ' · never pulled');
  // The range picker (header) must carry the current window through an account
  // switch, so the switcher's hidden fields keep from/to (range mode) or win.
  // v11: ?client= rides through too, so an account switch keeps the chosen
  // client (and vice-versa a client switch keeps the current window).
  const switcherHidden = range
    ? [{ name: 'from', value: range.from }, { name: 'to', value: range.to }]
    : [{ name: 'win', value: win === 'd7' ? '7' : '30' }];
  if (clientSel) switcherHidden.unshift({ name: 'client', value: String(clientSel) });
  const switcher = {
    path: 'dashboard.html',
    current: selected,
    options: rep.accounts.map((a) => ({ value: a.ad_account_id, label: `${a.name || a.ad_account_id}${dotMark(a)}` })),
    hidden: switcherHidden,
    // v11 client-level select (top bar): real clients only in live mode.
    clientOptions: user.role !== 'client' ? clientOpts.map((c) => ({ value: String(c.id), label: c.name })) : [],
    clientCurrent: clientSel ? String(clientSel) : '',
  };

  // ---- custom date-range picker (v10): presets + a From/To form ----
  // Presets clear the range; the From/To form submits ?from=&to= (+?acc=) which
  // re-renders the KPIs/trend/top-tables over that exact window. The refresh
  // button live-fetches the chosen window from Meta when it isn't in the DB yet.
  const accQ = selected ? '&acc=' + encodeURIComponent(selected) : '';
  const refreshHref = `/dashboard/refresh${accQ ? '?acc=' + encodeURIComponent(selected) : ''}` +
    (range ? `&from=${range.from}&to=${range.to}` : '');
  const rangeControl = `
    <form method="get" action="/dashboard.html" class="inline" style="gap:6px;align-items:center">
      ${selected ? '<input type="hidden" name="acc" value="' + S.esc(selected) + '">' : ''}
      ${clientSel ? '<input type="hidden" name="client" value="' + clientSel + '">' : ''}
      <label class="small muted">From</label><input type="date" name="from" value="${S.esc(range ? range.from : p.from || '')}">
      <label class="small muted">To</label><input type="date" name="to" value="${S.esc(range ? range.to : p.to || '')}">
      <button class="btn sm">Apply</button>
    </form>`;
  const rangeBadge = range
    ? `<span class="badge" style="color:var(--accent)">custom: ${S.esc(range.rangeLabel)}</span>` : '';

  const clientName = clientOpts.find((c) => c.id === clientSel)?.name;
  const titleSuffix = selected ? (rep.accounts.find((a) => a.ad_account_id === selected)?.name || selected)
    : (clientSel ? clientName : (scopeIds ? 'My account' : 'All accounts'));
  const noDataCta = range && !range.hasData ? `
  <div class="card" style="margin-top:0;border-color:var(--warn,#c79b2f)">
    <div class="row" style="justify-content:space-between;align-items:center;gap:8px">
      <div><b>No Meta data yet for ${S.esc(range.rangeLabel)}</b>
        <div class="small muted">That window hasn't been pulled from Meta into this app. Fetch it now — the numbers shown will be the real Meta figures for those exact days (no estimate, no demo data).</div></div>
      ${canPull ? `<a class="btn" href="${refreshHref}">Fetch this range from Meta →</a>` : `<span class="small muted">ask a team member to pull it</span>`}
    </div>
  </div>` : '';
  const repullNote = range && range.hasData ? `
    <div class="row" style="justify-content:space-between;align-items:center;margin:10px 0 4px">
      <span class="small muted">Showing genuine Meta spend for <b>${S.esc(range.rangeLabel)}</b>${canPull ? '' : ' (team-only pull)'}</span>
      ${canPull ? `<a class="btn sm sec" href="${refreshHref}">Re-pull this range</a>` : ''}
    </div>` : '';

  // ---- v11 accuracy spot-check: app-spend (7d, what the KPI shows) vs the
  // operator's Ads-Manager figure per real account, with the drift % (gate
  // <=1%). Team-only "Re-check vs Meta" button live-fills the Meta column. ----
  const accRows = S.accuracyCheck(tx, dataMode, repClientIds);
  const cur = (n, c) => n == null ? '—' : `${c ? c + ' ' : '₹'}${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
  const accBody = accRows.length ? accRows.map((r) => {
    const driftCell = r.drift == null ? `<span class="muted small">—</span>`
      : r.gateOk
        ? `<span class="pill g">${r.drift}%</span>`
        : `<span class="pill r">${r.drift}%</span>`;
    return `<tr>
      <td><b>${S.esc(r.client_name || '—')}</b><div class="small muted">${S.esc(r.name || r.ad_account_id)}</div></td>
      <td class="small muted">${S.esc(r.ad_account_id)}${r.currency ? ` · ${S.esc(r.currency)}` : ''}</td>
      <td>${cur(r.app7d, r.currency)}</td>
      <td>${r.meta7d == null ? `<span class="muted small">${r.checked_at ? 'check failed — see Meta hub' : 'not checked'}</span>` : cur(r.meta7d, r.currency)}</td>
      <td>${driftCell}</td>
      <td class="small muted">${S.esc(r.window || '')}${r.checked_at ? ` · ${S.fmtDT(r.checked_at)}` : ''}</td>
      ${canPull ? `<td>${r.id ? `<a class="btn sm sec" href="/meta/check?acc=${r.id}" title="Live-fetch last 7d from Meta + record the drift">Re-check</a>` : ''}</td>` : ''}
    </tr>`;
  }).join('') : `<tr><td colspan="${canPull ? 7 : 6}" class="muted">No real ad accounts yet — fill META_AD_ACCOUNT_IDS in .env and restart</td></tr>`;
  const accuracyCard = `
  <div class="card"><h2>Accuracy spot-check <span class="badge">app 7d spend vs Meta Ads Manager · gate ≤ 1% drift</span></h2>
    <div class="tabwrap"><table>
      <thead><tr><th>Client</th><th>ACT_ account</th><th>7 complete days (app)</th><th>7 complete days (Meta live)</th><th>drift %</th><th>window · checked</th>${canPull ? '<th></th>' : ''}</tr></thead>
      <tbody>${accBody}</tbody></table></div>
    <div class="small muted">Both columns now use the SAME window — the last 7 <b>complete</b> days (today excluded), the basis Ads Manager's "last 7 days" uses; Meta's today figure is T+1-mutable so it is intentionally left out. Figures are in each account's billing currency (INR / AED …) — the same units Meta's Ads Manager shows. "Re-check" live-fetches that exact window from Meta and records the drift (it does NOT re-pull the app's spend). A green pill means the app's number matches Meta within 1%.</div>
  </div>`;
  const body = `
  <div class="row pagehead" style="justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
    <h1 style="margin:0">Dashboard ${titleSuffix !== 'All accounts' ? `· <span class="badge">${S.esc(titleSuffix)}</span>` : '<span class="badge">all real accounts</span>'}</h1>
    <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center">
      <span class="badge">window</span>
      <a class="btn sm ${!range && win === 'd7' ? '' : 'sec'}" href="/dashboard.html?win=7${accQ}">Last 7d</a>
      <a class="btn sm ${!range && win === 'd30' ? '' : 'sec'}" href="/dashboard.html?win=30${accQ}">Last 30d</a>
      ${rangeControl}
    </div>
  </div>
  ${noDataCta}
  <div class="grid g6" style="margin-top:10px">${kpiCards}</div>
  ${dataThroughNote}
  ${repullNote}

  ${accuracyCard}

  <div class="grid g2" style="margin-top:14px">
    <div class="card"><h2>Spend trend <span class="badge">${range ? S.esc(range.rangeLabel) : (win === 'd7' ? 'last 7 days' : 'last 30 days')} · through today (not final, T+1) · ${kCur}</span></h2>
      ${trendChart || '<div class="empty-state">No spend yet — run a Meta pull to start charting.</div>'}
      ${trendNote}${campSplit}</div>
    ${pullCard}
  </div>

  <div class="grid g2" style="margin-top:0">
    <div class="card"><h2>Top campaigns <span class="badge">by ${range ? S.esc(range.rangeLabel) : (win === 'd7' ? '7d' : '30d')} spend</span></h2>
      <div class="tabwrap"><table>${campRows || '<tr><td class="muted">No campaigns pulled yet</td></tr>'}</table></div></div>
    <div class="card"><h2>Top ads <span class="badge">by ${range ? S.esc(range.rangeLabel) : (win === 'd7' ? '7d' : '30d')} spend</span></h2>
      <div class="tabwrap"><table>${adRows || '<tr><td class="muted">No ads pulled yet</td></tr>'}</table></div></div>
  </div>

  ${leadsEmpty}
  <div class="grid g2" style="margin-top:0">
    <div class="card"><h2>Funnel <span class="badge">${win === 'd7' ? '7' : '30'}d</span></h2>${funnelBars}
      <div class="small muted">Attribution: <b>${S.esc(settings.attribution_model)}</b> · window ${settings.attribution_window_days}d · revenue net of refunds.</div></div>
    <div class="card"><h2>Recent leads</h2>
      <div class="tabwrap"><table>${recentRows || `<tr><td class="muted">${dataMode === 'live' ? 'No leads yet — connect a webhook (Webhooks & API Keys) and your first FlexiFunnels form lands here' : 'No leads'}</td></tr>`}</table></div>
      <div class="row" style="margin-top:8px"><a class="small" href="/app/#/webhooks">Generate webhook URLs / API keys →</a></div></div>
  </div>`;
  return S.layout({
    title: 'Dashboard', nav: S.navFor(user), active: 'dashboard.html', user, body,
    band: S.layoutDemoBand(dataMode), accSelect: switcher,
  });
}
function stagePillClass(s) {
  if (['Paid'].includes(s)) return 'g';
  if (['Attended', 'Hot', 'Call Booked', 'Registered'].includes(s)) return 'o';
  if (['Lost'].includes(s)) return 'r';
  return 'b';
}

// ---------------------------------------------------------------- Lead list
function leads(db, user, p) {
  const tx = makeTx(db, user); // Phase P: pins this user's RLS scope on Postgres
  const dm = require('./lib/datamode');
  const dataMode = dm.mode(tx);
  const q = (p.q || '').trim();
  const stage = p.stage || '';
  // client logins only ever see their own client; team roles can filter
  const scopeIds = user.role === 'client' ? (user.client_ids || '').split(',').filter(Boolean) : [];
  const client = user.role === 'client' ? String(scopeIds[0] || '') : (p.client || '');
  let where = `1=1`;
  const args = [];
  const exLead = dm.leadEx(dataMode, 'l'); // v11: seed + demo-client leads hide in live
  if (exLead) { where += ` AND ${exLead}`; } // live mode: hide seed/demo leads
  if (q) { where += ` AND (l.phone LIKE ? OR l.email LIKE ? OR l.name LIKE ?)`; args.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
  if (stage) { where += ` AND l.stage = ?`; args.push(stage); }
  if (client) { where += ` AND l.client_id = ?`; args.push(client); }
  // PRD "every number links to the leads behind it": report KPIs / ad rows /
  // source-mix chips deep-link here with ?ids=1,2,3. Numeric-only, so no SQLi.
  const ids = String(p.ids || '').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
  let idsBanner = '';
  if (ids.length) {
    where += ` AND l.id IN (${ids.join(',')})`;
    idsBanner = `<div class="note" style="margin-top:12px">Showing <b>${ids.length}</b> leads behind a report number. <a href="/leads">Clear</a></div>`;
  }
  const rows = tx.all(`SELECT l.*, c.name client_name,
      (SELECT COUNT(*) FROM event e WHERE e.lead_id=l.id) ev,
      (SELECT COALESCE(SUM(d.amount),0) FROM deal d WHERE d.lead_id=l.id AND d.status='success' AND d.refunded_at IS NULL) paid
    FROM lead l LEFT JOIN client c ON c.id=l.client_id WHERE ${where}
    ORDER BY l.id DESC LIMIT 500`, ...args);
  const stages = S.DEFAULT_STAGES;
  // a client login only sees its own client; team roles see real clients only
  // in live mode (demo clients are hidden — v11), every client in demo mode.
  const clients = user.role === 'client'
    ? tx.all(`SELECT id, name FROM client WHERE id IN (${scopeIds.map((n) => Number(n)).join(',')})`)
    : dm.clientOptions(tx, dataMode, null).map((c) => ({ id: c.id, name: c.name }));
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
  <div class="row pagehead" style="justify-content:space-between;align-items:center">
    <h1 style="margin:0">Leads <span class="badge">${rows.length} shown</span></h1>
    <a class="btn sec" href="/import">Import CSV</a>
  </div>
  <div class="card">
    <form class="inline" method="get" action="/leads" style="margin-top:0">
      <div><label>Search</label><input name="q" placeholder="phone / email / name" value="${S.esc(q)}"></div>
      <div><label>Stage</label><select name="stage"><option value="">All</option>${stages.map((s) => `<option ${s === stage ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div><label>Client</label><select name="client"><option value="">All</option>${clients.map((c) => `<option value="${c.id}" ${String(c.id) === client ? 'selected' : ''}>${S.esc(c.name)}</option>`).join('')}</select></div>
      <button class="btn" type="submit">Filter</button>
    </form>
    ${idsBanner}
  </div>
  <div class="card">
    <div class="tabwrap"><table>
      <thead><tr><th>Name</th><th>Client</th><th>Phone</th><th>Email</th><th>Stage</th><th>Owner</th><th>Paid</th><th>Events</th></tr></thead>
      <tbody>${rowsHtml || (dataMode === 'live'
        ? `<tr><td colspan="8"><div class="empty-state">${S.esc(dm.EMPTY.leads)}<br><a href="/pilot-live-checklist">Pilot cutover checklist →</a></div></td></tr>`
        : '<tr><td colspan="8" class="muted">No leads match</td></tr>')}</tbody>
    </table></div>
  </div>`;
  return S.layout({ title: 'Leads', nav: S.navFor(user), active: 'leads', user, body, band: S.layoutDemoBand(dataMode) });
}

// ---------------------------------------------------------------- Lead timeline
function leadTimeline(db, user, p) {
  const tx = makeTx(db, user); // Phase P: pins this user's RLS scope on Postgres
  const dataMode = require('./lib/datamode').mode(tx);
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
  return S.layout({ title: lead.name || 'Lead', nav: S.navFor(user), active: 'leads.html', user, body, band: S.layoutDemoBand(dataMode) });
}

// ---------------------------------------------------------------- Pipeline kanban
function pipeline(db, user, p) {
  const tx = makeTx(db, user); // Phase P: pins this user's RLS scope on Postgres
  const sec = require('./lib/security');
  const dm = require('./lib/datamode');
  const dataMode = dm.mode(tx);
  const exLead = dm.leadEx(dataMode, 'l'); // v11: seed + demo-client leads hide in live
  // a client login is locked to its own clients; the ?client= filter cannot widen it
  let client = p.client || '';
  if (user.role === 'client') client = String((user.client_ids || '').split(',')[0] || '');
  const stages = S.DEFAULT_STAGES;
  const where = [client ? `AND l.client_id=?` : '', exLead ? `AND ${exLead}` : ''].filter(Boolean).join(' ');
  const args = client ? [client] : [];
  const stageRows = stages.map((s) => tx.all(`SELECT l.*, c.name client_name FROM lead l LEFT JOIN client c ON c.id=l.client_id WHERE l.stage=? ${where} ORDER BY l.id DESC LIMIT 40`, s, ...args));
  const totalCards = stageRows.reduce((n, r) => n + r.length, 0);
  const cols = dataMode === 'live' && totalCards === 0
    ? `<div class="empty-state">${S.esc(dm.EMPTY.leads)}<br><a href="/pilot-live-checklist">Pilot cutover checklist →</a></div>`
    : stages.map((s, i) => {
        const rows = stageRows[i];
        const cards = rows.map((r) => `<div class="kcard"><a href="/lead/${r.id}">${S.esc(r.name || '—')}</a>
          <div class="small muted">${S.esc(r.client_name || '')} · ${phoneOf(user, r)}</div></div>`).join('');
        return `<div class="kcol"><h3>${s} <span class="badge">${rows.length}</span></h3>${cards || '<div class="muted small">empty</div>'}</div>`;
      }).join('');
  const clients = user.role === 'client'
    ? tx.all(`SELECT id, name FROM client WHERE id IN (${(user.client_ids || '').split(',').filter(Boolean).map((n) => Number(n)).join(',') || '0'})`)
    : dm.clientOptions(tx, dataMode, null).map((c) => ({ id: c.id, name: c.name }));
  const body = `
  <div class="row pagehead" style="justify-content:space-between;align-items:center">
    <h1 style="margin:0">Pipeline</h1>
    <form method="get" action="/pipeline.html" class="inline">
      <div><label>Client</label><select name="client"><option value="">All</option>${clients.map((c) => `<option value="${c.id}" ${String(c.id) === client ? 'selected' : ''}>${S.esc(c.name)}</option>`).join('')}</select></div>
      <button class="btn sec">Apply</button></form>
  </div>
  <div class="kanban">${cols}</div>`;
  return S.layout({ title: 'Pipeline', nav: S.navFor(user), active: 'pipeline.html', user, body, band: S.layoutDemoBand(dataMode) });
}

// ---------------------------------------------------------------- Reports
function reports(db, user, p) {
  const tx = makeTx(db, user); // Phase P: pins this user's RLS scope on Postgres
  const dm = require('./lib/datamode');
  const dataMode = dm.mode(tx);
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
  // Master v9 ?acc=: scope the report to one real ad account. Validated
  // against the caller's in-scope real accounts; invalid/foreign -> off.
  const repAcc = S.metaAccountReport(tx, { adAccount: '', clientIds: scopeIds, dataMode });
  const accReq = String(p.acc || '');
  const acc = repAcc.accounts.some((a) => a.ad_account_id === accReq) ? accReq : '';
  // v11: the client picker lists real (non-demo) clients only in live mode — a
  // demo client's whole dataset is hidden, so it must not be pickable either.
  const allClients = user.role === 'client'
    ? tx.all(`SELECT id, name FROM client WHERE id IN (${(scopeIds || []).map((n) => Number(n)).join(',') || '0'})`)
    : dm.clientOptions(tx, dataMode, null).map((c) => ({ id: c.id, name: c.name }));
  const live = dataMode === 'live';
  const ap = S.adPerformance(tx, settings, scopeIds, acc, live);
  const fp = S.funnelReport(tx, null, settings, scopeIds, live);
  const waste = S.wastedSpend(ap);
  const mix = S.sourceMix(tx, scopeIds, live);
  const mvt = S.metaVsTracker(tx, settings, scopeIds, acc, live); // PRD §5.7 Meta vs Track
  const models = ['last_paid_click', 'first_click', 'linear', 'lead_source'];
  const modelNames = { last_paid_click: 'Last paid click (default)', first_click: 'First click', linear: 'Linear', lead_source: 'Lead source' };

  // PRD "every number links to the leads behind it": deep-link a value to the
  // list of leads that make it up (numeric ids, so RLS-safe on the leads screen).
  const drill = (ids, label, title = '') => {
    const list = (ids || []).join(',');
    if (!list) return `<span class="muted">${S.esc(label)}</span>`;
    const href = `/leads?ids=${encodeURIComponent(list)}${clientFilter ? `&client=${clientFilter}` : ''}`;
    return `<a href="${href}" title="${S.esc(title || ('open ' + list.length + ' leads'))}">${S.esc(label)}</a>`;
  };
  const drillNum = (ids, value) => {
    const list = (ids || []).join(',');
    if (!list) return S.esc(value);
    return `<a href="/leads?ids=${encodeURIComponent(list)}${clientFilter ? `&client=${clientFilter}` : ''}">${S.esc(value)}</a>`;
  };
  // export URL preserving the current filters (so CSV/Excel match what's shown)
  const expQ = `?client=${clientFilter}&model=${settings.attribution_model}&window=${settings.attribution_window_days}&from=${settings.report_from || ''}&to=${settings.report_to || ''}${acc ? `&acc=${encodeURIComponent(acc)}` : ''}`;

  const adRows = ap.rows.map((r) => `<tr>
    <td><img class="lead-img" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='52' height='52'><rect width='52' height='52' rx='8' fill='%23252c40'/></svg>" style="width:34px;height:34px">
      <b>${S.esc(r.name)}</b>
      <div class="small muted">${S.esc(r.campaign)} · ${S.esc(r.account || '')} · ${S.esc(r.ad_id)}</div></td>
    <td>${S.esc(r.status)}</td>
    <td>${S.fmtINR(r.spend)}</td>
    <td class="small">${S.fmtN(r.impressions)}</td>
    <td class="small">${S.fmtN(r.clicks)}</td>
    <td>${r.cpm != null ? S.fmtINR(r.cpm) : '—'}</td>
    <td>${drill(r.lead_ids, S.fmtN(r.leads), r.leads + ' leads behind this ad')}</td>
    <td>${drill(r.lead_ids, S.fmtINR(r.revenue), 'revenue attributed to this ad')}</td>
    <td>${r.roas != null ? r.roas : '—'}</td>
    <td>${S.fmtINR(r.profit)} ${r.wasted ? '<span class="pill r">wasted</span>' : ''}</td>
    <td class="small">${r.meta_conv > 0 ? `${r.meta_conv} Meta · ${r.our_conv} ours · ${r.conv_delta >= 0 ? '+' : ''}${r.conv_delta}` : '—'}</td>
  </tr>`).join('');

  const wasteRows = waste.map((r) => `<tr><td>${S.esc(r.name)}</td><td>${S.fmtINR(r.spend)}</td><td class="muted">${S.fmtN(r.impressions)} imp</td>
    <td>${r.leads} leads</td><td><span class="pill r">0 sales</span></td></tr>`).join('');

  // KPIs: the count numbers link to the leads behind them (fp.lead_ids).
  const L = fp.lead_ids || {};
  const fv = [
    ['Leads', drillNum(L.leads, S.fmtN(fp.leads))],
    ['Registered', drillNum(L.registered, S.fmtN(fp.registered))],
    ['Attended', drillNum(L.attended, S.fmtN(fp.attended))],
    ['Calls', drillNum(L.calls, S.fmtN(fp.calls))],
    ['Sales (net)', drillNum(L.paid, S.fmtN(fp.paid))],
    ['Revenue (net)', drillNum(L.revenue, S.fmtINR(fp.revenue))],
    ['Refunded', drillNum(L.refunded, S.fmtN(fp.refunded || 0))],
    ['Ad spend', S.fmtINR(fp.spend)],
    ['CPL', fp.cpl != null ? S.fmtINR(fp.cpl) : '—'],
    ['Show-up rate', S.fmtPct(fp.show_up_rate)],
    ['Close rate', S.fmtPct(fp.close_rate)],
    ['Cost per sale', fp.cost_per_sale != null ? S.fmtINR(fp.cost_per_sale) : '—'],
    ['ROAS', ap.total.roas != null ? ap.total.roas : '—'],
  ].map((x) => `<div class="kpi"><div class="l">${x[0]}</div><div class="v" style="font-size:18px">${x[1]}</div></div>`).join('');

  const mixChips = mix.map((m) => `<a class="chip" href="/leads?ids=${encodeURIComponent((m.lead_ids || []).join(','))}${clientFilter ? `&client=${clientFilter}` : ''}" title="open ${m.c} leads">${'<b>' + S.esc(m.src) + '</b> ' + m.c}</a>`).join('');
  const attr = fp.attribution;
  // Meta vs Track table (PRD §5.7): Meta-reported conversions vs our counted leads, per ad + delta.
  const mvtRows = (mvt.rows || []).map((r) => `<tr>
    <td><b>${S.esc(r.ad)}</b><div class="small muted">${S.esc(r.campaign || '')}</div></td>
    <td>${r.meta_conv}</td><td>${r.our_conv}</td>
    <td class="small">${r.delta > 0 ? '+' + r.delta : r.delta} ${r.delta > 0 ? '<span class="pill m">Meta over</span>' : r.delta < 0 ? '<span class="pill b">Meta under</span>' : '<span class="pill">match</span>'}</td>
  </tr>`).join('');
  const exportBtns = (kind, label) => {
    const q = expQ;
    return `<div class="row" style="gap:8px;margin-top:8px">
      <a class="btn sm" href="/export/${kind}${q}&fmt=csv">${label} · CSV</a>
      <a class="btn sm sec" href="/export/${kind}${q}&fmt=excel">${label} · Excel</a></div>`;
  };
  const body = `
  <div class="row pagehead" style="justify-content:space-between;align-items:center">
    <h1 style="margin:0">Reports <span class="badge">attribution: ${modelNames[settings.attribution_model] || settings.attribution_model}, ${settings.attribution_window_days}d window</span></h1>
  </div>
  <div class="card">
    <form class="inline" method="get" action="/reports.html" style="margin-top:0">
      ${user.role !== 'client' ? `<div><label>Client</label><select name="client"><option value="">All clients</option>${allClients.map((c) => `<option value="${c.id}" ${clientFilter === String(c.id) ? 'selected' : ''}>${S.esc(c.name)}</option>`).join('')}</select></div>` : ''}
      <div><label>Model</label><select name="model">${models.map((m) => `<option value="${m}" ${m === settings.attribution_model ? 'selected' : ''}>${modelNames[m]}</option>`).join('')}</select></div>
      <div><label>Window</label><select name="window">${[7, 14, 30, 60].map((w) => `<option ${String(w) === settings.attribution_window_days ? 'selected' : ''}>${w}d</option>`).join('')}</select></div>
      <div><label>From</label><input type="date" name="from" value="${S.esc(settings.report_from || '')}"></div>
      <div><label>To</label><input type="date" name="to" value="${S.esc(settings.report_to || '')}"></div>
      <button class="btn">Apply</button>
    </form>
    <div class="note">Every sale is credited to one ad by this fixed rule and the report states which rule it used. Sales with no ad click in the window go to <b>Organic / unknown</b>. Every number links to the leads behind it; revenue is net of refunds. ${user.role === 'client' ? '<b>This report is limited to your own client data.</b>' : ''}</div>
  </div>

  <div class="card"><h2>Funnel ${user.role === 'client' ? '(your client)' : clientFilter ? '(selected client)' : '(all clients)'} ${exportBtns('funnel', 'Export funnel')}</h2><div class="grid g4" style="grid-template-columns:repeat(4,1fr)">${fv}</div>
    <div class="small muted" style="margin-top:8px">Attribution buckets: <span class="pill b">${attr.attributed} attributed</span>
      <span class="pill m">${attr.organic} organic/unknown</span> <span class="badge">${settings.attribution_model}</span></div></div>

  <div class="card"><h2>Ad performance ${exportBtns('report', 'Export ad performance')}</h2>
    <div class="tabwrap"><table><thead><tr><th>Ad</th><th>Status</th><th>Spend</th><th>Impr.</th><th>Clicks</th><th>CPM</th><th>Leads</th><th>Revenue</th><th>ROAS</th><th>Profit</th><th>Meta vs ours</th></tr></thead>
    <tbody>${adRows || '<tr><td class="muted">No ads pulled yet (Meta pull pending)</td></tr>'}</tbody></table></div>
    <div class="small muted" style="margin-top:8px">Total: spend ${S.fmtINR(ap.total.spend)} · revenue ${S.fmtINR(ap.total.revenue)} · leads ${ap.total.leads} · ROAS ${ap.total.roas ?? '—'} · wasted ads ${ap.total.wasted_ads}</div>
  </div>

  <div class="grid g2">
    <div class="card"><h2>Wasted spend <span class="badge">≥ ${settings.wasted_spend_threshold} spend, 0 sales</span></h2>
      <div class="tabwrap"><table><thead><tr><th>Ad</th><th>Spend</th><th>Impr.</th><th>Leads</th><th></th></tr></thead>
      <tbody>${wasteRows || '<tr><td class="muted">No wasted spend</td></tr>'}</tbody></table></div></div>
    <div class="card"><h2>Lead source mix ${exportBtns('source-mix', 'Export mix')}</h2>${mixChips || '<span class="muted">—</span>'}
      <h2 style="margin-top:14px">Meta vs Xacqora Track ${exportBtns('meta-vs-track', 'Export')}</h2>
      ${mvtRows
        ? `<div class="tabwrap"><table><thead><tr><th>Ad</th><th>Meta conv</th><th>Our leads</th><th>Delta</th></tr></thead><tbody>${mvtRows}</tbody></table></div>
          <div class="small muted">Meta conversions total <b>${mvt.meta_conv_total}</b> vs our counted leads <b>${mvt.our_conv_total}</b> (delta ${mvt.delta >= 0 ? '+' + mvt.delta : mvt.delta}). ${S.esc(mvt.note)}</div>`
        : '<div class="small muted">No Meta conversion data yet — run a Meta pull to populate per-ad "Conversions".</div>'}
      </div>
  </div>`;
  const repSwitcher = {
    path: 'reports.html',
    current: acc,
    options: repAcc.accounts.map((a) => ({ value: a.ad_account_id, label: a.name || a.ad_account_id })),
    hidden: [
      { name: 'client', value: clientFilter },
      { name: 'model', value: settings.attribution_model },
      { name: 'window', value: settings.attribution_window_days },
      { name: 'from', value: settings.report_from || '' },
      { name: 'to', value: settings.report_to || '' },
    ],
  };
  const accBadge = acc ? ` · scoped to <b>${S.esc((repAcc.accounts.find((a) => a.ad_account_id === acc) || {}).name || acc)}</b>` : '';
  return S.layout({
    title: 'Reports', nav: S.navFor(user), active: 'reports.html', user, body,
    band: S.layoutDemoBand(dataMode), accSelect: user.role !== 'client' ? repSwitcher : undefined,
  });
}

// ---------------------------------------------------------------- Meta hub
function meta(db, user, p) {
  const tx = makeTx(db, user); // Phase P: pins this user's RLS scope on Postgres
  const dm = require('./lib/datamode');
  const dataMode = dm.mode(tx);
  const metaEx = dm.metaAccEx(dataMode, 'a'); // v11: seed ACT- + demo-client accounts
  const spendEx = dm.spendEx(dataMode, 's');   // v11: seed ACT- spend + demo-client spend
  const accounts = tx.all(`SELECT a.*, c.name client_name FROM meta_ad_account a LEFT JOIN client c ON c.id=a.client_id ${metaEx ? `WHERE ${metaEx}` : ''}`);
  const accRows = accounts.map((a) => `<tr>
    <td><b>${S.esc(a.name || a.ad_account_id)}</b></td>
    <td class="small muted">${S.esc(a.ad_account_id)}${a.currency ? ` · ${S.esc(a.currency)}` : ''}</td>
    <td><span class="pill ${a.status === 'connected' ? 'g' : 'o'}">${S.esc(a.status)}</span></td>
    <td class="small muted">${S.fmtDT(a.last_pull_at)}</td>
    <td class="small muted">${a.last_error ? S.esc(a.last_error) : 'ok'}</td>
    <td><a class="btn sm sec" href="/meta/pull?acc=${a.id}">Pull now</a></td></tr>`).join('');
  const spend = tx.all(`SELECT s.ad_id, ad.name, s.date, s.spend, s.spend_inr, s.impressions, s.clicks FROM spend_daily s LEFT JOIN meta_ad ad ON ad.id=s.ad_id ${spendEx ? `WHERE ${spendEx}` : ''} ORDER BY s.date DESC LIMIT 40`);
  const spendRows = spend.map((r) => `<tr><td class="small muted">${r.date}</td><td>${S.esc(r.name || r.ad_id)}</td>
    <td>${S.fmtINR(r.spend)}</td><td>${S.fmtINR(r.spend_inr)}</td><td class="small">${S.fmtN(r.impressions)}</td><td class="small">${S.fmtN(r.clicks)}</td></tr>`).join('');
  // live mode: drop CAPI rows that belong to a demo lead (NULL lead = keep).
  const capiDemoEx = dataMode === 'live'
    ? `WHERE NOT (l.id BETWEEN ${dm.SEED.leadIds[0]} AND ${dm.SEED.leadIds[1]} OR l.id IS NULL)` : '';
  const capi = tx.all(`SELECT cl.*, e.lead_id, l.name lead_name FROM capi_log cl LEFT JOIN event e ON e.id=cl.event_row_id LEFT JOIN lead l ON l.id=e.lead_id ${capiDemoEx} ORDER BY cl.id DESC LIMIT 20`);
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
  return S.layout({ title: 'Meta', nav: S.navFor(user), active: 'meta.html', user, body, band: S.layoutDemoBand(dataMode) });
}

// ---------------------------------------------------------------- Integrations
function integrations(db, user, p) {
  const tx = makeTx(db, user); // Phase P: pins this user's RLS scope on Postgres
  const dm = require('./lib/datamode');
  const dataMode = dm.mode(tx);
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
  const clients = user.role === 'client'
    ? tx.all(`SELECT id, name FROM client WHERE id IN (${(user.client_ids || '').split(',').filter(Boolean).map((n) => Number(n)).join(',') || '0'})`)
    : dm.clientOptions(tx, dataMode, null).map((c) => ({ id: c.id, name: c.name }));
  const client1 = clients[0];
  const endpoints = tx.all(`SELECT * FROM webhook_endpoint`);
  const whEx = dm.webhookEx(dataMode, 'w'); // v11: seed + demo-client webhook rows
  const log = tx.all(`SELECT * FROM webhook_log ${whEx ? `WHERE ${whEx}` : ''} ORDER BY id DESC LIMIT 30`);
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
    <div class="row" style="margin-top:10px;gap:8px"><a class="btn sm sec" href="/app/#/webhooks">Webhooks &amp; API Keys →</a>
      <span class="small muted">generate token-in-URL endpoints (FlexiFunnels form + purchase) and xak_ API keys in the app UI</span></div>
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
        // __sweep_test: log-only marker — the button verifies the endpoint without
        // minting a test lead into a shared dev/prod DB (v10).
        body:JSON.stringify({client_id:Number(b.dataset.client),__sweep_test:true})});
      alert('Test event sent: '+r.status+' — refresh log');location.reload();});
  </script>`;
  return S.layout({ title: 'Integrations', nav: S.navFor(user), active: 'integrations.html', user, body, band: S.layoutDemoBand(dataMode) });
}

// ---------------------------------------------------------------- Duplicates
function duplicates(db, user, p) {
  const tx = makeTx(db, user); // Phase P: pins this user's RLS scope on Postgres
  const dm = require('./lib/datamode');
  const dataMode = dm.mode(tx);
  const { likelyDuplicates } = require('./lib/identity');
  // v11: real clients only in live mode (demo clients are hidden everywhere)
  const clients = dm.clientOptions(tx, dataMode, null).map((c) => ({ id: c.id, name: c.name }));
  const cid = p.client || clients[0]?.id;
  const dups = cid ? likelyDuplicates(tx, cid, dataMode === 'live') : [];
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
  <div class="row pagehead" style="justify-content:space-between;align-items:center">
    <h1 style="margin:0">Duplicate review</h1>
    <form method="get" class="inline" action="/duplicates.html"><label>Client</label><select name="client">${clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(cid) ? 'selected' : ''}>${S.esc(c.name)}</option>`).join('')}</select></form>
  </div>
  <div class="card">
    <div class="small muted">Same email, different phone — merge by a human. Same phone for different clients is never merged.</div>
  </div>
  <div class="card"><div class="tabwrap"><table><thead><tr><th>Keep</th><th>Merge into</th><th>Email</th><th>Action</th></tr></thead>
  <tbody>${rows || '<tr><td class="muted">No likely duplicates</td></tr>'}</tbody></table></div></div>`;
  return S.layout({ title: 'Duplicates', nav: S.navFor(user), active: 'duplicates.html', user, body, band: S.layoutDemoBand(dataMode) });
}

// ---------------------------------------------------------------- Admin
function admin(db, user, p) {
  const tx = makeTx(db, user); // Phase P: pins this user's RLS scope on Postgres
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
  // Master v9: current DATA_MODE + whether an admin toggle overrides the env
  const dm = require('./lib/datamode');
  const dmMode = dm.mode(tx);
  const dmOverride = tx.get(`SELECT value FROM settings WHERE key='data_mode'`)?.value || '';
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
      ${['owner', 'admin'].includes(user.role) ? `
      <div class="note" style="margin-top:12px">
        <b>DATA_MODE</b> — which data population the screens show (v9):
        <span class="pill ${dmMode === 'demo' ? 'b' : 'g'}">current: ${S.esc(dmMode)}</span>
        ${dmOverride ? '<span class="badge">set by admin toggle (wins over the DATA_MODE env var)</span>' : '<span class="badge">from DATA_MODE env / default</span>'}
        <div class="row" style="margin-top:8px;gap:8px">
          <form method="post" action="/admin/data-mode"><input type="hidden" name="mode" value="demo"><button class="btn sm ${dmOverride !== 'demo' ? 'sec' : ''}">Demo (seed + real)</button></form>
          <form method="post" action="/admin/data-mode"><input type="hidden" name="mode" value="live"><button class="btn sm ${dmOverride !== 'live' ? 'sec' : ''}">Live (real only)</button></form>
          <form method="post" action="/admin/data-mode"><input type="hidden" name="mode" value="default"><button class="btn sm sec">Use env default</button></form>
        </div>
        <div class="small muted" style="margin-top:6px">Live hides every seed/demo row on all screens (clean empty states); demo shows seed fixtures + real rows together, with the yellow band. Changes are audit-logged.</div>
      </div>` : ''}
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
  return S.layout({ title: 'Admin', nav: S.navFor(user), active: 'admin.html', user, body, band: S.layoutDemoBand(dmMode) });
}

// ---------------------------------------------------------------- Client portal
function portal(db, user, p) {
  const tx = makeTx(db, user); // Phase P: pins this user's RLS scope on Postgres
  const dm = require('./lib/datamode');
  const dataMode = dm.mode(tx);
  const live = dataMode === 'live';
  // client role: only their own client
  const myClients = user.role === 'client' ? (user.client_ids || '').split(',').filter(Boolean) : [];
  const cid = myClients[0];
  let where = user.role === 'client' ? `WHERE l.client_id=${cid}` : 'WHERE 1=1';
  const exLead = dm.leadEx(dataMode, 'l'); // v11: seed + demo-client leads hide in live
  if (exLead) where += ` AND ${exLead}`; // live mode: portal shows real leads only
  const leads = tx.all(`SELECT l.*, c.name client_name FROM lead l LEFT JOIN client c ON c.id=l.client_id ${where} ORDER BY l.id DESC LIMIT 50`);
  const leadsRows = leads.map((r) => `<tr><td><a href="/lead/${r.id}">${S.esc(r.name || '—')}</a></td>
    <td class="small muted">${S.esc(r.client_name || '')}</td><td class="small">${phoneOf(user, r)}</td>
    <td><span class="pill ${stagePillClass(r.stage)}">${S.esc(r.stage)}</span></td></tr>`).join('');

  // R.4: latest auto weekly client summary (generated Monday 9 AM IST by the
  // ticker) — one page here + a PDF download, zero manual.
  let weeklyCard = '';
  if (cid) {
    const ws = S.weeklySummary(tx, {
      attribution_model: tx.get(`SELECT value FROM settings WHERE key='attribution_model'`)?.value || 'last_paid_click',
      attribution_window_days: tx.get(`SELECT value FROM settings WHERE key='attribution_window_days'`)?.value || '30',
    }, [cid], live);
    const hasPdf = !!tx.get(`SELECT 1 FROM settings WHERE key=?`, 'weekly_pdf_client_' + cid)?.value;
    const k = (l, v) => `<div class="kpi"><div class="l">${S.esc(l)}</div><div class="v" style="font-size:16px">${S.esc(v)}</div></div>`;
    weeklyCard = `
  <div class="card"><h2>Weekly client summary <span class="badge">auto · every Monday 9 AM IST</span></h2>
    <div class="grid g4" style="grid-template-columns:repeat(4,1fr)">
      ${k('Leads', ws.funnel.leads)}
      ${k('Attended', ws.funnel.attended)}
      ${k('Paid (net)', ws.funnel.paid)}
      ${k('Revenue (net of refunds)', S.fmtINR(ws.funnel.revenue))}
      ${k('Ad spend', S.fmtINR(ws.total.spend))}
      ${k('ROAS', ws.total.roas != null ? ws.total.roas : '—')}
      ${k('Profit', S.fmtINR(ws.total.profit))}
      ${k('Model', ws.settings.model || '—')}
    </div>
    <div class="small muted">Top ads: ${ws.ad_top.map((r) => S.esc(r.name)).join(', ') || '—'}</div>
    ${hasPdf ? `<div style="margin-top:8px"><a class="btn sm" href="/weekly.pdf${user.role === 'client' ? '' : '?client=' + cid}">Download PDF</a>
      <a class="btn sm sec" href="/export/weekly-summary?client=${cid}&fmt=csv">CSV</a>
      <a class="btn sm sec" href="/export/weekly-summary?client=${cid}&fmt=excel">Excel</a></div>`
      : '<div class="small muted">No PDF generated yet (the Monday 9 AM IST job will create it).</div>'}
  </div>`;
  }

  const body = `
  <h1>Client portal ${user.role === 'client' ? `· ${S.esc(myClients.join(','))}` : ''}</h1>
  <div class="note ${user.role === 'client' ? 'warn' : ''}">${user.role === 'client' ? 'You are in read-only client view. Only your own leads, funnels and reports are visible; export is logged to the audit trail.' : 'Switch to a client role (e.g. arpit@xacqora.local) to preview the client portal.'}</div>
  ${weeklyCard}
  <div class="card"><h2>My leads</h2><div class="tabwrap"><table>
    <thead><tr><th>Name</th><th>Client</th><th>Phone</th><th>Stage</th></tr></thead>
    <tbody>${leadsRows || '<tr><td class="muted">No leads</td></tr>'}</tbody></table></div></div>`;
  return S.layout({ title: 'Portal', nav: S.navFor(user), active: 'dashboard.html', user, body, band: S.layoutDemoBand(dataMode) });
}

// Phase G — pilot gates tooling screen (team-only). Runs the gate assertion
// suite live, the ad URL checker, and the accuracy checkers' log forms.
const P = require('./lib/pilot');
function pilot(db, user, p) {
  const tx = makeTx(db, user);
  const dm = require('./lib/datamode');
  const dataMode = dm.mode(tx);
  // v11: real clients only in live mode — a demo client's dataset is hidden
  // everywhere, so the pilot gate suite must not offer it either.
  const clients = dm.clientOptions(tx, dataMode, null).map((c) => ({ id: c.id, name: c.name }));
  const g = P.runGates(tx);
  const checked = p.url ? P.checkAdUrl(decodeURIComponent(p.url)) : null;
  const timing = P.weeklyTiming(tx);
  // last accuracy-check run (from the audit log) so ?accuracy=1 shows the result
  const lastAcc = tx.get(`SELECT detail FROM audit_log WHERE action='pilot.accuracy' ORDER BY id DESC LIMIT 1`);
  const gateRows = g.gates.map((x) =>
    `<tr><td><span class="pill ${x.pass ? 'g' : 'r'}">${x.pass ? 'PASS' : 'FAIL'}</span></td>
     <td><b>${S.esc(x.id)}</b> ${S.esc(x.name)}</td><td class="small">${S.esc(x.detail)}</td></tr>`).join('');
  const fieldSel = (f) => `<div class="row" style="gap:8px"><label style="width:110px">${S.esc(f)}</label>
    <input name="map.${f}" placeholder="source column (or leave blank)"></div>`;
  const urlResult = checked ? `
    <div class="card" style="margin-top:12px"><h2>URL check · ${S.esc(checked.host || checked.url)}</h2>
      <div class="tabwrap"><table><thead><tr><th>Token / param</th><th>Present</th><th>Note</th></tr></thead><tbody>
      ${checked.findings.map((f) => `<tr><td>${S.esc(f.item)}</td>
        <td><span class="pill ${f.present ? 'g' : (f.severity === 'info' ? 'm' : 'r')}">${f.present ? 'yes' : 'missing'}</span></td>
        <td class="small">${S.esc(f.note)}</td></tr>`).join('')}
      </tbody></table></div>
      ${checked.utm_missing.length ? `<div class="small muted" style="margin-top:8px">Missing UTM params: ${checked.utm_missing.map(S.esc).join(', ')} (recommended for non-Meta channels).</div>` : ''}
    </div>` : '';
  const body = `
  <h1>Pilot gates tooling <span class="badge">Phase G</span></h1>
  <div class="note">Run against the pilot-mock / seeded data on either engine. The gate suite is a live state
    check (read-only); the accuracy checkers are pasted-in comparisons you run each week of the pilot.
    <a href="/import">CSV import of old leads →</a> · <a href="/pilot-live-checklist">live checklist</a></div>

  <div class="card"><h2>Gate assertion suite</h2>
    <div class="tabwrap"><table><thead><tr><th></th><th>Gate</th><th>Detail</th></tr></thead>
    <tbody>${gateRows || '<tr><td class="muted">no gates</td></tr>'}</tbody></table></div>
    <div class="small muted" style="margin-top:8px">All pass: <b>${g.pass ? '✅' : '❌'}</b> — a gate fails when the pilot data violates the threshold.</div>
  </div>

  <div class="card"><h2>Ad URL checker</h2>
    <div class="note">Paste a pilot ad destination URL. We report where <code>{{ad.id}}</code>/<code>{{adset.id}}</code>/<code>{{campaign.id}}</code>/fbclid are missing —
    a missing ad token means leads from that ad land with no ad_id and the G1 gate will fail for them.</div>
    <form method="get" action="/pilot">
      <label>Destination URL</label>
      <input type="text" name="url" style="width:100%" placeholder="https://your-landing.com?utm_source=facebook&amp;utm_medium=paid{{adset.id}}={{adset.id}}{{campaign.id}}={{campaign.id}}">
      <button class="btn" type="submit">Check URL</button>
    </form>
  </div>
  ${urlResult}

  <div class="card"><h2>CSV import of old leads (column mapping)</h2>
    <div class="note">Paste an old-leads CSV (with header row) and map the source columns to Xacqora fields.
      Phones normalise to E.164 (+91), existing leads match by phone-then-email (duplicates are skipped, never double-counted),
      and a paid amount backfills a deal + payment_success. Idempotent — re-import the same file any time.</div>
    <form method="post" action="/pilot/import">
      <label>Client</label><select name="client_id">${clients.map((c) => `<option value="${c.id}">${S.esc(c.name)}</option>`).join('')}</select>
      <label style="margin-top:10px">Paste CSV</label>
      <textarea name="csv" rows="4" style="width:100%">Full Name,Mobile,Email,City,Status,Amount,Registered,Attended
John,+919810000001,john@example.com,Mumbai,Paid,4999,1,1</textarea>
      <div class="small muted" style="margin-top:8px">Map each source column (leave blank = unused):</div>
      <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${['name','phone','email','city','stage','amount','registered','attended','paid_at','refund'].map(fieldSel).join('')}
      </div>
      <div style="margin-top:10px"><button class="btn">Import + run import audit</button></div>
    </form>
  </div>

  <div class="card"><h2>Accuracy checkers (pilot month)</h2>
    <div class="note">Run each week: paste the gateway settlement total and the Meta Ads Manager spend export,
      we compare to the system's count and flag any breach of the thresholds.</div>
    <form method="post" action="/pilot/accuracy">
      <div class="grid g4" style="grid-template-columns:repeat(2,1fr)">
        <div><label>Our week revenue vs gateways (₹, external settlement total)</label><input type="number" name="rev_ext" step="0.01" style="width:100%"></div>
        <div><label>Our week spend vs Meta Ads Manager (₹, external total)</label><input type="number" name="spend_ext" step="0.01" style="width:100%"></div>
      </div>
      <div style="margin-top:10px"><button class="btn">Run checkers</button></div>
    </form>
    ${p.accuracy === '1' && lastAcc ? `<div class="note ${lastAcc.detail.includes('FAIL') ? 'warn' : ''}" style="margin-top:10px">Last check: ${S.esc(lastAcc.detail)}</div>` : ''}
    <div style="margin-top:12px"><h2>Weekly report time (before/after log)</h2>
      <form method="post" action="/pilot/timing">
        <div class="row" style="gap:12px">
          <div><label>Before (minutes to produce the weekly report)</label><input type="number" step="0.01" name="before_min" style="width:160px"></div>
          <div><label>After (minutes using the auto summary)</label><input type="number" step="0.01" name="after_min" style="width:160px"></div>
        </div>
        <button class="btn" type="submit">Log timing</button>
      </form>
      <div class="small muted" style="margin-top:8px">${timing.before_min != null
        ? `Last logged: before ${timing.before_min} min → after ${timing.after_min ?? '—'} min${timing.improvement_pct != null ? ` (${timing.improvement_pct}% faster)` : ''}`
        : 'No timing logged yet.'}</div>
    </div>
  </div>
  `;
  return S.layout({ title: 'Pilot gates', nav: S.navFor(user), active: 'pilot', user, body, band: S.layoutDemoBand(dataMode) });
}

// Phase H — production alerts/monitoring screen (team-only). Surfaces the
// five PRD §11 signals from lib/health.js so ops can triage webhook, queue,
// Meta-pull, CAPI, and backup health at a glance.
const HLT = require('./lib/health');
function alerts(db, user, p) {
  const tx = makeTx(db, null); // operational view: system-scoped (no RLS filter)
  const dm = require('./lib/datamode');
  const dataMode = dm.mode(tx);
  const h = HLT.health(tx, db, dataMode);
  const A = h.alerts;
  const on = (b) => `<span class="pill ${b ? 'r' : 'g'}">${b ? 'ALERT' : 'ok'}</span>`;
  const mt = h.db.meta_token || { expired: 0, expiringSoon: 0, tracked: 0, note: '' };
  const tokenAlert = mt.expired > 0 || mt.expiringSoon > 0;
  const rows = [
    ['Webhook failures (24h)', on(A.webhook_failures), h.db.webhook_failures_24h + ' failed delivery(ies)'],
    ['Queue age > 10 min', on(A.queue_age_over_10min), h.db.queue.stale_over_10min + ' stale job(s), ' + h.db.queue.pending + ' pending, oldest due ' + h.db.queue.age_min + 'm ago'],
    ['Meta pull failures', on(A.meta_pull_failures), h.db.meta_pull_failures.length ? h.db.meta_pull_failures.map((m) => m.ad_account + ': ' + m.reason).join('; ') : 'no errors recorded'],
    ['Meta token expiry', on(tokenAlert), S.esc(mt.note)],
    ['CAPI send failures', on(A.capi_send_failures), h.db.capi_stuck_unsent + ' event(s) still unsent (' + h.db.capi_suppressed_refund + ' suppressed for refunds)'],
    ['Backup (daily)', on(!A.backup_not_recorded), h.db.backup.last_date ? 'last ' + h.db.backup.last_date + ' · ' + (h.db.backup.latest_file || '') : 'no daily backup recorded yet'],
  ];
  const m = h.mode;
  const modePills = [
    ['live mode', m.live ? 'ON' : 'OFF', m.live],
    ['CAPI', m.capi === 'live' ? 'live' : 'dry', m.capi === 'live'],
    ['secrets key', m.secret_key_set ? 'set' : 'INSECURE DEV KEY', m.secret_key_set],
    ['Meta business', m.meta_business_verified ? 'verified' : 'not verified', m.meta_business_verified],
  ].map((x) => `<span class="badge ${x[2] ? 'g' : 'm'}">${S.esc(x[0])}: ${S.esc(x[1])}</span>`).join(' ');
  const body = `
  <h1>Monitoring & alerts <span class="badge">Phase H</span></h1>
  <div class="note">Production signal board (PRD §11). Five checks; a red pill means that signal is
    currently breaching. <a href="/health">/health JSON</a> for dashboards. Engine: <b>${S.esc(h.engine)}</b> · ${modePills}</div>

  <div class="card"><h2>Signal checks</h2>
    <div class="tabwrap"><table><thead><tr><th>Signal</th><th></th><th>Detail</th></tr></thead>
    <tbody>${rows.map((r) => `<tr><td>${S.esc(r[0])}</td><td>${r[1]}</td><td class="small">${S.esc(r[2])}</td></tr>`).join('')}</tbody></table></div>
    ${h.db.webhook_failures.length ? `<div style="margin-top:12px"><h2>Recent webhook failures</h2>
      <div class="tabwrap"><table><thead><tr><th>Platform</th><th>Client</th><th>Ref</th><th>Error</th><th>At</th></tr></thead>
      <tbody>${h.db.webhook_failures.map((f) => `<tr><td>${S.esc(f.platform)}</td><td>${S.esc(f.client)}</td>
        <td class="small">${S.esc(f.ref || '—')}</td><td class="small">${S.esc(f.error || '—')}</td><td class="small">${S.esc(f.at || '—')}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
  </div>

  <div class="card"><h2>Prod toggles</h2>
    <div class="note">These gate the live-pilot cutover (see <a href="/pilot-live-checklist">checklist</a>).
      Live mode (webhook signatures + outbound Meta) is controlled by the <code>XACQORA_LIVE</code> env var;
      the Meta business-verification flag is a DB setting toggled here.</div>
    <div class="row" style="gap:10px">
      <form method="post" action="/alerts/meta-verify"><button class="btn sm ${m.meta_business_verified ? 'sec' : ''}">${m.meta_business_verified ? 'Mark Meta business unverified' : 'Mark Meta business verified'}</button></form>
      <form method="post" action="/alerts/capi"><button class="btn sm sec">Flip CAPI to ${m.capi === 'live' ? 'dry-run' : 'live'}</button></form>
    </div>
    ${m.xt_subdomain ? `<div class="small muted" style="margin-top:8px">xt.js served at ${S.esc('https://' + m.xt_subdomain + '/xt.js')} for third-party CSP pages.</div>`
      : `<div class="small muted" style="margin-top:8px">Set <code>XACQORA_XT_SUBDOMAIN</code> (or host xt.js on your own subdomain) so third-party CSP pages can load it.</div>`}
  </div>
  `;
  return S.layout({ title: 'Alerts', nav: S.navFor(user), active: 'alerts.html', user, body, band: S.layoutDemoBand(dataMode) });
}

function notFound(user) {
  return S.layout({ title: 'Not found', nav: S.navFor(user), active: '', user, body: '<div class="card"><h1>Not found</h1><div class="muted">That lead does not exist.</div></div>' });
}

module.exports = {
  dashboard, leads, leadTimeline, pipeline, reports, meta, integrations, duplicates, admin, portal, pilot, alerts,
  stagePillClass, notFound,
};
