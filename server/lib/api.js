// Phase F — JSON API for the new SPA (public/app). One handler object with
// get()/post(): cookie-authenticated (same session tokens as the HTML routes),
// role-aware (phone/email masked per role — same semantics as screens.js),
// and RLS-scoped via makeTx(db, user) so a client login can only ever read
// its own clients' data on either engine. The server-rendered screens remain
// the fallback and render the same data; the SPA renders THIS.
const S = require('./shared');
const sec = require('./security');
const H = require('./health');
const P = require('./pilot');
const { likelyDuplicates, mergeLeads } = require('./identity');
const { audit } = require('./auth');

// roles that may see unmasked contact data (S.roleSeesFullContacts)
function maskContacts(user) {
  const full = S.roleSeesFullContacts(user.role);
  return {
    phone: (v) => (v ? (full ? v : S.maskPhone(v)) : ''),
    email: (v) => (!v ? '—' : (full ? v : S.maskEmail(v))),
    full,
  };
}
function readSettings(tx) {
  return {
    model: tx.get(`SELECT value FROM settings WHERE key='attribution_model'`)?.value || 'last_paid_click',
    window: tx.get(`SELECT value FROM settings WHERE key='attribution_window_days'`)?.value || '30',
    threshold: tx.get(`SELECT value FROM settings WHERE key='wasted_spend_threshold'`)?.value || '0',
    capi: tx.get(`SELECT value FROM settings WHERE key='capi'`)?.value || 'dry',
  };
}
// client scoping mirrors the HTML routes: a client login is locked to its own
// client_ids; team roles may filter with ?client=N (null = all internal).
function scopeOf(user, p, tx) {
  const ids = (user.client_ids || '').split(',').filter(Boolean).map((n) => Number(n));
  if (user.role === 'client') return { ids, filter: user.role === 'client' };
  // v14.1: in LIVE data mode a team role's data is scoped to REAL clients
  // (client.demo<>1) — the seed fixtures (Coach Ravi / Kaya Coach + their
  // leads) stay hidden, matching every other live screen. A ?client= filter
  // must name a real client or it is ignored. In demo mode the team sees all
  // clients (the demo fixtures need them).
  if (tx && DM.mode(tx) === DM.LIVE) {
    const real = DM.realClientIds(tx, DM.LIVE, null);
    const pick = p.client && real.includes(Number(p.client)) ? [Number(p.client)] : real;
    return { ids: pick.length ? pick : null, filter: pick.length ? pick : null };
  }
  return { ids: null, filter: p.client ? [String(p.client)] : null };
}
const CLIENTS_Q = (tx) => tx.all(`SELECT id, name FROM client ORDER BY id`);
// v14.1: client pickers must list REAL clients only in live data mode.
// The seed demo clients ("Coach Ravi — Webinar Funnel", "Kaya Coach — Workshop")
// are marked client.demo=1 (scripts/map-real-clients.js) and their whole
// dataset is hidden in live mode — so their names must not appear in dropdowns
// or webhook generation. In demo mode the list is intentionally all clients
// (the fixtures need them). Client roles get their own (real-data) clients.
const DM = require('./datamode');
function realClients(tx, user) {
  if (user.role === 'client') {
    const ids = (user.client_ids || '').split(',').map((s) => s.trim()).filter(Boolean).map((n) => Number(n));
    return tx.all(`SELECT id, name FROM client WHERE id IN (${ids.join(',') || '0'})`);
  }
  return DM.clientOptions(tx, DM.mode(tx), null).map((c) => ({ id: c.id, name: c.name }));
}
// v14: the platform catalogue shared by the Integrations + Webhooks screens.
const PLATFORMS = [
  ['meta_leadgen', 'Meta Lead Forms', 'Instant Form leads with ad IDs'],
  ['tagmango', 'TagMango', 'Course / workshop purchases'],
  ['razorpay', 'Razorpay', 'Payments'], ['cashfree', 'Cashfree', 'Payments'],
  ['cosmofeed', 'Cosmofeed', 'Purchases'], ['aevent', 'Aevent', 'Webinar registration & attendance'],
  ['zoom', 'Zoom', 'Webinar registration & attendance'], ['calendly', 'Calendly', 'Booked / cancelled calls'],
  ['flexifunnels', 'FlexiFunnels', 'Opt-ins & orders'], ['pabbly', 'Pabbly Connect', 'Anything + WhatsApp flows'],
  ['whatsapp', 'WhatsApp (WATI/Interakt/AiSensy)', 'Messages sent & replies'],
  ['google_sheets', 'Google Sheets / CSV', 'Old leads & sales backfill'],
];

function err(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: msg }));
}
function ok(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function forbid(res, user) {
  if (!user) err(res, 401, 'sign in first');
  else err(res, 403, 'your role does not allow this action');
}

const api = {
  // ---------------------------------------------------------------- GET
  get(u, db, user, res) {
    const parts = u.pathname.split('/').filter(Boolean); // ['api','app', ...]
    const seg = parts.slice(2);
    const p = Object.fromEntries(u.searchParams.entries());
    if (!user) {
      // a few endpoints are public so the SPA shell can render a sign-in gate
      if (seg[0] === 'health') return ok(res, H.health(require('../db').makeTx(db, null), db));
      if (seg[0] === 'me') return ok(res, { user: null, nav: [] });
      return err(res, 401, 'sign in first');
    }
    const tx = require('../db').makeTx(db, user); // Phase P: pins RLS scope
    try {
      switch (seg[0]) {
        case 'me':
          return ok(res, {
            user: { id: user.id, email: user.email, name: user.name, role: user.role,
              client_ids: user.client_ids, clientNames: user.clientNames, totp_enabled: !!user.totp_enabled },
            nav: S.navFor(user),
            seesContacts: S.roleSeesFullContacts(user.role),
            readOnly: user.role === 'client',
            clientRole: user.role === 'client',
            teamOps: ['owner', 'admin', 'media_buyer'].includes(user.role),
            canAdmin: ['owner', 'admin'].includes(user.role),
            // master v7 §1.4/§6: the SPA shows a demo-data band while in mock
            // mode; XACQORA_LIVE=1 makes it vanish with the mock numbers.
            demo: !require('./liveapi').liveMode(),
          });

        case 'dashboard': {
          const { ids } = scopeOf(user, p, tx);
          const set = readSettings(tx);
          const settings = { attribution_model: set.model, attribution_window_days: set.window, wasted_spend_threshold: set.threshold };
          const fp = S.funnelReport(tx, null, settings, ids);
          const ap = S.adPerformance(tx, settings, ids);
          const mix = S.sourceMix(tx, ids);
          const totalLeads = ids
            ? tx.get(`SELECT COUNT(*) c FROM lead WHERE client_id IN (${ids.map((n) => Number(n)).join(',')})`)?.c || 0
            : tx.get(`SELECT COUNT(*) c FROM lead`)?.c || 0;
          // v14: new-leads KPI (today / last 7d) — the dashboard previously had
          // no lead-rate number, only the lifetime total. The threshold uses a
          // SPACE-form midnight string: it is a strict lower bound on BOTH the
          // SQLite default (datetime('now') -> "YYYY-MM-DD HH:MM:SS") and the PG
          // default ("YYYY-MM-DDTHH:MM:SSZ"), so the count is engine-identical.
          const midnight = (ms) => new Date(ms).toISOString().slice(0, 10) + ' 00:00:00';
          const leadCount = (sinceMs) => {
            let w = `WHERE created_at >= ?`; const args = [midnight(sinceMs)];
            if (ids && ids.length) { w += ` AND client_id IN (${ids.map((n) => Number(n)).join(',')})`; }
            return tx.get(`SELECT COUNT(*) c FROM lead ${w}`, ...args)?.c || 0;
          };
          const leadsToday = leadCount(Date.now());
          const leads7d = leadCount(Date.now() - 6 * 86400000);
          const mask = maskContacts(user);
          const recentWhere = ids ? `WHERE l.client_id IN (${ids.map((n) => Number(n)).join(',')})` : '';
          const recentRows = tx.all(`SELECT l.id, l.name, l.phone, l.email, l.stage, l.client_id, l.created_at, c.name client_name
            FROM lead l LEFT JOIN client c ON c.id=l.client_id ${recentWhere} ORDER BY l.id DESC LIMIT 8`);
          // source + form-title for the mini-table: the newest event on each
          // lead carries the webhook's platform + (for FlexiFunnels) the form
          // title / page URL / UTM. A lead with zero events = manual / organic.
          const recent = recentRows.map((r) => {
            const out = { ...r, phone: mask.phone(r.phone), email: mask.email(r.email), source: null, form_title: null, page_url: null, utm_source: null };
            const ev = tx.get(`SELECT type, source_platform, raw_payload FROM event WHERE lead_id=? ORDER BY id DESC LIMIT 1`, r.id);
            if (ev) {
              out.source = ev.source_platform || null;
              try {
                const pp = JSON.parse(ev.raw_payload || '{}');
                const d = pp.data || pp;
                out.form_title = d.form_title || d.form_name || null;
                out.page_url = d.page_url || d.landing_url || null;
                out.utm_source = d.utm_source || null;
              } catch { /* payload not JSON (rare) */ }
            }
            return out;
          });
          return ok(res, {
            settings,
            kpis: {
              totalLeads, showUp: fp.show_up_rate, close: fp.close_rate,
              cpl: fp.cpl, revenue: fp.revenue, spend: fp.spend,
              roas: ap.total.roas, profit: ap.total.profit,
              leadsToday, leads7d,
            },
            funnel: { steps: fp, attributed: fp.attribution.attributed, organic: fp.attribution.organic },
            sourceMix: mix,
            adPerf: ap, // full ad-performance so the dashboard's top-ads card can render
            recent,
            clients: realClients(tx, user),
            spendTrend: spendTrendDays(tx, ids, 14),
          });
        }

        case 'leads': {
          const mask = maskContacts(user);
          const q = (p.q || '').trim();
          const stage = p.stage || '';
          const scopeIds = user.role === 'client' ? (user.client_ids || '').split(',').filter(Boolean) : [];
          const client = user.role === 'client' ? String(scopeIds[0] || '') : (p.client || '');
          let where = `1=1`;
          const args = [];
          if (q) { where += ` AND (l.phone LIKE ? OR l.email LIKE ? OR l.name LIKE ?)`; args.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
          if (stage) { where += ` AND l.stage = ?`; args.push(stage); }
          if (client) { where += ` AND l.client_id = ?`; args.push(client); }
          // v14.1: team views in live mode never list demo-client leads
          if (user.role !== 'client' && DM.mode(tx) === DM.LIVE) {
            const realIds = DM.realClientIds(tx, DM.LIVE, null);
            where += ` AND l.client_id IN (${realIds.join(',') || '0'})`;
          }
          const ids = String(p.ids || '').split(',').map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
          if (ids.length) where += ` AND l.id IN (${ids.join(',')})`;
          const rows = tx.all(`SELECT l.*, c.name client_name,
            (SELECT COUNT(*) FROM event e WHERE e.lead_id=l.id) ev,
            (SELECT COALESCE(SUM(d.amount),0) FROM deal d WHERE d.lead_id=l.id AND d.status='success' AND d.refunded_at IS NULL) paid
          FROM lead l LEFT JOIN client c ON c.id=l.client_id WHERE ${where}
          ORDER BY l.id DESC LIMIT 500`, ...args)
            .map((r) => ({ ...r, phone: mask.phone(r.phone), email: mask.email(r.email) }));
          return ok(res, {
            rows, total: rows.length, ids: ids.length ? ids : null,
            stages: S.DEFAULT_STAGES,
            clients: user.role === 'client'
              ? tx.all(`SELECT id, name FROM client WHERE id IN (${scopeIds.map((n) => Number(n)).join(',') || '0'})`)
              : realClients(tx, user),
          });
        }

        case 'lead': {
          const id = Number(seg[1]);
          const mask = maskContacts(user);
          const lead = tx.get(`SELECT l.*, c.name client_name FROM lead l LEFT JOIN client c ON c.id=l.client_id WHERE l.id=?`, id);
          if (!lead) return err(res, 404, 'lead not found');
          if (!sec.canAccessClient(user, lead.client_id)) return err(res, 404, 'lead not found');
          // v14.1: team roles in live mode cannot open a demo-client lead
          if (user.role !== 'client' && DM.mode(tx) === DM.LIVE && tx.get(`SELECT demo FROM client WHERE id=?`, lead.client_id)?.demo === 1)
            return err(res, 404, 'lead not found');
          const tps = tx.all(`SELECT * FROM touchpoint WHERE lead_id=? ORDER BY ts`, id);
          const events = tx.all(`SELECT * FROM event WHERE lead_id=? ORDER BY ts DESC`, id);
          const deals = tx.all(`SELECT * FROM deal WHERE lead_id=?`, id);
          const notes = tx.all(`SELECT * FROM note WHERE lead_id=? ORDER BY ts DESC`, id);
          const tasks = tx.all(`SELECT * FROM task WHERE lead_id=? ORDER BY ts DESC`, id);
          const calls = tx.all(`SELECT * FROM call_log WHERE lead_id=? ORDER BY ts DESC`, id);
          const adTps = tps.filter((t) => t.ad_id && t.ad_id !== 'unknown');
          const adMeta = (a) => a ? tx.get(`SELECT * FROM meta_ad WHERE id=?`, a.ad_id) || null : null;
          const firstMeta = adMeta(adTps[0]), lastMeta = adMeta(adTps[adTps.length - 1]);
          const totalPaid = deals.filter((d) => d.status === 'success' && !d.refunded_at).reduce((a, b) => a + b.amount, 0);
          // v14: source card for the lead timeline — the ad/form that brought
          // this lead in. FlexiFunnels pages don't run xt.js, so the ad
          // attribution is UTM captured on the form (page_url + utm_* fields).
          const sourceCard = buildSourceCard(tx, id, tps, adTps, adMeta);
          return ok(res, {
            lead: { ...lead, phone: mask.phone(lead.phone), email: mask.email(lead.email) },
            stages: S.DEFAULT_STAGES,
            touchpoints: tps.map((t) => ({ ...t, ad: t.ad_id ? (tx.get(`SELECT name FROM meta_ad WHERE id=?`, t.ad_id)?.name || null) : null })),
            adCards: {
              first: adCard(firstMeta, adTps[0]),
              last: adCard(lastMeta, adTps[adTps.length - 1]),
              clicks: adTps.length,
            },
            sourceCard,
            events, deals, notes, tasks, calls, totalPaid,
            readOnly: user.role === 'client',
          });
        }

        case 'pipeline': {
          const mask = maskContacts(user);
          let client = p.client || '';
          if (user.role === 'client') client = String((user.client_ids || '').split(',')[0] || '');
          let where = client ? `AND l.client_id=?` : '';
          let args = client ? [client] : [];
          // v14.1: team views in live mode never board demo-client leads
          if (user.role !== 'client' && DM.mode(tx) === DM.LIVE) {
            const realIds = DM.realClientIds(tx, DM.LIVE, null);
            where += ` AND l.client_id IN (${realIds.join(',') || '0'})`;
          }
          const stages = S.DEFAULT_STAGES;
          const columns = stages.map((s) => {
            const rows = tx.all(`SELECT l.*, c.name client_name FROM lead l LEFT JOIN client c ON c.id=l.client_id WHERE l.stage=? ${where} ORDER BY l.id DESC LIMIT 40`, s, ...args);
            return { stage: s, count: rows.length, cards: rows.map((r) => ({ id: r.id, name: r.name || '—', client: r.client_name || '', phone: mask.phone(r.phone) })) };
          });
          return ok(res, {
            columns, client,
            clients: user.role === 'client'
              ? tx.all(`SELECT id, name FROM client WHERE id IN (${(user.client_ids || '').split(',').filter(Boolean).map((n) => Number(n)).join(',') || '0'})`)
              : realClients(tx, user),
            readOnly: user.role === 'client',
          });
        }

        case 'reports': {
          const set = readSettings(tx);
          const settings = {
            attribution_model: p.model || set.model,
            attribution_window_days: p.window || set.window,
            wasted_spend_threshold: set.threshold,
            report_from: p.from || null, report_to: p.to || null,
          };
          // v14.1: a ?client= filter must name a REAL client in live mode,
          // otherwise the report would mix demo data in behind a "real" filter.
          const clientFilter = String(p.client || '');
          // v14.1: in LIVE mode a team report with no filter scopes to the REAL
          // clients (demo clients' spend stays out of the report); a ?client=
          // filter must name a real client or it is ignored. Demo mode is
          // unchanged (null = every client).
          const isLive = user.role !== 'client' && DM.mode(tx) === DM.LIVE;
          const realIds = isLive ? DM.realClientIds(tx, DM.LIVE, null) : null;
          const filterOk = user.role === 'client' || !clientFilter || (realIds && realIds.length && realIds.includes(Number(clientFilter)));
          let scopeIds;
          if (user.role === 'client') scopeIds = (user.client_ids || '').split(',').filter(Boolean);
          else if (filterOk && clientFilter) scopeIds = [clientFilter];
          else if (isLive && realIds) scopeIds = realIds.length ? realIds : null;
          else scopeIds = null;
          const ap = S.adPerformance(tx, settings, scopeIds);
          const fp = S.funnelReport(tx, null, settings, scopeIds);
          const waste = S.wastedSpend(ap);
          const mix = S.sourceMix(tx, scopeIds);
          const mvt = S.metaVsTracker(tx, settings, scopeIds);
          return ok(res, {
            settings, modelNames: { last_paid_click: 'Last paid click (default)', first_click: 'First click', linear: 'Linear', lead_source: 'Lead source' },
            models: ['last_paid_click', 'first_click', 'linear', 'lead_source'],
            funnel: fp, adPerf: ap, wasted: waste, sourceMix: mix, metaVsTrack: mvt,
            clients: user.role === 'client' ? [] : realClients(tx, user),
            clientFilter: user.role === 'client' ? null : (filterOk ? clientFilter : ''),
            scopeLabel: user.role === 'client' ? 'your client' : (clientFilter ? 'selected client' : 'all clients'),
          });
        }

        case 'meta': {
          if (!['owner', 'admin', 'media_buyer'].includes(user.role)) return forbid(res, user);
          // v14.1: live mode hides demo-client ad accounts (same rule as the
          // classic Meta screen; demo mode shows the fixtures).
          const dm = require('./datamode');
          const live = dm.mode(tx) === dm.LIVE;
          const demoAcct = live ? `NOT EXISTS (SELECT 1 FROM client c WHERE c.id=a.client_id AND c.demo=1)` : '1=1';
          const accounts = tx.all(`SELECT a.*, c.name client_name FROM meta_ad_account a LEFT JOIN client c ON c.id=a.client_id WHERE ${demoAcct}`)
            .map((a) => ({ ...a, token: undefined })); // never send the token out
          const spend = tx.all(`SELECT s.ad_id, ad.name, s.date, s.spend, s.spend_inr, s.impressions, s.clicks FROM spend_daily s LEFT JOIN meta_ad ad ON ad.id=s.ad_id ${live ? "WHERE NOT EXISTS (SELECT 1 FROM meta_ad_account ma WHERE ma.ad_account_id=s.ad_account_id AND EXISTS (SELECT 1 FROM client c WHERE c.id=ma.client_id AND c.demo=1))" : ''} ORDER BY s.date DESC LIMIT 40`);
          const capi = tx.all(`SELECT cl.*, l.name lead_name FROM capi_log cl LEFT JOIN event e ON e.id=cl.event_row_id LEFT JOIN lead l ON l.id=e.lead_id ${live ? 'WHERE (l.client_id IS NULL OR l.client_id IN (SELECT id FROM client WHERE (demo IS NULL OR demo=0)))' : ''} ORDER BY cl.id DESC LIMIT 20`);
          return ok(res, { accounts, spend, capi });
        }

        case 'integrations': {
          if (!['owner', 'admin', 'media_buyer'].includes(user.role)) return forbid(res, user);
          // v14.1: real clients only in live mode; demo-mode shows the fixtures.
          const clients = realClients(tx, user);
          const cid = p.client || (clients[0] ? clients[0].id : '');
          const endpoints = tx.all(`SELECT * FROM webhook_endpoint WHERE client_id=?`, String(cid))
            .map((e) => ({ ...e, secret: String(e.secret || '').slice(0, 4) + '•••' }));
          const log = webhookLogRecent(tx, 30).map((r) => ({ ...r, raw: r.raw ? String(r.raw).slice(0, 200) : '' }));
          return ok(res, { platforms: PLATFORMS, clients, cid: String(cid), endpoints, log });
        }

        case 'webhooks': {
          // v14: Webhooks & API Keys screen (team-only). Two sections:
          // inbound token-URL endpoints + the app's bearer API keys.
          if (!['owner', 'admin', 'media_buyer'].includes(user.role)) return forbid(res, user);
          const W = require('./webhooks');
          // v14.1: live mode scopes endpoints to REAL clients (the demo
          // "Coach Ravi / Kaya Coach" endpoint rows stay hidden); demo mode
          // still shows everything (the fixtures need them).
          const { ids } = scopeOf(user, p, tx);
          const endpoints = W.listEndpoints(tx, ids);
          const apikeys = W.listApiKeys(tx, null).map((k) => ({
            ...k,
            scope_name: k.scope_client_id ? (tx.get(`SELECT name FROM client WHERE id=?`, Number(k.scope_client_id))?.name || 'client ' + k.scope_client_id) : 'workspace (all clients)',
          }));
          // recent inbound log (last 30, demo-client rows hidden in live mode)
          const log = webhookLogRecent(tx, 30)
            .map((r) => ({ ...r, raw: r.raw ? String(r.raw).slice(0, 200) : '' }));
          // public base for generated URLs: APP_URL / XACQORA_PUBLIC_URL when set
          // (production Vercel domain); otherwise the host the request came from
          // (localhost in dev — the screen shows a notice that localhost URLs
          // are not reachable by FlexiFunnels and a prod domain is required).
          const base = process.env.APP_URL || process.env.XACQORA_PUBLIC_URL || u.origin;
          // saved FlexiFunnels field-mappings per client (for the editor's reload)
          const fmRows = tx.all(`SELECT client_id, platform, mapping FROM field_map WHERE platform IN ('flexifunnels','razorpay','cashfree')`);
          const fieldMaps = {};
          for (const r of fmRows) { try { fieldMaps[r.client_id] = JSON.parse(r.mapping || '{}'); } catch {} }
          return ok(res, {
            endpoints, apikeys, log,
            clients: realClients(tx, user),
            base,
            baseIsProd: !!(process.env.APP_URL || process.env.XACQORA_PUBLIC_URL),
            platforms: PLATFORMS,
            fieldMaps,
          });
        }

        case 'duplicates': {
          if (!['owner', 'admin'].includes(user.role)) return forbid(res, user);
          const clients = CLIENTS_Q(tx);
          // default to the first client that actually HAS a likely-duplicate
          // pair, so the screen opens populated (demo) rather than empty.
          let cid = p.client || '';
          if (!cid) {
            const withPairs = clients.find((c) => likelyDuplicates(tx, c.id).length);
            cid = withPairs ? withPairs.id : (clients[0] ? clients[0].id : '');
          }
          const mask = maskContacts(user);
          const dups = cid ? likelyDuplicates(tx, cid).map((d) => ({
            a: { id: d.a.id, name: d.a.name || '—', phone: mask.phone(d.a.phone) },
            b: { id: d.b.id, name: d.b.name || '—', phone: mask.phone(d.b.phone) },
            email: mask.email(d.email),
          })) : [];
          return ok(res, { clients, cid: String(cid), pairs: dups });
        }

        case 'admin': {
          if (!['owner', 'admin'].includes(user.role)) return forbid(res, user);
          const users = tx.all(`SELECT id, email, name, role, client_ids, totp_enabled FROM user`);
          const auditRows = tx.all(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 30`);
          return ok(res, { users, audit: auditRows, settings: readSettings(tx), me: { totp_enabled: !!user.totp_enabled } });
        }

        case 'portal': {
          const mask = maskContacts(user);
          const myClients = user.role === 'client' ? (user.client_ids || '').split(',').filter(Boolean) : [];
          const cid = myClients[0] || p.client || '';
          const where = user.role === 'client' ? `WHERE l.client_id=${cid}` : (cid ? `WHERE l.client_id=${cid}` : 'WHERE 1=1');
          const leads = tx.all(`SELECT l.*, c.name client_name FROM lead l LEFT JOIN client c ON c.id=l.client_id ${where} ORDER BY l.id DESC LIMIT 50`)
            .map((r) => ({ ...r, phone: mask.phone(r.phone), email: mask.email(r.email) }));
          let weekly = null, hasPdf = false;
          if (cid) {
            const set = readSettings(tx);
            weekly = S.weeklySummary(tx, { attribution_model: set.model, attribution_window_days: set.window }, [cid]);
            hasPdf = !!tx.get(`SELECT 1 FROM settings WHERE key=?`, 'weekly_pdf_client_' + cid)?.value;
          }
          return ok(res, { cid: String(cid), clients: realClients(tx, user), leads, weekly, hasPdf, readOnly: user.role === 'client' });
        }

        case 'pilot': {
          if (!['owner', 'admin', 'media_buyer'].includes(user.role)) return forbid(res, user);
          const g = P.runGates(tx);
          const timing = P.weeklyTiming(tx);
          const lastAcc = tx.get(`SELECT detail FROM audit_log WHERE action='pilot.accuracy' ORDER BY id DESC LIMIT 1`);
          // optional ad-URL check (the server-side token auditor)
          const urlCheck = p.url ? P.checkAdUrl(decodeURIComponent(String(p.url))) : null;
          return ok(res, {
            gates: g, allPass: g.pass, timing,
            lastAccuracy: lastAcc ? lastAcc.detail : null,
            clients: realClients(tx, user), urlCheck,
          });
        }

        case 'alerts': {
          if (!['owner', 'admin', 'media_buyer'].includes(user.role)) return forbid(res, user);
          return ok(res, H.health(require('../db').makeTx(db, null), db));
        }

        default:
          return err(res, 404, 'unknown endpoint: ' + u.pathname);
      }
    } catch (e) {
      console.error('[api]', e);
      return err(res, 500, e.message || 'internal error');
    }
  },

  // ---------------------------------------------------------------- POST
  post(u, body, db, user, res, req) {
    const parts = u.pathname.split('/').filter(Boolean);
    const seg = parts.slice(2);
    body = body || {};
    if (!user) return err(res, 401, 'sign in first');
    const tx = require('../db').makeTx(db, user);
    try {
      switch (seg[0]) {
        case 'lead': {
          const id = Number(seg[1]);
          if (user.role === 'client') return err(res, 403, 'client portal is read-only');
          const lead = tx.get(`SELECT * FROM lead WHERE id=?`, id);
          if (!lead) return err(res, 404, 'lead not found');
          tx.run(`UPDATE lead SET stage=?, owner=? WHERE id=?`, body.stage || lead.stage, body.owner || lead.owner, id);
          audit(db, user, 'lead.update', 'lead', String(id), `stage=${body.stage || lead.stage} owner=${body.owner || lead.owner}`);
          return ok(res, { ok: true, id });
        }

        case 'pipeline': {
          // drag-drop stage move (same write as lead update; client role 403)
          const id = Number(body.id);
          const stage = String(body.stage || '');
          if (user.role === 'client') return err(res, 403, 'client portal is read-only');
          if (!S.DEFAULT_STAGES.includes(stage)) return err(res, 400, 'unknown stage: ' + stage);
          const lead = tx.get(`SELECT * FROM lead WHERE id=?`, id);
          if (!lead) return err(res, 404, 'lead not found');
          if (!sec.canAccessClient(user, lead.client_id)) return err(res, 403, 'not your client');
          if (lead.stage !== stage) {
            tx.run(`INSERT INTO event (lead_id, type, source_platform, raw_payload, ts) VALUES (?,?,?,?,?)`,
              id, 'stage_changed', 'kanban', JSON.stringify({ from: lead.stage, to: stage }), new Date().toISOString());
          }
          tx.run(`UPDATE lead SET stage=? WHERE id=?`, stage, id);
          audit(db, user, 'lead.stage_move', 'lead', String(id), `${lead.stage} -> ${stage}`);
          return ok(res, { ok: true, id, from: lead.stage, to: stage });
        }

        case 'duplicates': {
          if (seg[1] !== 'merge') return err(res, 404, 'unknown endpoint');
          if (!['owner', 'admin'].includes(user.role)) return forbid(res, user);
          const keep = Number(body.keep), drop = Number(body.drop);
          if (!keep || !drop || keep === drop) return err(res, 400, 'keep/drop required');
          mergeLeads(tx, keep, drop, body.phone);
          audit(db, user, 'lead.merge', 'lead', String(keep), `merged ${drop}`);
          return ok(res, { ok: true, keep, drop });
        }

        case 'admin': {
          if (!['owner', 'admin'].includes(user.role)) return forbid(res, user);
          if (seg[1] === 'settings') {
            for (const k of ['model', 'window', 'threshold', 'capi']) {
              const key = { model: 'attribution_model', window: 'attribution_window_days', threshold: 'wasted_spend_threshold', capi: 'capi' }[k];
              if (body[key] != null)
                tx.run(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, String(body[key]));
            }
            audit(db, user, 'settings.update', 'settings');
            return ok(res, { ok: true });
          }
          if (seg[1] === 'prune') {
            const lid = Number(body.lead_id);
            if (!lid) return err(res, 400, 'lead_id required');
            tx.run(`UPDATE event SET sent_to_meta=2 WHERE lead_id=?`, lid);
            for (const t of tx.all(`SELECT id FROM touchpoint WHERE lead_id=?`, lid)) tx.run(`DELETE FROM touchpoint WHERE id=?`, t.id);
            for (const e of tx.all(`SELECT id FROM event WHERE lead_id=?`, lid)) tx.run(`DELETE FROM event WHERE id=?`, e.id);
            for (const d of tx.all(`SELECT id FROM deal WHERE lead_id=?`, lid)) tx.run(`DELETE FROM deal WHERE id=?`, d.id);
            for (const i of tx.all(`SELECT link_key FROM lead_identity WHERE lead_id=?`, lid)) tx.run(`DELETE FROM lead_identity WHERE link_key=?`, i.link_key);
            tx.run(`DELETE FROM lead WHERE id=?`, lid);
            audit(db, user, 'lead.delete', 'lead', String(lid), 'privacy deletion; CAPI suppressed');
            return ok(res, { ok: true });
          }
          if (seg[1] === '2fa') {
            if (!['owner', 'admin'].includes(user.role)) return forbid(res, user);
            const me = db.prepare(`SELECT * FROM user WHERE id=?`).get(user.id);
            if (body.action === 'enroll') {
              const secretPlain = sec.totpSecret();
              db.prepare(`UPDATE user SET totp_secret=?, totp_enabled=1 WHERE id=?`).run(sec.encryptSecret(secretPlain), me.id);
              audit(db, user, 'auth.2fa_enroll', 'user', String(me.id));
              // reveal the secret once, on-screen only (not via URL) — mirrors the HTML admin
              return ok(res, { ok: true, secret: secretPlain, uri: sec.otpauthUri('XacqoraTrack', me.email, secretPlain) });
            }
            if (body.action === 'disable') {
              db.prepare(`UPDATE user SET totp_enabled=0 WHERE id=?`).run(me.id);
              audit(db, user, 'auth.2fa_disable', 'user', String(me.id));
            }
            return ok(res, { ok: true });
          }
          return err(res, 404, 'unknown endpoint');
        }

        case 'meta': {
          if (seg[1] !== 'pull') return err(res, 404, 'unknown endpoint');
          if (!['owner', 'admin', 'media_buyer'].includes(user.role)) return forbid(res, user);
          const { enqueue } = require('./queue');
          const id = Number(u.searchParams.get('acc')) || 1;
          const acc = tx.get(`SELECT * FROM meta_ad_account WHERE id=?`, id);
          if (!acc) return err(res, 404, 'account not found');
          enqueue(db, 'meta_pull', { ad_account_id: acc.ad_account_id });
          audit(db, user, 'meta.pull', 'ad_account', String(acc.id), acc.ad_account_id);
          return ok(res, { ok: true, enqueued: acc.ad_account_id });
        }

        case 'integrations': {
          if (seg[1] !== 'test') return err(res, 404, 'unknown endpoint');
          if (!['owner', 'admin', 'media_buyer'].includes(user.role)) return forbid(res, user);
          // send a fake test event through the public ingest path (same as the
          // HTML screen's test button) — it lands in the webhook log.
          const platform = String(body.platform || '');
          const client_id = Number(body.client_id || 1);
          const { enqueue } = require('./queue');
          const tx2 = require('../db').makeTx(db, null); // system scope: webhooks cross clients
          const mapRow = tx2.get(`SELECT mapping FROM field_map WHERE client_id=? AND platform=?`, client_id, platform);
          enqueue(db, 'webhook', { platform, client_id, payload: { __test: true, test: true, name: 'Test lead', phone: '+9199990' + (100 + client_id), email: 'test+' + platform + '@xacqora.local' }, map: mapRow ? JSON.parse(mapRow.mapping || '{}') : {}, dedup_key: 'test|' + platform + '|' + client_id, test: true });
          tx2.run(`INSERT INTO webhook_log (client_id, platform, ref, status, raw, test, ingested_at) VALUES (?,?,?,?,1,?,?)`,
            client_id, platform, 'test-' + Date.now(), 'test', JSON.stringify({ test: true }), new Date().toISOString());
          audit(db, user, 'integration.test', platform, String(client_id));
          return ok(res, { ok: true, queued: true });
        }

        case 'pilot': {
          if (!['owner', 'admin', 'media_buyer'].includes(user.role)) return forbid(res, user);
          if (seg[1] === 'accuracy') {
            const rev = Number(body.rev_ext || 0);
            const sp = Number(body.spend_ext || 0);
            const tx2 = require('../db').makeTx(db, user);
            const results = {
              revenue: rev ? P.revenueVsGateways(tx2, { externalTotal: rev }) : null,
              spend: sp ? P.spendVsMeta(tx2, { externalTotal: sp }) : null,
              capi: P.capiQuality(tx2),
            };
            audit(db, user, 'pilot.accuracy', 'report',
              `revenue ${results.revenue ? (results.revenue.pass ? 'PASS ' : 'FAIL ') + results.revenue.diff_pct + '% diff' : '—'}, ` +
              `spend ${results.spend ? (results.spend.pass ? 'PASS ' : 'FAIL ') + results.spend.diff_pct + '% diff' : '—'}, ` +
              `CAPI MQ ${results.capi.avg_mq} (${results.capi.pct_good}% ≥7)`);
            return ok(res, { ok: true, results });
          }
          if (seg[1] === 'timing') {
            P.weeklyTiming(tx, { beforeMin: body.before_min != null ? Number(body.before_min) : null, afterMin: body.after_min != null ? Number(body.after_min) : null });
            audit(db, user, 'pilot.weekly_timing', 'report', `before ${body.before_min ?? '—'} min, after ${body.after_min ?? '—'} min`);
            return ok(res, { ok: true });
          }
          return err(res, 404, 'unknown endpoint');
        }

        case 'webhooks': {
          // v14: create / pause / revoke / delete inbound endpoints + API keys.
          if (!['owner', 'admin', 'media_buyer'].includes(user.role)) return forbid(res, user);
          const W = require('./webhooks');
          const tx2 = require('../db').makeTx(db, user); // RLS-scoped (team = all clients)
          const base = process.env.APP_URL || process.env.XACQORA_PUBLIC_URL || u.origin;
          if (seg[1] === 'endpoint') {
            const cid = Number(body.client_id);
            const platform = String(body.platform || '');
            if (!cid || !platform) return err(res, 400, 'client_id + platform required');
            const row = W.createEndpoint(tx2, { client_id: cid, platform, description: body.description, events: body.events, base });
            audit(db, user, 'webhook.create_endpoint', 'webhook_endpoint', String(row.id), `${platform} · ${row.description || ''}`);
            // return the ONE-TIME url + token (the UI shows it with a copy box,
            // then the user pastes it into FlexiFunnels / the gateway).
            return ok(res, { ok: true, created: { ...row, url: row.url, token: row.token, secret: row.secretPlain } });
          }
          if (seg[1] === 'status') {
            const id = Number(body.id); const status = String(body.status || 'active');
            const r = W.setStatus(tx2, id, status, user);
            if (!r) return err(res, 404, 'endpoint not found');
            audit(db, user, 'webhook.endpoint_status', 'webhook_endpoint', String(id), status);
            return ok(res, { ok: true, id, status: r.status });
          }
          if (seg[1] === 'delete') {
            W.deleteEndpoint(tx2, Number(body.id));
            audit(db, user, 'webhook.delete_endpoint', 'webhook_endpoint', String(body.id));
            return ok(res, { ok: true });
          }
          if (seg[1] === 'key') {
            const perm = body.permission === 'read_write' ? 'read_write' : 'read_only';
            const k = W.createApiKey(tx2, { scope_client_id: body.scope_client_id || null, label: body.label, permission: perm, createdBy: user.email });
            audit(db, user, 'apikey.create', 'api_keys', String(k.id), `${k.permission} · ${k.label}`);
            // key = ONE-TIME plaintext (the UI shows it in a copy-once box)
            return ok(res, { ok: true, created: { ...W.keyView(k), key: k.key } });
          }
          if (seg[1] === 'key_revoke') {
            W.revokeApiKey(tx2, Number(body.id), user);
            audit(db, user, 'apikey.revoke', 'api_keys', String(body.id));
            return ok(res, { ok: true });
          }
          if (seg[1] === 'key_delete') {
            W.deleteApiKey(tx2, Number(body.id));
            audit(db, user, 'apikey.delete', 'api_keys', String(body.id));
            return ok(res, { ok: true });
          }
          if (seg[1] === 'fieldmap') {
            // save per-client, per-platform FlexiFunnels field mapping (JSON)
            const cid = Number(body.client_id); const platform = String(body.platform || 'flexifunnels');
            const mapping = body.mapping || {};
            const existing = tx2.get(`SELECT mapping FROM field_map WHERE client_id=? AND platform=?`, cid, platform);
            const mapJson = JSON.stringify(mapping);
            if (existing) tx2.run(`UPDATE field_map SET mapping=? WHERE client_id=? AND platform=?`, mapJson, cid, platform);
            else tx2.run(`INSERT INTO field_map (client_id, platform, mapping) VALUES (?,?,?)`, cid, platform, mapJson);
            audit(db, user, 'fieldmap.save', 'field_map', cid + ':' + platform, Object.keys(mapping).length + ' fields');
            return ok(res, { ok: true });
          }
          if (seg[1] === 'flexi_test') {
            // POST a sample FlexiFunnels form payload through the public ingest
            // path so the screen can prove a lead lands (the "test event" row).
            const cid = Number(body.client_id || 1);
            const sample = {
              data: {
                form_title: 'Webinar opt-in', phone: '+919999' + String(100 + cid).slice(-4),
                email: 'flexitest' + cid + '@xacqora.local', name: 'Flexi Test Lead',
                page_url: 'https://funnels.example.com/webinar?utm_source=facebook&utm_medium=paid&utm_campaign=webinar',
                utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'webinar',
              },
            };
            const mapRow = tx2.get(`SELECT mapping FROM field_map WHERE client_id=? AND platform='flexifunnels'`, cid);
            const { enqueue } = require('./queue');
            enqueue(db, 'webhook', {
              platform: 'flexifunnels', client_id: cid, payload: sample,
              map: mapRow ? JSON.parse(mapRow.mapping || '{}') : {}, test: true,
              dedup_key: 'test|flexifunnels|' + cid,
            });
            tx2.run(`INSERT INTO webhook_log (client_id, platform, ref, status, raw, test, ingested_at) VALUES (?,?,?,?,1,?,?)`,
              cid, 'flexifunnels', 'flexi-test-' + Date.now(), 'test', JSON.stringify(sample), new Date().toISOString());
            audit(db, user, 'flexifunnels.test', 'webhook_log', String(cid));
            return ok(res, { ok: true, queued: true });
          }
          return err(res, 404, 'unknown endpoint');
        }

        case 'alerts': {
          if (!['owner', 'admin', 'media_buyer'].includes(user.role)) return forbid(res, user);
          if (seg[1] === 'meta-verify') {
            const cur = tx.get(`SELECT value FROM settings WHERE key='meta_business_verified'`)?.value;
            const on = cur !== '1';
            tx.run(`INSERT INTO settings (key,value) VALUES ('meta_business_verified',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, on ? '1' : '0');
            audit(db, user, 'alerts.meta_business_verify', 'settings', on ? 'verified' : 'unverified');
            return ok(res, { ok: true, verified: on });
          }
          if (seg[1] === 'capi') {
            const cur = tx.get(`SELECT value FROM settings WHERE key='capi'`)?.value || 'dry';
            const next = cur === 'live' ? 'dry' : 'live';
            tx.run(`INSERT INTO settings (key,value) VALUES ('capi',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, next);
            audit(db, user, 'alerts.capi_toggle', 'settings', `capi -> ${next}`);
            return ok(res, { ok: true, capi: next });
          }
          return err(res, 404, 'unknown endpoint');
        }

        default:
          return err(res, 404, 'unknown endpoint: ' + u.pathname);
      }
    } catch (e) {
      console.error('[api:post]', e);
      return err(res, 500, e.message || 'internal error');
    }
  },
};

// ---------------------------------------------------------------- helpers
// 14-day daily spend series for the dashboard chart (aggregated across the
// scoped clients' ad accounts; all-accounts when team).
function spendTrendDays(tx, ids, days) {
  const where = ids && ids.length
    ? `WHERE s.ad_id IN (SELECT a.id FROM meta_ad a JOIN meta_adset as_ ON as_.id=a.adset_id WHERE as_.ad_account_id IN (SELECT ad_account_id FROM meta_ad_account WHERE client_id IN (${ids.map((n) => Number(n)).join(',')})))`
    : '';
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  // v14.1: the table needed the `s` alias the moment `ids` is non-empty (live
  // team scope) — before, team ids were always null so `s.ad_id` never ran.
  const rows = tx.all(`SELECT date, COALESCE(SUM(spend_inr),0) spend, COALESCE(SUM(clicks),0) clicks,
      COALESCE(SUM(impressions),0) impressions FROM spend_daily s ${where}
      ${where ? 'AND' : 'WHERE'} date >= ?
    GROUP BY date ORDER BY date`, since);
  // fill missing days so the chart x-axis is continuous
  const byDate = {}; for (const r of rows) byDate[r.date] = r;
  const out = [];
  for (let d = days - 1; d >= 0; d--) {
    const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const r = byDate[date] || { spend: 0, clicks: 0, impressions: 0 };
    out.push({ date, spend: Math.round(r.spend), clicks: r.clicks, impressions: r.impressions });
  }
  return out;
}
function adCard(meta, tp) {
  if (!meta) return null;
  return { name: meta.name, status: meta.status, creative: meta.creative_img || '', campaign: tp ? (tp.utm_campaign || '') : '' };
}
// v14.1: recent webhook_log rows, hiding demo-client rows in live mode
// (the seed test events for "Coach Ravi / Kaya Coach" stay out of the log).
function webhookLogRecent(tx, limit) {
  const live = DM.mode(tx) === DM.LIVE;
  const where = live
    ? `WHERE (client_id IS NULL OR client_id IN (SELECT id FROM client WHERE demo IS NULL OR demo=0))`
    : '';
  return tx.all(`SELECT * FROM webhook_log ${where} ORDER BY id DESC LIMIT ?`, limit);
}

// v14: build the lead's "source card" — where the lead came from.
//   1. ad-driven (xt.js touchpoint with an ad_id) -> the Meta ad creative
//   2. UTM-driven (FlexiFunnels form captured utm_* / page_url) -> the ad
//      link that the form carried (ad attribution without xt.js)
//   3. nothing -> organic / unknown
function buildSourceCard(tx, leadId, tps, adTps, adMeta) {
  // (1) real ad-click touchpoint
  if (adTps && adTps.length) {
    const meta = adMeta(adTps[0]);
    if (meta) {
      return { kind: 'ad', ad: meta, utm_source: adTps[0].utm_source, utm_medium: adTps[0].utm_medium, utm_campaign: adTps[0].utm_campaign, ts: adTps[0].ts };
    }
  }
  // (2) UTM from a webhook-captured touchpoint (FlexiFunnels / Pabbly forms
  //     carry utm_* hidden fields even without the pixel)
  const utmTp = (tps || []).filter((t) => t.utm_campaign || t.utm_source || t.landing_url).slice(-1)[0];
  if (utmTp) {
    return { kind: 'utm', utm_source: utmTp.utm_source, utm_medium: utmTp.utm_medium, utm_campaign: utmTp.utm_campaign, landing_url: utmTp.landing_url, ts: utmTp.ts };
  }
  return { kind: 'organic' };
}

module.exports = { api, maskContacts, spendTrendDays, adCard };
module.exports.default = api;
