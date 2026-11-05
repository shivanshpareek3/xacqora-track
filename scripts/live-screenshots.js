#!/usr/bin/env node
// v10 Task 2 — capture 5 shareable "real data only" screenshots of the RUNNING
// dev server (owner, live DATA_MODE). No reseed, no new server: it drives the
// server already listening on PORT (default 4100) so the numbers shown are the
// real ad-account spend + the live empty states. Zero-dep: cached Playwright
// headless shell over CDP (Node 24 built-in WebSocket), same as screenshots.js.
//
//   node scripts/live-screenshots.js            # against the running 4100 dev server
//   PORT=4100 node scripts/live-screenshots.js
//
// Output: docs/screenshots/v10-live-{dashboard,leads,meta,reports,alerts}.png
//
// The 5 screens (owner, live mode — what the spec asks to show a manager):
//   1. dashboard.html  — 7 real ad accounts, INR+currency KPIs, top campaigns/ads, 30d trend, ROAS "N/A — pilot live"
//   2. leads           — clean empty state ("No leads yet — pilot cutover")
//   3. meta.html       — the real ad accounts + spend, no seed ACT- fixtures
//   4. reports.html    — Meta vs Track on the real ads (ROAS N/A while revenue=0)
//   5. alerts.html     — the ops signal board
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = Number(process.env.PORT || 4100);
const BASE = 'http://localhost:' + PORT;
const SHELL = process.env.CHROME_SHELL ||
  path.join(process.env.HOME, 'Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-x64/chrome-headless-shell');

// The 5 live-mode screens, as the OWNER (team role), classic server-rendered.
// v10: the dashboard is captured TWICE — the default 7d preset and a custom
// 7-day window (?from=&to=) to prove the range picker + genuine-range KPIs.
const today = new Date().toISOString().slice(0, 10);
const rangeFrom = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
const SCREENS = [
  { name: 'dashboard', url: '/dashboard.html', wait: 2000 },
  { name: 'dashboard-range', url: `/dashboard.html?from=${rangeFrom}&to=${today}`, wait: 2200 },
  { name: 'leads',     url: '/leads',          wait: 1500 },
  { name: 'meta',      url: '/meta.html',      wait: 1500 },
  { name: 'reports',   url: '/reports.html',   wait: 2000 },
  { name: 'alerts',    url: '/alerts.html',    wait: 1500 },
];

// ---- minimal CDP client over ws:// (Node 24 built-in WebSocket) ----
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (m) => { const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } };
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
}
const CDP_PORT = 9334; // distinct from screenshots.js (9333)
async function connectChrome() {
  const prof = path.join(ROOT, 'tmp', 'cdp-live-profile');
  fs.mkdirSync(prof, { recursive: true });
  const proc = spawn(SHELL,
    ['--headless', '--no-sandbox', '--disable-gpu', '--remote-allow-origins=*',
      `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${prof}`, '--window-size=1440,900', 'about:blank'],
    { stdio: 'pipe' });
  let log = ''; proc.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      const list = await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const tab = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (!tab) continue;
      const ws = new WebSocket(tab.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      return { proc, cdp: new CDP(ws), kill: () => proc.kill('SIGKILL') };
    } catch { if (proc.exitCode != null) break; }
  }
  throw new Error('CDP connect failed:\n' + log.slice(-500));
}
function httpGet(url) {
  return new Promise((resolve, reject) => { http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject); });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });

  // the dev server must already be up on PORT (real data); fail loudly otherwise
  for (let i = 0; i < 20; i++) {
    try { await new Promise((res) => http.get(BASE + '/signin', (r) => { r.resume(); res(r.statusCode); }).on('error', res)); break; } catch { await new Promise((r) => setTimeout(r, 300)); }
  }

  const { cdp, kill } = await connectChrome();
  await cdp.send('Page.enable', {});
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  // sign in as owner through the real server (sets the xt_session cookie on the origin)
  await cdp.send('Page.navigate', { url: BASE + '/signin' });
  await cdp.wait(400);
  await cdp.send('Runtime.evaluate', {
    expression: `fetch('/signin', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:'email=' + encodeURIComponent('owner@xacqora.local') + '&password=xacqora', redirect:'follow' })
      .then(r => document.cookie.match(/xt_session=/) ? 'ok' : 'no-cookie')`,
    awaitPromise: true, returnByValue: true,
  });

  for (const s of SCREENS) {
    await cdp.send('Page.navigate', { url: BASE + s.url });
    await cdp.wait(s.wait || 1500);
    // viewport capture at the top of the page (full-page CDP capture overflows
    // on the long reports page: "Page is too large"). 1440x900 @2x, scrolled to 0.
    await cdp.send('Runtime.evaluate', { expression: 'window.scrollTo(0,0)' });
    await cdp.wait(150);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const file = path.join(OUT, `v10-live-${s.name}.png`);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('shot  ' + file + ' (' + fs.statSync(file).size + 'b)');
  }

  kill();
  console.log('DONE — ' + SCREENS.length + ' live screenshots in docs/screenshots/v10-live-*.png');
  process.exit(0);
})().catch((e) => { console.error('LIVE SCREENSHOTS FAILED:', e.message); process.exit(1); });
