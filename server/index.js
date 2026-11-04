// Xacqora Track demo server: zero-dependency Node 24 (node:sqlite built in).
// Load .env FIRST (before anything reads process.env — DATABASE_URL, the
// META_* bootstrap values, XACQORA_LIVE, XACQORA_SECRET_KEY all live there
// for local dev). Real env vars always win; no .env = pure mock/dev.
require('./lib/env').loadEnvFile();
const http = require('node:http');
const crypto = require('node:crypto');
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
const sec = require('./lib/security');
const screens = require('./screens');

const db = open();
ensureCapiLogTable(db);

// Meta live connect (env -> DB bridge): if the operator filled META_ACCESS_TOKEN
// + META_AD_ACCOUNT_IDS in .env, upsert the encrypted token onto those ad-account
// rows now so the live pull has it. No-op when the values are blank/absent (dev).
// The bridge needs its target client row (meta_ad_account.client_id is NOT NULL,
// FK to client): on a fresh unseeded DB (e.g. the replay test's scratch db) there
// is no client yet, so skip with a note instead of crashing the boot with an FK
// violation — seed first (node scripts/seed.js) and the next start syncs.
{
  const sys = makeTx(db, null);
  const ml = require('./lib/metalive');
  const clientId = Number(process.env.META_CLIENT_ID) || 1;
  if (process.env.META_ACCESS_TOKEN && !sys.get(`SELECT id FROM client WHERE id=?`, clientId)) {
    console.log(`[meta-live] target client id ${clientId} not found in this DB — skipping sync (seed first, e.g. node scripts/seed.js; the next start will sync).`);
  } else {
    const notes = ml.syncMetaAccountsFromEnv(sys, {
      token: process.env.META_ACCESS_TOKEN,
      adAccountIds: (process.env.META_AD_ACCOUNT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
      pixelId: process.env.META_PIXEL_ID || null,
      name: process.env.META_AD_ACCOUNT_NAME || null,
      clientId,
    });
    for (const n of notes) console.log('[meta-live] ' + n);
  }
}

const PORT = Number(process.env.PORT || 4100);

// Phase S: unauthenticated "pending 2FA login" markers (short-lived, rate
// limited, never grant access by themselves).
const PENDING = new Map();

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
function json429(res, msg) {
  // rate-limit response: one writeHead that carries both the status and the
  // Retry-After hint, then the JSON body
  res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
  res.end(JSON.stringify({ ok: false, error: msg }, null, 2));
}
function setCookie(res, token) {
  res.setHeader('Set-Cookie', `xt_session=${token}; Path=/; HttpOnly; Max-Age=${30 * 86400}; SameSite=Lax`);
}
// short-lived, unauthenticated marker so the /2fa/verify page knows who is
// mid-login. Never grants access on its own — the session is only created
// after the OTP check passes.
function setPending(res, userId) {
  const p = crypto.randomBytes(16).toString('hex');
  PENDING.set(p, { at: Date.now(), n: 0, userId });
  // sweep stale markers (>10 min) so the map cannot grow unbounded
  for (const [k, v] of PENDING) if (Date.now() - v.at > 600000) PENDING.delete(k);
  res.setHeader('Set-Cookie', `xt_tfa=${p}; Path=/; HttpOnly; Max-Age=600; SameSite=Lax`);
  return p;
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
  const tx = makeTx(db, null); // system scope: webhooks enqueue across clients
  // resolve the client: from body.client, the ?c= param, or the endpoint row
  let client_id = Number(bodyJson?.client ?? bodyJson?.client_id ?? clientHint ?? 0);
  if (!client_id) {
    // find a webhook_endpoint whose URL matches this platform+path
    const end = tx.all(`SELECT * FROM webhook_endpoint WHERE platform=?`, platform)[0];
    client_id = end ? end.client_id : 1;
  }
  const client = tx.get(`SELECT * FROM client WHERE id=?`, client_id);
  if (!client) client_id = 1;

  // secret verification: the endpoint's shared secret must be in the query.
  // S.2: stored encrypted; decrypt before comparing / passing to the live
  // gateway signature verifier.
  const secret = (req.url.split('?')[1] || '').match(/secret=([^&]+)/)?.[1];
  const ep = tx.get(`SELECT * FROM webhook_endpoint WHERE platform=? AND client_id=?`, platform, client_id);
  const epSecret = ep ? sec.decryptSecret(ep.secret || '') : '';
  if (ep && epSecret && secret !== epSecret && platform !== 'touchpoint' && platform !== 'form' && platform !== 'xt') {
    json(res, { ok: false, error: 'bad secret' }, 401);
    logIngest(tx, platform, client_id, 'failed', 'secret mismatch', raw, null, false);
    return;
  }
  // Phase L: in live mode, gateways must present a valid signature before processing
  const live = require('./lib/liveapi');
  if (live.liveMode() && ep && epSecret && !['touchpoint', 'form', 'xt'].includes(platform)) {
    const sig = live.verifyInboundSignature(platform, raw, req.headers, epSecret);
    if (!sig.ok) {
      json(res, { ok: false, error: 'bad signature: ' + sig.reason }, 401);
      logIngest(tx, platform, client_id, 'failed', 'signature: ' + sig.reason, raw, null, false);
      return;
    }
  }
  // Phase S: two-tier rate limit — per-endpoint (configured, generous) and
  // per-IP (global flood guard). A bad actor cannot flood a single endpoint.
  const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
    : (req.socket && req.socket.remoteAddress) || 'unknown';
  const perIp = sec.rateLimit(`ip:${ip}`, Number(process.env.XT_RATE_PER_MIN_IP) || 600, Date.now());
  if (perIp.limited) {
    json429(res, 'rate limited (per-IP)');
    if (ep) logIngest(tx, platform, client_id, 'rate_limited', 'per-IP flood guard', raw, null, false);
    return;
  }
  const perEnd = sec.rateLimit(`ep:${platform}:${client_id}`, Number(process.env.XT_RATE_PER_MIN_ENDPOINT) || 300, Date.now());
  if (perEnd.limited) {
    json429(res, 'rate limited (per-endpoint)');
    logIngest(tx, platform, client_id, 'rate_limited', 'per-endpoint window', raw, null, false);
    return;
  }

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
// Phase H: the handler is a plain function so a Vercel serverless function can
// reuse it directly (api/index.js) — Vercel provides req/res in the same
// node:http shape. `http.createServer`/`listen` only happen when this file is
// run directly (self-hosted `npm start`), never when imported by the platform.
async function handleRequest(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const parts = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  const user = userFromCookie(db, req.headers.cookie);
  const method = req.method;
  try {
    // ---------- public /health JSON (monitoring poll, no auth) ----------
    // Phase H: the alerts screen (/alerts.html, team-only) and any external
    // uptime dashboard both read the same system-scoped signal snapshot.
    if (u.pathname === '/health' && method === 'GET') {
      const tx = makeTx(db, null);
      const H = require('./lib/health');
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(H.health(tx, db), null, 2));
      return;
    }

    // ---------- Phase F: the SPA (public/app). The shell is auth-gated:
    // unauthenticated GET /app 302s to /signin (same as the HTML screens).
    // Assets under /app are served by extension (hashed JS/CSS/SVG).
    if (u.pathname === '/app' || u.pathname === '/app/' || u.pathname === '/app/index.html') {
      if (!user) { res.writeHead(302, { Location: '/signin' }); res.end(); return; }
      const shell = path.join(__dirname, '..', 'public', 'app', 'index.html');
      res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(shell));
      return;
    }
    if (u.pathname.startsWith('/app/') && method === 'GET') {
      const clean = path.normalize(u.pathname).replace(/^([.][.])+([\/\\]|$)/g, ''); // no traversal
      const file = path.join(__dirname, '..', 'public', clean);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile() || !file.startsWith(path.join(__dirname, '..', 'public', 'app'))) {
        send(res, 404, 'not found'); return;
      }
      const ext = path.extname(file).toLowerCase();
      const type = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' }[ext] || 'application/octet-stream';
      // the SPA is a dev/demo build with no CDN: no-cache so a rebuild is
      // never served stale. (Vercel/static hosts can add content-hashing later.)
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(file));
      return;
    }

    // ---------- Phase F: JSON API for the SPA. Cookie-authenticated,
    // role-aware + RLS-scoped (lib/api.js). The HTML routes above stay the
    // fallback and render the same data.
    if (u.pathname.startsWith('/api/app/')) {
      const app = require('./lib/api');
      const { json: body } = method === 'POST' ? await parseBody(req) : { json: null };
      if (method === 'GET') app.api.get(u, db, user, res);
      else if (method === 'POST') app.api.post(u, body, db, user, res, req);
      else { res.writeHead(405, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'method not allowed' })); }
      return;
    }

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

    // ---------- weekly client summary PDF (generated by the Monday ticker) ----------
    if (u.pathname === '/weekly.pdf') {
      if (!user) { res.writeHead(302, { Location: '/signin' }); res.end(); return; }
      const tx = makeTx(db, user);
      // client role: only its own client's PDF; team roles: ?client=N (default: its).
      const wantClient = user.role === 'client'
        ? Number((user.client_ids || '').split(',')[0] || 0)
        : Number(u.searchParams.get('client') || 0);
      const key = `weekly_pdf_client_${wantClient}`;
      const target = tx.get(`SELECT value FROM settings WHERE key=?`, key)?.value;
      if (!target || !fs.existsSync(target)) {
        send(res, 404, S.layout({ title: '404', nav: S.navFor(user), active: 'dashboard.html', user,
          body: `<div class="card"><h1>No weekly summary yet</h1><div class="note">The Monday 9 AM IST job hasn't generated one for this client yet.</div></div>` }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${path.basename(target)}"`,
      });
      res.end(fs.readFileSync(target));
      return;
    }

    // ---------- Phase H: serverless cron tick (token-gated queue drain) ----------
    if (u.pathname === '/admin/tick' && method === 'POST') {
      tickEndpoint(res, req);
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
        // Phase S: if the account (or the global enforcement flag) requires 2FA,
        // hold the login in tfa_pending and demand the OTP before issuing a session.
        // totp_secret is stored ENCRYPTED (S.2); the pending row copies the blob.
        const sec = require('./lib/security');
        const plainSecret = sec.decryptSecret(row.totp_secret || '');
        const force = db.prepare(`SELECT value FROM settings WHERE key='two_factor_enforced'`).get()?.value === '1';
        const wantsTotp = row.totp_enabled && plainSecret;
        if (wantsTotp || (force && sec.isTeam(row))) {
          if (!plainSecret) {
            // forced but not enrolled: block the team login, point at enrollment
            send(res, 403, S.layout({ title: '2FA required', nav: [], active: '', user: { name: row.name, role: row.role }, body: '<div class="card"><h1>Two-factor login required</h1><div class="note warn">This account must enroll in 2FA (Admin → Users → 2FA) before signing in.</div></div>' }));
            audit(db, row, 'auth.2fa_blocked', 'user', String(row.id));
            return;
          }
          db.prepare(`DELETE FROM tfa_pending WHERE user_id=?`).run(row.id);
          db.prepare(`INSERT INTO tfa_pending (user_id, totp_secret) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET totp_secret=excluded.totp_secret`).run(row.id, row.totp_secret);
          setPending(res, row.id);
          res.writeHead(302, { Location: '/2fa/verify' });
          res.end();
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

    // ---------- Phase S: two-factor verify (unauthenticated, OTP-gated) ----------
    if (u.pathname === '/2fa/verify') {
      const p = (req.headers.cookie || '').match(/xt_tfa=([a-f0-9]+)/)?.[1];
      const pend = p ? PENDING.get(p) : null;
      // the pending marker names exactly which user is mid-login
      const userRow = pend && pend.userId
        ? db.prepare(`SELECT * FROM user WHERE id=?`).get(pend.userId)
        : null;
      if (!userRow) { res.writeHead(302, { Location: '/signin' }); res.end(); return; }
      if (method === 'GET') {
        send(res, 200, S.layout({
          title: 'Two-factor code', nav: [], active: '', user: { name: userRow.email, role: 'auth' },
          body: `<div class="card" style="max-width:360px;margin:60px auto"><h1>Two-factor code</h1>
            <div class="note">Enter the 6-digit code from your authenticator app for <b>${S.esc(userRow.email)}</b>.</div>
            <form method="post" action="/2fa/verify">
              <input name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" style="width:100%;letter-spacing:4px;font-size:18px;text-align:center">
              <div style="margin-top:10px"><button class="btn" style="width:100%">Verify</button></div>
            </form>
            <a href="/signin" class="small muted">Cancel and sign out</a></div>` }));
        return;
      }
      // POST
      const { json } = await parseBody(req);
      const code = String(json.code || '').trim();
      const tsec = require('./lib/security');
      // S.2: totp_secret is encrypted at rest; decrypt for verification only
      const ok = tsec.decryptSecret(userRow.totp_secret || '') &&
        tsec.totpVerify(tsec.decryptSecret(userRow.totp_secret || ''), code, 1);
      // lockout: 5 bad attempts in a row wipes the pending row
      if (!ok) {
        pend.n = (pend.n || 0) + 1;
        if (pend.n >= 5) { db.prepare(`DELETE FROM tfa_pending WHERE user_id=?`).run(userRow.id); PENDING.delete(p); }
        audit(db, userRow, 'auth.2fa_fail', 'user', String(userRow.id));
        send(res, 401, S.layout({ title: 'Two-factor code', nav: [], active: '', user: { name: '', role: '' }, body: '<div class="card"><h1>Sign in</h1><div class="note warn">Code not accepted.' + (pend.n >= 5 ? ' Pending login cleared after repeated failures.' : '') + '</div></div>' }));
        return;
      }
      db.prepare(`DELETE FROM tfa_pending WHERE user_id=?`).run(userRow.id);
      PENDING.delete(p);
      res.setHeader('Set-Cookie', 'xt_tfa=; Path=/; Max-Age=0');
      audit(db, userRow, 'auth.2fa_ok', 'user', String(userRow.id));
      const token = createSession(db, userRow);
      setCookie(res, token);
      res.writeHead(302, { Location: '/' });
      res.end();
      return;
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
            const p0 = Object.fromEntries(u.searchParams.entries());
            const page = user.role === 'client' ? screens.portal(db, user, p0) : screens.dashboard(db, user, p0);
            guard(page);
          } else { res.writeHead(302, { Location: '/signin' }); res.end(); }
          return;
        case 'dashboard.html':
          return guard(user.role === 'client'
            ? screens.portal(db, user, Object.fromEntries(u.searchParams.entries()))
            : screens.dashboard(db, user, Object.fromEntries(u.searchParams.entries())));
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
          // team-only: ad accounts / spend / CAPI log cross clients by design
          return guard(screens.meta(db, user, {}), ['owner', 'admin', 'media_buyer']);
        case 'meta':
          if (parts[1] === 'pull') {
            if (!sec.isTeam(user)) { send(res, 403, 'team-only'); res.end(); return; }
            const id = Number(u.searchParams.get('acc')) || 1;
            const acc = db.prepare(`SELECT * FROM meta_ad_account WHERE id=?`).get(id);
            if (acc) {
              const metaLib = require('./lib/meta');
              const tx = makeTx(db, user); // RLS backstop: the pull lands in the user's scope
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
          return guard(screens.admin(db, user, Object.fromEntries(u.searchParams.entries())), ['owner', 'admin']);
        case 'portal-leads.html':
        case 'portal-reports.html':
          return guard(screens.portal(db, user, {}));
        case 'import':
          return importPage(res, user);
        case 'pilot':
          // Phase G: pilot gates tooling — team-only (pilot ops is not client work)
          return guard(screens.pilot(db, user, Object.fromEntries(u.searchParams.entries())), ['owner', 'admin', 'media_buyer']);
        case 'alerts.html':
          // Phase H: monitoring + prod toggles — team-only ops screen
          return guard(screens.alerts(db, user, {}), ['owner', 'admin', 'media_buyer']);
        case 'export':
          return exportRoute(res, user, parts, u);
        default:
          send(res, 404, S.layout({ title: '404', nav: S.navFor(user), active: '', user, body: '<div class="card"><h1>Not found</h1></div>' }));
      }
      return;
    }

    // ---------- protected POST actions ----------
    if (method === 'POST' && user) {
      const tx = makeTx(db, user); // Phase P: this user's RLS scope on Postgres
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
      // Master v9 Task 2: DATA_MODE admin toggle (demo | live | default->env).
      // The settings row wins over the DATA_MODE env var; team-only + audited.
      if (u.pathname === '/admin/data-mode') {
        if (!['owner', 'admin'].includes(user.role)) { send(res, 403, 'forbidden'); return; }
        const { json } = await parseBody(req);
        const dm = require('./lib/datamode');
        const before = dm.mode(tx);
        const result = dm.setDataMode(tx, String(json.mode || ''));
        audit(db, user, 'data_mode.toggle', 'settings', `${before} -> ${result}${result === 'default' ? ' (env/default)' : ''}`);
        res.writeHead(302, { Location: '/admin.html' }); res.end(); return;
      }
      // Phase S: 2FA enrollment for the logged-in user
      if (u.pathname === '/admin/2fa') {
        if (!['owner', 'admin'].includes(user.role)) { send(res, 403, 'forbidden'); return; }
        const { json } = await parseBody(req);
        const sec = require('./lib/security');
        const me = db.prepare(`SELECT * FROM user WHERE id=?`).get(user.id);
        if (json.action === 'enroll') {
          // generate + store an ENCRYPTED totp secret, enable 2FA
          const secretPlain = sec.totpSecret();
          db.prepare(`UPDATE user SET totp_secret=?, totp_enabled=1 WHERE id=?`)
            .run(sec.encryptSecret(secretPlain), me.id);
          audit(db, user, 'auth.2fa_enroll', 'user', String(me.id));
          // redirect to a setup card that reveals the secret on-screen (not via URL)
          res.writeHead(302, { Location: '/admin.html?2fa=setup' });
          res.end();
          return;
        }
        if (json.action === 'disable') {
          db.prepare(`UPDATE user SET totp_enabled=0 WHERE id=?`).run(me.id);
          audit(db, user, 'auth.2fa_disable', 'user', String(me.id));
        }
        res.writeHead(302, { Location: '/admin.html' });
        res.end();
        return;
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
        const tx2 = makeTx(db, user); // import lands in the importer's own scope
        // Phase G: a JSON body with a column mapping -> canonical old-leads
        // import (duplicate skip + E.164 + backfill). Otherwise fall back to
        // the legacy 9-column paste (rows arrive as CSV text or a JSON array).
        // Phase G: a CSV string -> canonical old-leads import (duplicate skip +
        // E.164 + backfill). Use the picked mapping, or infer it from the header row.
        if (json && typeof json.csv === 'string') {
          const pilot = require('./lib/pilot');
          // importOldLeads infers the mapping from the header when none is given
          const pRes = pilot.importOldLeads(tx2, Number(json.client_id) || 1,
            { csv: json.csv, mapping: json.mapping });
          audit(db, user, 'import.csv', 'lead',
            `mapped: +${pRes.imported} imported, ${pRes.matched} matched, ${pRes.skipped} skipped, ${pRes.deals} deals`);
          res.writeHead(302, { Location: '/leads' }); res.end(); return;
        }
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

      // Phase G: pilot tooling — mapped CSV import, accuracy checkers, timing log
      // (team-only screen; mirror the /pilot GET guard so a client role cannot post here)
      if (u.pathname.startsWith('/pilot/') && !['owner', 'admin', 'media_buyer'].includes(user.role)) {
        send(res, 403, 'forbidden'); return;
      }
      if (u.pathname === '/pilot/import') {
        const pilot = require('./lib/pilot');
        const pRes = pilot.importOldLeads(tx, Number(json.client_id) || 1,
          { csv: json.csv || '', mapping: collectMapParam(json) });
        audit(db, user, 'pilot.import.csv', 'lead',
          `+${pRes.imported} imported, ${pRes.matched} matched, ${pRes.skipped} skipped, ${pRes.deals} deals`);
        res.writeHead(302, { Location: '/pilot' }); res.end(); return;
      }
      if (u.pathname === '/pilot/accuracy') {
        const pilot = require('./lib/pilot');
        const rev = Number(json.rev_ext || 0);
        const sp = Number(json.spend_ext || 0);
        const tx2 = makeTx(db, user);
        const results = {
          revenue: rev ? pilot.revenueVsGateways(tx2, { externalTotal: rev }) : null,
          spend: sp ? pilot.spendVsMeta(tx2, { externalTotal: sp }) : null,
          capi: pilot.capiQuality(tx2),
        };
        audit(db, user, 'pilot.accuracy', 'report',
          `revenue ${results.revenue ? (results.revenue.pass ? 'PASS ' : 'FAIL ') + results.revenue.diff_pct + '% diff' : '—'}, ` +
          `spend ${results.spend ? (results.spend.pass ? 'PASS ' : 'FAIL ') + results.spend.diff_pct + '% diff' : '—'}, ` +
          `CAPI MQ ${results.capi.avg_mq} (${results.capi.pct_good}% ≥7)`);
        res.writeHead(302, { Location: '/pilot?accuracy=1' }); res.end(); return;
      }
      if (u.pathname === '/pilot/timing') {
        const pilot = require('./lib/pilot');
        pilot.weeklyTiming(tx, {
          beforeMin: json.before_min != null ? Number(json.before_min) : null,
          afterMin: json.after_min != null ? Number(json.after_min) : null,
        });
        audit(db, user, 'pilot.weekly_timing', 'report',
          `before ${json.before_min ?? '—'} min, after ${json.after_min ?? '—'} min`);
        res.writeHead(302, { Location: '/pilot' }); res.end(); return;
      }

      // Phase H: prod toggles from the alerts screen (team-only)
      if (u.pathname === '/alerts/meta-verify') {
        if (!['owner', 'admin', 'media_buyer'].includes(user.role)) { send(res, 403, 'forbidden'); return; }
        const cur = tx.get(`SELECT value FROM settings WHERE key='meta_business_verified'`)?.value;
        const on = cur !== '1';
        tx.run(`INSERT INTO settings (key,value) VALUES ('meta_business_verified',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, on ? '1' : '0');
        audit(db, user, 'alerts.meta_business_verify', 'settings', on ? 'verified' : 'unverified');
        res.writeHead(302, { Location: '/alerts.html' }); res.end(); return;
      }
      if (u.pathname === '/alerts/capi') {
        if (!['owner', 'admin', 'media_buyer'].includes(user.role)) { send(res, 403, 'forbidden'); return; }
        const cur = tx.get(`SELECT value FROM settings WHERE key='capi'`)?.value || 'dry';
        const next = cur === 'live' ? 'dry' : 'live';
        tx.run(`INSERT INTO settings (key,value) VALUES ('capi',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, next);
        audit(db, user, 'alerts.capi_toggle', 'settings', `capi -> ${next}`);
        res.writeHead(302, { Location: '/alerts.html' }); res.end(); return;
      }

      // fallthrough: treat unknown POST as error
      send(res, 400, 'bad route');
      return;
    }

    // ---------- GET actions ----------
    if (method === 'GET' && user) {
      if (u.pathname === '/pilot-live-checklist') {
        // Phase G: serve docs/pilot-live-checklist.md inside the app chrome
        const md = fs.existsSync(path.join(__dirname, '..', 'docs', 'pilot-live-checklist.md'))
          ? fs.readFileSync(path.join(__dirname, '..', 'docs', 'pilot-live-checklist.md'), 'utf8')
          : 'docs/pilot-live-checklist.md not found.';
        send(res, 200, S.layout({ title: 'Pilot live checklist', nav: S.navFor(user), active: 'pilot', user,
          body: `<div class="card" style="max-width:900px"><h1>Pilot live checklist</h1>
            <pre style="white-space:pre-wrap;font-size:13px;line-height:1.5;font-family:inherit">${S.esc(md)}</pre></div>` }));
        return;
      }
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
}

// The Vercel serverless entry (api/index.js) imports handleRequest directly.
// Self-hosted `npm start` wires it to a node:http server and listens below.
const server = http.createServer(handleRequest);

// ---------------------------------------------------------------- S.4: CSV exports
// Every export is role-masked (phone/email for roles without full contact
// access) and written to the audit log — "exports logged in the audit log".
// Build the scoped settings used by the report exports (mirror the Reports
// screen's model / window selection from the query string).
function reportSettings(u, tx) {
  const model = u.searchParams.get('model')
    || tx.get(`SELECT value FROM settings WHERE key='attribution_model'`)?.value
    || 'last_paid_click';
  const window = u.searchParams.get('window')
    || tx.get(`SELECT value FROM settings WHERE key='attribution_window_days'`)?.value
    || '30';
  const threshold = u.searchParams.get('threshold') || '0';
  return {
    attribution_model: model,
    attribution_window_days: window,
    wasted_spend_threshold: threshold,
    report_from: u.searchParams.get('from') || null,
    report_to: u.searchParams.get('to') || null,
  };
}
function reportScope(user, u, tx) {
  // client role is locked to its own client_ids; team roles may pick a client.
  const scope = user.role === 'client'
    ? (user.client_ids || '').split(',').filter(Boolean)
    : (u.searchParams.get('client') ? [u.searchParams.get('client')] : null);
  return scope;
}
// Master v9: ?acc= on the report exports — scope to one REAL ad account,
// validated against the caller's in-scope accounts (invalid/foreign -> off),
// so CSV/Excel match the Reports screen.
function reportAccount(u, tx, scope, live) {
  const dm = require('./lib/datamode');
  const accReq = u.searchParams.get('acc') || '';
  const rep = S.metaAccountReport(tx, { adAccount: '', clientIds: scope, dataMode: live ? dm.LIVE : dm.DEMO });
  return rep.accounts.some((a) => a.ad_account_id === accReq) ? accReq : '';
}

function exportRoute(res, user, parts, u) {
  const kind = parts[1] || '';
  const fmt = (u.searchParams.get('fmt') || 'csv').toLowerCase();
  const isExcel = fmt === 'excel' || fmt === 'xls' || fmt === 'xlsx';
  const tx = makeTx(db, user); // export rows bounded by the user's RLS scope
  // Master v9: DATA_MODE — live exports exclude the demo seed rows.
  const dm = require('./lib/datamode');
  const live = dm.mode(tx) === dm.LIVE;
  let rows = [], label = '', sheet = kind;

  if (kind === 'leads') {
    const scope = user.role === 'client'
      ? Number((user.client_ids || '').split(',')[0] || 0)
      : Number(u.searchParams.get('client') || 0);
    let where = scope ? `WHERE l.client_id=?` : '';
    const args = scope ? [scope] : [];
    const q = (u.searchParams.get('q') || '').trim();
    if (q) { where += ` AND (l.phone LIKE ? OR l.email LIKE ? OR l.name LIKE ?)`; args.push('%' + q + '%', '%' + q + '%', '%' + q + '%'); }
    const stage = u.searchParams.get('stage');
    if (stage) { where += ` AND l.stage=?`; args.push(stage); }
    const exLead = dm.leadNotDemo(live ? dm.LIVE : dm.DEMO, 'l');
    if (exLead) { where = where ? `${where} AND ${exLead}` : `WHERE ${exLead}`; }
    const leadRows = tx.all(`SELECT l.id, l.name, l.phone, l.email, l.city, l.stage, l.owner, l.client_id, c.name client,
      (SELECT COALESCE(SUM(d.amount),0) FROM deal d WHERE d.lead_id=l.id AND d.status='success' AND d.refunded_at IS NULL) paid
      FROM lead l LEFT JOIN client c ON c.id=l.client_id ${where} ORDER BY l.id DESC LIMIT 5000`, ...args);
    rows = leadRows.map((r) => ({
      id: r.id, name: r.name, phone: r.phone, email: r.email, city: r.city,
      stage: r.stage, owner: r.owner, client: r.client, paid: r.paid,
    }));
    label = `leads (${rows.length} rows)`;
  } else if (kind === 'report' || kind === 'ad-performance') {
    // ad performance export — same scoping + attribution model as the Reports screen
    const scope = reportScope(user, u, tx);
    const settings = reportSettings(u, tx);
    const acc = reportAccount(u, tx, scope, live);
    const ap = S.adPerformance(tx, settings, scope, acc, live);
    rows = ap.rows.map((r) => ({
      ad_id: r.ad_id, ad: r.name, campaign: r.campaign, account: r.account, status: r.status,
      spend: r.spend, impressions: r.impressions, clicks: r.clicks,
      cpc: r.cpc, cpm: r.cpm, leads: r.leads, revenue: r.revenue, roas: r.roas, profit: r.profit,
      meta_conv: r.meta_conv, our_conv: r.our_conv, conv_delta: r.conv_delta,
      wasted: r.wasted ? 'yes' : 'no', model: r.model,
    }));
    label = `report/ad-performance (${rows.length} rows, ${settings.attribution_model})`;
    sheet = 'ad_performance';
  } else if (kind === 'funnel') {
    const scope = reportScope(user, u, tx);
    const settings = reportSettings(u, tx);
    const fp = S.funnelReport(tx, null, settings, scope, live);
    rows = [
      { metric: 'Leads', value: fp.leads },
      { metric: 'Registered', value: fp.registered },
      { metric: 'Attended', value: fp.attended },
      { metric: 'Calls', value: fp.calls },
      { metric: 'Paid', value: fp.paid },
      { metric: 'Refunded', value: fp.refunded || 0 },
      { metric: 'Show-up rate %', value: fp.show_up_rate },
      { metric: 'Close rate %', value: fp.close_rate },
      { metric: 'Revenue (net of refunds)', value: fp.revenue },
      { metric: 'Ad spend', value: fp.spend },
      { metric: 'Cost per lead', value: fp.cpl },
      { metric: 'Cost per sale', value: fp.cost_per_sale },
      { metric: 'ROAS', value: fp.roas ?? null },
      { metric: 'Attributed sales', value: fp.attribution.attributed },
      { metric: 'Organic / unknown sales', value: fp.attribution.organic },
    ];
    label = `report/funnel (${scope ? 'client ' + scope.join(',') : 'all clients'}, ${settings.attribution_model})`;
    sheet = 'funnel';
  } else if (kind === 'source-mix') {
    const scope = reportScope(user, u, tx);
    rows = S.sourceMix(tx, scope, live).map((r) => ({ source: r.src, leads: r.c }));
    label = `report/source-mix (${rows.length} buckets)`;
    sheet = 'source_mix';
  } else if (kind === 'new-vs-old') {
    const scope = reportScope(user, u, tx);
    const settings = reportSettings(u, tx);
    const nv = S.newVsOld(tx, settings, scope, live);
    rows = [
      { bucket: 'in range', leads: nv.in_range_count, revenue: nv.in_range_revenue },
      { bucket: 'older', leads: nv.older_count, revenue: nv.older_revenue },
      ...nv.in_range.map((x) => ({ bucket: 'in_range_lead', lead_id: x.id, created_at: x.created_at, revenue: x.rev })),
      ...nv.older.map((x) => ({ bucket: 'older_lead', lead_id: x.id, created_at: x.created_at, revenue: x.rev })),
    ];
    label = `report/new-vs-old (${rows.length} rows)`;
    sheet = 'new_vs_old';
  } else if (kind === 'meta-vs-track') {
    const scope = reportScope(user, u, tx);
    const settings = reportSettings(u, tx);
    const acc = reportAccount(u, tx, scope, live);
    const mvt = S.metaVsTracker(tx, settings, scope, acc, live);
    rows = mvt.rows.map((r) => ({
      ad_id: r.ad_id, ad: r.ad, campaign: r.campaign,
      meta_conversions: r.meta_conv, our_conversions: r.our_conv, delta: r.delta,
    }));
    label = `report/meta-vs-track (${rows.length} ads, delta=${mvt.delta})`
      + ` [meta total=${mvt.meta_conv_total}, ours total=${mvt.our_conv_total}]`;
    sheet = 'meta_vs_track';
  } else if (kind === 'weekly-summary') {
    const scope = reportScope(user, u, tx);
    const settings = reportSettings(u, tx);
    const ws = S.weeklySummary(tx, settings, scope, live);
    rows = [
      { item: 'generated_at', value: ws.generated_at },
      { item: 'model', value: ws.settings.model },
      { item: 'funnel.leads', value: ws.funnel.leads },
      { item: 'funnel.registered', value: ws.funnel.registered },
      { item: 'funnel.attended', value: ws.funnel.attended },
      { item: 'funnel.calls', value: ws.funnel.calls },
      { item: 'funnel.paid', value: ws.funnel.paid },
      { item: 'funnel.refunded', value: ws.funnel.refunded || 0 },
      { item: 'funnel.revenue (net)', value: ws.funnel.revenue },
      { item: 'total.spend', value: ws.total.spend },
      { item: 'total.revenue', value: ws.total.revenue },
      { item: 'total.roas', value: ws.total.roas },
      { item: 'total.profit', value: ws.total.profit },
    ];
    label = `report/weekly-summary (generated ${ws.generated_at.slice(0, 10)})`;
    sheet = 'weekly_summary';
  } else {
    send(res, 404, S.layout({ title: '404', nav: S.navFor(user), active: '', user, body: '<div class="card"><h1>Unknown export</h1></div>' }));
    return;
  }

  // Emit CSV or Excel (SpreadsheetML). Both are role-masked for the leads export
  // (phone / email) so the audit rule holds on either format.
  const mask = (kind === 'leads') ? { phone: 'phone', email: 'email' } : {};
  let body, ctype, ext;
  if (isExcel) {
    body = S.toExcel(rows, { sheetName: sheet, role: user.role, mask });
    ctype = 'application/vnd.ms-excel';
    ext = 'xls';
  } else {
    body = S.toCsv(rows, { role: user.role, mask });
    ctype = 'text/csv; charset=utf-8';
    ext = 'csv';
  }
  const action = isExcel ? 'export.xls' : 'export.csv';
  audit(db, user, action, kind, label);
  const fname = `xacqora-${kind}-${new Date().toISOString().slice(0, 10)}.${ext}`;
  res.writeHead(200, {
    'Content-Type': ctype,
    'Content-Disposition': `attachment; filename="${fname}"`,
  });
  res.end(body);
}

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

// Phase G: the pilot screen's CSV form posts map.<field> inputs (form-encoded).
// The input VALUE is the client's source column header, the SUFFIX is the Xacqora
// target field -> collapse into the { <source-header>: target-field } shape
// pilot.importOldLeads wants (empty inputs are ignored by normMapping).
function collectMapParam(json) {
  const m = {};
  for (const [k, v] of Object.entries(json || {})) {
    if (k.startsWith('map.') && v) m[String(v).trim()] = k.slice(4);
  }
  return m;
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
// Phase H: on a Vercel/serverless host the process can scale to zero, so the
// in-process setInterval is unreliable. Set XT_DISABLE_TICKER=1 there and drive
// queue drains + scheduled pulls from Vercel Cron hitting POST /admin/tick
// (gated by the XACQORA_TICK_SECRET header). Plain self-hosted runs keep the
// interval and never need the endpoint.
const DISABLE_TICKER = process.env.XT_DISABLE_TICKER === '1';
async function tickerCycle() {
  // (body below) — runs either on the interval or via POST /admin/tick
  try {
    const tx = makeTx(db, null); // system ticker: queue + scheduled pulls
    await tick(db, { handleWebhook }, 30);
    // scheduled Meta pull: every ad account whose last_pull is older than 3h
    const threeHoursAgo = new Date(Date.now() - 3 * 3600000).toISOString();
    const due = tx.all(`SELECT * FROM meta_ad_account WHERE auto_pull=1 AND status='connected'
      AND (last_pull_at IS NULL OR last_pull_at < ?)`, threeHoursAgo);
    for (const a of due) enqueue(db, 'meta_pull', { ad_account_id: a.ad_account_id });
    // daily backup: once per IST calendar day (PRD §10: daily DB backup)
    const now = new Date();
    const ist = new Date(now.getTime() + 5.5 * 3600000);
    const istDay = ist.toISOString().slice(0, 10);
    const lastBackup = tx.get(`SELECT value FROM settings WHERE key='last_backup_date'`)?.value;
    if (lastBackup !== istDay && ist.getUTCHours() >= 0) {
      try {
        const { runBackup } = require('./lib/backup');
        const file = runBackup(db);
        tx.run(`INSERT INTO settings (key, value) VALUES ('last_backup_date',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, istDay);
        audit(db, null, 'backup.daily', 'backup', file);
      } catch (e) {
        console.error('[backup]', e.message);
      }
    }
    // weekly summary: Monday 9am IST (Asia/Kolkata is +5:30; 03:30 UTC).
    // One page per client (portal card + PDF download), plus an all-client JSON
    // for the internal audit trail. Zero manual — the client just gets it.
    if (ist.getDay() === 1 && ist.getUTCHours() === 3 && now.getUTCMinutes() < 60) {
      const { report: pdfReport } = require('./lib/pdf');
      const settings = {
        attribution_model: tx.get(`SELECT value FROM settings WHERE key='attribution_model'`)?.value,
        attribution_window_days: tx.get(`SELECT value FROM settings WHERE key='attribution_window_days'`)?.value,
      };
      // Master v9: the auto PDF must not mail demo figures to clients in live
      // mode (seed rows are excluded from every screen there too).
      const dm = require('./lib/datamode');
      const live = dm.mode(tx) === dm.LIVE;
      const outDir = path.join(__dirname, '..', 'reports');
      fs.mkdirSync(outDir, { recursive: true });
      const date = now.toISOString().slice(0, 10);

      // all-client summary (audit trail + team view)
      const wsAll = S.weeklySummary(tx, settings, null, live);
      const allFile = path.join(outDir, `summary-${date}.json`);
      fs.writeFileSync(allFile, JSON.stringify(wsAll, null, 2));
      audit(db, null, 'weekly_summary', 'report', allFile.split('/').pop());

      // one PDF + portal card per client
      const clients = tx.all(`SELECT c.id, c.name FROM client c ORDER BY c.id`);
      for (const c of clients) {
        const ws = S.weeklySummary(tx, settings, [c.id], live);
        const pdfBytes = pdfReport(S.weeklyPdfLines(ws, c.name));
        const pdfFile = path.join(outDir, `summary-${date}-client${c.id}.pdf`);
        fs.writeFileSync(pdfFile, pdfBytes);
        // keep the latest PDF path in settings so the portal card can link it
        tx.run(`INSERT INTO settings (key, value) VALUES ('weekly_pdf_client_${c.id}', ?)
          ON CONFLICT(key) DO UPDATE SET value=excluded.value`, pdfFile);
        audit(db, null, 'weekly_summary.pdf', 'report', pdfFile.split('/').pop() + ` (client ${c.id})`);
      }
    }
  } catch (e) {
    console.error('[ticker]', e.message);
  }
}

// self-hosted: run the cycle on a 5s interval. serverless: XT_DISABLE_TICKER=1
// turns the interval off and Vercel Cron POSTs to /admin/tick instead.
if (!DISABLE_TICKER) setInterval(tickerCycle, 5000);

// Phase H: cron-driven tick for serverless (Vercel). Gated by a shared secret so
// the queue drain / scheduled pulls can be triggered on demand.
function tickEndpoint(res, req) {
  const secret = process.env.XACQORA_TICK_SECRET;
  if (!secret) { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('XACQORA_TICK_SECRET not set'); return; }
  const provided = req.headers['x-xacqora-tick-secret'] || '';
  const want = secret;
  const a = Buffer.from(String(provided)); const b = Buffer.from(want);
  const ok = (a.length === b.length) && (crypto.timingSafeEqual ? crypto.timingSafeEqual(a, b) : (provided === want));
  if (!ok) { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('bad tick secret'); return; }
  tickerCycle().then(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); })
    .catch((e) => { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(String(e.message || e)); });
}

// Listen only when this file is the entry point (self-hosted `npm start`),
// not when it is required by the Vercel serverless function (api/index.js).
if (require.main === module) {
  server.listen(PORT, () => {
    console.log('Xacqora Track demo running on http://localhost:' + PORT);
    console.log('  UI:        http://localhost:' + PORT + '/signin');
    console.log('  demo page: http://localhost:' + PORT + '/demo');
    console.log('  xt.js:     http://localhost:' + PORT + '/xt.js');
    if (DISABLE_TICKER) console.log('  ticker: DISABLED (serverless) — drive via POST /admin/tick');
  });
}

module.exports = { handleRequest, server, runTickerCycle: tickerCycle };
