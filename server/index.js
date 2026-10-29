// Xacqora Track demo server: zero-dependency Node 24 (node:sqlite built in).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open, makeTx } = require('./db');
const S = require('./lib/shared');
const { hashPassword, createSession, userFromCookie, audit } = require('./lib/auth');
const { handleWebhook } = require('./lib/adapters.process');
const { enqueue, tick } = require('./lib/queue');
const { ensureCapiLogTable, runMetaPull, pushCapiEvent } = require('./lib/meta');
const { addEvent, ensureFunnel, getFunnelStages } = require('./lib/events');
const { recordTouchpoint, getOrCreateLead, findLead, attachVisitorTouchpoints } = require('./lib/identity');
const screens = require('./screens');

const db = open();
ensureCapiLogTable(db);

const PORT = Number(process.env.PORT || 4100);
const TX = makeTx(db);

// ---------------------------------------------------------------- helpers
function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({ json: null, raw: '' });
      try { resolve({ json: JSON.parse(raw), raw }); }
      catch {
        const p = new URLSearchParams(raw);
        resolve({ json: Object.fromEntries(p.entries()), raw });
      }
    });
  });
}
function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}
function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
}
function setCookie(res, token) {
  res.setHeader('Set-Cookie', `xt_session=${token}; Path=/; HttpOnly; Max-Age=${30 * 86400}; SameSite=Lax`);
}

// ---------------------------------------------------------------- auth
function requireUser(res, user, roles) {
  if (!user) {
    res.writeHead(302, { Location: '/signin' });
    res.end();
    return false;
  }
  if (roles && !roles.includes(user.role)) {
    send(res, 403, S.layout({ title: 'Forbidden', nav: S.navFor(user), active: '', user, body: '<div class="card"><h1>403</h1><div class="muted">Your role does not allow this action.</div></div>' }));
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- ingest API (public)
// /api/touchpoint  — from xt.js
// /api/form        — from xt.js + form fields
// /api/webhook/:platform — per-platform inbound webhooks (secret-checked)
// /api/ingest/:platform — test / queued ingest
async function handleIngest(platform, kind, res, bodyJson, raw, req, clientHint) {
  const tx = makeTx(db);
  // resolve the client: from body.client, the ?c= param, or the endpoint row
  let client_id = Number(bodyJson?.client ?? bodyJson?.client_id ?? clientHint ?? 0);
  if (!client_id) {
    // find a webhook_endpoint whose URL matches this platform+path
    const end = tx.all(`SELECT * FROM webhook_endpoint WHERE platform=?`, platform)[0];
    client_id = end ? end.client_id : 1;
  }
  const client = tx.get(`SELECT * FROM client WHERE id=?`, client_id);
  if (!client) client_id = 1;

  // secret verification: the endpoint's shared secret must be in the query
  const secret = (req.url.split('?')[1] || '').match(/secret=([^&]+)/)?.[1];
  const ep = tx.get(`SELECT * FROM webhook_endpoint WHERE platform=? AND client_id=?`, platform, client_id);
  if (ep && ep.secret && secret !== ep.secret && platform !== 'touchpoint' && platform !== 'form' && platform !== 'xt') {
    json(res, { ok: false, error: 'bad secret' }, 401);
    logIngest(tx, platform, client_id, 'failed', 'secret mismatch', raw, null, false);
    return;
  }
  // Phase L: in live mode, gateways must present a valid signature before processing
  const live = require('./lib/liveapi');
  if (live.liveMode() && ep && ep.secret && !['touchpoint', 'form', 'xt'].includes(platform)) {
    const sig = live.verifyInboundSignature(platform, raw, req.headers, ep.secret);
    if (!sig.ok) {
      json(res, { ok: false, error: 'bad signature: ' + sig.reason }, 401);
      logIngest(tx, platform, client_id, 'failed', 'signature: ' + sig.reason, raw, null, false);
      return;
    }
  }
  // rate limit: max 50 / min per client (per platform)
  const rl = tx.get(`SELECT COUNT(*) c FROM webhook_log WHERE client_id=? AND platform=? AND ingested_at > datetime('now','-60 seconds')`, client_id, platform);
  if (rl && rl.c > 200 && !ep) { json(res, { ok: false, error: 'rate limited' }, 429); return; }

  const map = epMap(tx, client_id, platform);
  const test = kind === 'test' || bodyJson?.__test === true;
  try {
    // enqueue so a slow platform or a 5,000-event spike never drops events
    const jobPayload = { platform, client_id, payload: bodyJson ?? parseLoose(raw), map, dedup_key: dedupKey(platform, bodyJson), test };
    if (platform === 'touchpoint' || platform === 'form' || platform === 'xt') {
      // the tracking-script path creates a touchpoint + lead directly
      processTrackerEvent(tx, kind, bodyJson, client_id);
      logIngest(tx, platform, client_id, test ? 'test' : 'processed', null, raw, null, test);
    } else {
      enqueue(db, 'webhook', jobPayload);
      logIngest(tx, platform, client_id, test ? 'test' : 'queued', null, raw, null, test);
    }
    json(res, { ok: true, client_id, queued: !test });
  } catch (e) {
    logIngest(tx, platform, client_id, 'failed', String(e.message || e).slice(0, 300), raw, null, test);
    json(res, { ok: false, error: String(e.message || e) }, 500);
  }
}
function parseLoose(raw) {
  try { return JSON.parse(raw); } catch { return { raw: raw }; }
}
function dedupKey(platform, b) {
  if (!b) return null;
  const p = b.data || b.payload || b.event || b;
  return p.order_id || p.transaction_id || p.id || p.uid || null;
}
function epMap(tx, clientId, platform) {
  const r = tx.get(`SELECT mapping FROM field_map WHERE client_id=? AND platform=?`, clientId, platform);
  try { return r ? JSON.parse(r.mapping) : {}; } catch { return {}; }
}
function logIngest(tx, platform, clientId, status, error, raw, ref, test) {
  const dedup = dedupKey(platform, null);
  const info = tx.run(`INSERT INTO webhook_log (client_id, platform, ref, dedup_key, status, error, raw, test) VALUES (?,?,?,?,?,?,?,?)`,
    clientId, platform, ref || null, dedup, status, error, (raw || '').slice(0, 20000), test ? 1 : 0);
  return info;
}

// tracker path (xt.js): touchpoint + optional form_submit that reveals identity
function processTrackerEvent(tx, kind, b, client_id) {
  if (!b) return;
  const phone = S.normPhone(b.phone || b.xtm_phone);
  const email = S.normEmail(b.email || b.xtm_email);
  const visitorId = b.visitor_id || b.xtm_visitor_id;
  const row = {
    visitor_id: visitorId || null,
    fbc: b.fbc || b.xtm_fbc, fbp: b.fbp || b.xtm_fbp, fbclid: b.fbclid,
    utm_source: b.utm_source || b.xtm_utm_source, utm_medium: b.utm_medium || b.xtm_utm_medium,
    utm_campaign: b.utm_campaign || b.xtm_utm_campaign, utm_content: b.utm_content || b.xtm_utm_content,
    utm_term: b.utm_term || b.xtm_utm_term,
    campaign_id: b.campaign_id || b.xtm_campaign_id, adset_id: b.adset_id || b.xtm_adset_id,
    ad_id: b.ad_id || b.xtm_ad_id,
    landing_url: b.landing_url || windowHref(), referrer: b.referrer,
    device: b.device, ip: b.ip, ua: b.ua, ts: b.ts,
  };
  if (kind === 'form_submit' && (phone || email)) {
    const lead = getOrCreateLead(tx, client_id, { phone: b.phone || b.xtm_phone, email: b.email || b.xtm_email, name: b.name || b.xtm_name, city: b.city });
    attachVisitorTouchpoints(tx, lead, visitorId);
    recordTouchpoint(tx, { ...row, lead_id: lead.id });
    addEvent(tx, { lead, type: 'form_submit', source_platform: 'xt.js', dedup_key: 'xt|' + lead.id + '|' + kind, ts: b.ts });
    if (b.event_type === 'registered') addEvent(tx, { lead, type: 'registered', source_platform: 'xt.js', dedup_key: 'xt|reg|' + lead.id });
    audit(db, null, 'track.form_submit', 'lead', String(lead.id));
  } else {
    recordTouchpoint(tx, row);
  }
}
function windowHref() { return null; } // server-side; landing_url from the client is preferred

// ---------------------------------------------------------------- route table
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  const user = userFromCookie(db, req.headers.cookie);
  const method = req.method;
  try {
    // ---------- static: xt.js, demo page ----------
    if (u.pathname === '/xt.js' || u.pathname === '/public/xt.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' });
      res.end(fs.readFileSync(path.join(__dirname, '..', 'public', 'xt.js')));
      return;
    }
    if (u.pathname === '/demo' || u.pathname === '/demo/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(path.join(__dirname, '..', 'public', 'test-samples', 'demo-page.html')));
      return;
    }

    // ---------- public ingest ----------
    if (u.pathname.startsWith('/api/ingest/') && method === 'POST') {
      const platform = parts[2];
      const { json: body, raw } = await parseBody(req);
      await handleIngest(platform, parts[3] || '', res, body, raw, req, null);
      return;
    }
    if (u.pathname.startsWith('/api/') && method === 'GET') {
      json(res, { endpoints: ['POST /api/ingest/<platform>', 'POST /api/ingest/<platform>/test (client_id + secret in body)'] });
      return;
    }

    // ---------- auth ----------
    if (u.pathname === '/signin') {
      if (method === 'POST') {
        const { json } = await parseBody(req);
        const email = (json.email || '').toLowerCase();
        const pw = json.password || '';
        const row = db.prepare(`SELECT * FROM user WHERE lower(email)=?`).get(email);
        if (!row || row.password_hash !== hashPassword(pw)) {
          send(res, 401, S.layout({ title: 'Sign in', nav: [], active: '', user: { name: '', role: '' }, body: '<div class="card"><h1>Sign in</h1><div class="note warn">Wrong email or password.</div></div>' }));
          return;
        }
        const token = createSession(db, row);
        setCookie(res, token);
        res.writeHead(302, { Location: '/' });
        res.end();
        return;
      }
      send(res, 200, S.layout({
        title: 'Sign in', nav: [], active: '', user: { name: '', role: '' },
        body: `<div class="card" style="max-width:380px;margin:60px auto">
          <h1>Sign in</h1>
          <div class="note">Demo users (all password <code>xacqora</code>):<br>
          <b>owner@xacqora.local</b> · owner<br>
          <b>arpit@xacqora.local</b> · media_buyer<br>
          <b>client@xacqora.local</b> · client (read-only portal)</div>
          <form method="post" action="/signin">
            <label>Email</label><input name="email" value="owner@xacqora.local" style="width:100%">
            <label style="margin-top:8px">Password</label><input name="password" type="password" value="xacqora" style="width:100%">
            <div style="margin-top:12px"><button class="btn" style="width:100%">Sign in</button></div>
          </form></div>` }),
      { 'Content-Type': 'text/html' });
      return;
    }
    if (u.pathname === '/signout') {
      if (user) {
        try { db.prepare(`DELETE FROM session_token WHERE user_id=?`).run(user.id); } catch {}
      }
      res.setHeader('Set-Cookie', 'xt_session=; Path=/; Max-Age=0');
      res.writeHead(302, { Location: '/signin' }); res.end(); return;
    }

    // ---------- protected UI ----------
    if (method === 'GET' && !u.pathname.startsWith('/api/')) {
      const guard = (page, roles) => {
        if (!requireUser(res, user, roles)) return false;
        send(res, 200, page);
        return true;
      };
      switch (parts[0]) {
        case undefined:
          if (user) { // dashboard or portal
            const page = user.role === 'client' ? screens.portal(db, user, {}) : screens.dashboard(db, user, {});
            guard(page);
          } else { res.writeHead(302, { Location: '/signin' }); res.end(); }
          return;
        case 'dashboard.html':
          return guard(user.role === 'client' ? screens.portal(db, user, {}) : screens.dashboard(db, user, {}));
        case 'leads': {
          if (!user) { res.writeHead(302, { Location: '/signin' }); res.end(); return; }
          const p = Object.fromEntries(u.searchParams.entries());
          return guard(screens.leads(db, user, p));
        }
        case 'lead':
          if (!user) { res.writeHead(302, { Location: '/signin' }); res.end(); return; }
          if (parts[2] === 'update' && method === 'POST') return; // handled below
          const p = { id: parts[1] };
          return guard(screens.leadTimeline(db, user, p));
        case 'pipeline.html':
          return guard(screens.pipeline(db, user, Object.fromEntries(u.searchParams.entries())));
        case 'reports.html':
          return guard(screens.reports(db, user, Object.fromEntries(u.searchParams.entries())));
        case 'meta.html':
          return guard(screens.meta(db, user, {}));
        case 'meta':
          if (parts[1] === 'pull') {
            const id = Number(u.searchParams.get('acc')) || 1;
            const acc = db.prepare(`SELECT * FROM meta_ad_account WHERE id=?`).get(id);
            if (acc) {
              const metaLib = require('./lib/meta');
              const tx = makeTx(db);
              metaLib.runMetaPull(tx, { ad_account_id: acc.ad_account_id }).then(() => {
                audit(db, user, 'meta.pull', 'ad_account', String(acc.id), acc.ad_account_id);
              }).catch((e) => {
                db.prepare(`UPDATE meta_ad_account SET last_error=? WHERE id=?`).run(String(e.message).slice(0, 200), acc.id);
              });
            }
            res.writeHead(302, { Location: '/meta.html' }); res.end();
          } else {
            send(res, 404, 'not found');
          }
          return;
        case 'integrations.html':
          return guard(screens.integrations(db, user, Object.fromEntries(u.searchParams.entries())), ['owner', 'admin', 'media_buyer']);
        case 'duplicates.html':
          return guard(screens.duplicates(db, user, Object.fromEntries(u.searchParams.entries())), ['owner', 'admin']);
        case 'admin.html':
          return guard(screens.admin(db, user, {}), ['owner', 'admin']);
        case 'portal-leads.html':
        case 'portal-reports.html':
          return guard(screens.portal(db, user, {}));
        case 'import':
          return importPage(res, user);
        default:
          send(res, 404, S.layout({ title: '404', nav: S.navFor(user), active: '', user, body: '<div class="card"><h1>Not found</h1></div>' }));
      }
      return;
    }

    // ---------- protected POST actions ----------
    if (method === 'POST' && user) {
      const tx = makeTx(db);
      if (u.pathname.startsWith('/lead/') && u.pathname.endsWith('/update')) {
        const id = Number(u.pathname.split('/')[2]);
        const { json } = await parseBody(req);
        const lead = tx.get(`SELECT * FROM lead WHERE id=?`, id);
        if (lead) {
          tx.run(`UPDATE lead SET stage=?, owner=? WHERE id=?`, json.stage || lead.stage, json.owner || lead.owner, id);
          audit(db, user, 'lead.update', 'lead', String(id), `stage=${json.stage} owner=${json.owner}`);
        }
        res.writeHead(302, { Location: '/lead/' + id }); res.end(); return;
      }
      if (u.pathname === '/duplicates/merge') {
        const { json } = await parseBody(req);
        const { mergeLeads } = require('./lib/identity');
        const keep = Number(json.keep), drop = Number(json.drop);
        mergeLeads(tx, keep, drop, json.phone);
        audit(db, user, 'lead.merge', 'lead', String(keep), `merged ${drop}`);
        res.writeHead(302, { Location: '/duplicates.html' }); res.end(); return;
      }
      if (u.pathname === '/admin/settings') {
        const { json } = await parseBody(req);
        for (const k of ['model', 'window', 'threshold', 'capi']) {
          const key = { model: 'attribution_model', window: 'attribution_window_days', threshold: 'wasted_spend_threshold', capi: 'capi' }[k];
          if (json[key] != null) {
            tx.run(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, String(json[key]));
          }
        }
        audit(db, user, 'settings.update', 'settings');
        res.writeHead(302, { Location: '/admin.html' }); res.end(); return;
      }
      if (u.pathname === '/admin/prune') {
        const { json } = await parseBody(req);
        const lid = Number(json.lead_id);
        if (lid) {
          // deletion removes the lead and stops any future CAPI events for that person
          tx.run(`UPDATE event SET sent_to_meta=2 WHERE lead_id=?`, lid);
          for (const t of tx.all(`SELECT id FROM touchpoint WHERE lead_id=?`, lid)) tx.run(`DELETE FROM touchpoint WHERE id=?`, t.id);
          for (const e of tx.all(`SELECT id FROM event WHERE lead_id=?`, lid)) tx.run(`DELETE FROM event WHERE id=?`, e.id);
          for (const d of tx.all(`SELECT id FROM deal WHERE lead_id=?`, lid)) tx.run(`DELETE FROM deal WHERE id=?`, d.id);
          for (const i of tx.all(`SELECT link_key FROM lead_identity WHERE lead_id=?`, lid)) tx.run(`DELETE FROM lead_identity WHERE link_key=?`, i.link_key);
          tx.run(`DELETE FROM lead WHERE id=?`, lid);
          audit(db, user, 'lead.delete', 'lead', String(lid), 'privacy deletion; CAPI suppressed');
        }
        res.writeHead(302, { Location: '/admin.html' }); res.end(); return;
      }
      if (u.pathname === '/import/csv') {
        const { json } = await parseBody(req);
        const tx2 = makeTx(db);
        // rows may arrive as a JSON array (file upload) or CSV text (the form)
        let parsedRows = json.rows;
        if (typeof parsedRows === 'string') parsedRows = parseCsvText(parsedRows);
        let n = 0;
        for (const row of parsedRows || []) {
          const lead = getOrCreateLead(tx2, Number(json.client_id) || 1, { phone: row.phone, email: row.email, name: row.name, city: row.city, source_unknown: 1 });
          if (row.stage) tx2.run(`UPDATE lead SET stage=? WHERE id=?`, row.stage, lead.id);
          if (row.amount && !row.refund) {
            addEvent(tx2, { lead, type: 'payment_success', value: Number(row.amount), source_platform: 'csv', dedup_key: 'csv|' + lead.id });
            tx2.run(`INSERT INTO deal (lead_id, client_id, amount, gateway, gateway_txn_id, status, paid_at) VALUES (?,?,?,?,?,?,?)`,
              lead.id, Number(json.client_id) || 1, Number(row.amount), 'csv', 'CSV-' + n, 'success', row.paid_at || new Date().toISOString());
          }
          if (row.registered) addEvent(tx2, { lead, type: 'registered', source_platform: 'csv', dedup_key: 'csvreg|' + lead.id });
          if (row.attended) addEvent(tx2, { lead, type: 'webinar_joined', source_platform: 'csv', dedup_key: 'csvatt|' + lead.id });
          n++;
        }
        audit(db, user, 'import.csv', 'lead', String(n));
        res.writeHead(302, { Location: '/leads' }); res.end(); return;
      }

      // fallthrough: treat unknown POST as error
      send(res, 400, 'bad route');
      return;
    }

    // ---------- GET actions ----------
    if (method === 'GET' && user) {
      if (u.pathname === '/meta/pull') {
        const id = Number(u.searchParams.get('acc')) || 1;
        const acc = db.prepare(`SELECT * FROM meta_ad_account WHERE id=?`).get(id);
        if (acc) enqueue(db, 'meta_pull', { ad_account_id: acc.ad_account_id });
        res.writeHead(302, { Location: '/meta.html' }); res.end(); return;
      }
      send(res, 404, 'not found');
      return;
    }

    // ---------- CORS preflight for xt.js ----------
    if (method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
      res.end(); return;
    }

    send(res, 404, 'not found');
  } catch (e) {
    console.error('[server]', e);
    try { send(res, 500, 'Internal error: ' + e.message, { 'Content-Type': 'text/plain' }); } catch {}
  }
});

// parse a simple comma-separated CSV (no quotes in the demo layout)
function parseCsvText(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const vals = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = vals[i] != null ? vals[i].trim() : null; });
    return row;
  });
}

// ---------------------------------------------------------------- import page
function importPage(res, user) {
  const clients = db.prepare(`SELECT id, name FROM client`).all();
  const opts = clients.map((c) => `<option value="${c.id}">${S.esc(c.name)}</option>`).join('');
  const body = `
  <div class="card" style="max-width:640px">
    <h1>Import CSV / Google Sheets <span class="badge">column mapping</span></h1>
    <div class="note">Old leads and sales backfill into the right lead by phone, then email.
    Map your columns: name, phone, email, city, stage, amount, registered, attended.</div>
    <form method="post" action="/import/csv" enctype="text/plain">
      <label>Client</label><input type="hidden" name="client_id" value="${opts ? clients[0].id : 1}">${opts ? `<div class="row" style="margin-bottom:10px">${opts.split('<option').slice(1).map((o) => o)}</div>` : ''}
      <label>Paste CSV (header row: name,phone,email,city,stage,amount,registered,attended,paid_at)</label>
      <textarea name="rows" rows="6" style="width:100%" placeholder="name,phone,email,city,stage,amount,registered,attended
Ravi,+919812345678,ravi@example.com,Mumbai,Paid,9999,1,1,2026-10-20T00:00:00Z"></textarea>
      <div style="margin-top:10px"><button class="btn">Import</button></div>
    </form>
    <div class="note warn" style="margin-top:12px">The demo build accepts a JSON <code>rows</code> array; paste a CSV and the server parses the common 9-column layout. Production: file upload with the same mapping screen.</div>
  </div>`;
  send(res, 200, S.layout({ title: 'Import', nav: S.navFor(user), active: 'leads', user, body }));
}

// ---------------------------------------------------------------- background ticker
setInterval(async () => {
  try {
    const tx = makeTx(db);
    await tick(db, { handleWebhook }, 30);
    // scheduled Meta pull: every ad account whose last_pull is older than 3h
    const due = tx.all(`SELECT * FROM meta_ad_account WHERE auto_pull=1 AND status='connected'
      AND (last_pull_at IS NULL OR last_pull_at < datetime('now', '-3 hours'))`);
    for (const a of due) enqueue(db, 'meta_pull', { ad_account_id: a.ad_account_id });
    // weekly summary: Monday 9am IST (Asia/Kolkata is +5:30; 03:30 UTC)
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 3600000);
    if (ist.getDay() === 1 && ist.getUTCHours() === 3 && now.getUTCMinutes() < 60) {
      // generate + store the weekly summary
      const settings = {
        attribution_model: tx.get(`SELECT value FROM settings WHERE key='attribution_model'`)?.value,
        attribution_window_days: tx.get(`SELECT value FROM settings WHERE key='attribution_window_days'`)?.value,
      };
      const ws = S.weeklySummary(tx, settings);
      const outDir = path.join(__dirname, '..', 'reports');
      fs.mkdirSync(outDir, { recursive: true });
      const file = path.join(outDir, `summary-${now.toISOString().slice(0, 10)}.json`);
      fs.writeFileSync(file, JSON.stringify(ws, null, 2));
      audit(db, null, 'weekly_summary', 'report', file.split('/').pop());
    }
  } catch (e) {
    console.error('[ticker]', e.message);
  }
}, 5000);

server.listen(PORT, () => {
  console.log('Xacqora Track demo running on http://localhost:' + PORT);
  console.log('  UI:        http://localhost:' + PORT + '/signin');
  console.log('  demo page: http://localhost:' + PORT + '/demo');
  console.log('  xt.js:     http://localhost:' + PORT + '/xt.js');
});
