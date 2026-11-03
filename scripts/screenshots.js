// Phase F close-out — capture the 5 pilot SPA screens as PNG.
// Zero-dep: drives the cached Playwright headless Chrome over CDP using Node
// 24's built-in WebSocket. Signs in via the normal /signin form (cookie jar),
// navigates the SPA hash routes, waits for the JSON API to settle, and
// screenshots full page.
//
//   node scripts/screenshots.js            # SQLite (seeds xacqora.sqlite3)
//   DATABASE_URL=... node scripts/screenshots.js   # Postgres
//
// Output: public/test-samples/shot-*.png  (gitignored? no — committed under
// docs/frontend-tour assets dir: ./docs/screenshots/*.png)
const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = Number(process.env.PORT || 4199);
const BASE = 'http://localhost:' + PORT;
const SHELL = process.env.CHROME_SHELL ||
  (path.join(process.env.HOME, 'Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-x64/chrome-headless-shell'));

// ---- minimal CDP client over ws:// (Node 24 built-in WebSocket) ----
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); }
      else if (msg.method) this.events.push(msg);
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
}
const CDP_PORT = 9333;
async function connectChrome() {
  const prof = path.join(ROOT, 'tmp', 'cdp-profile');
  fs.mkdirSync(prof, { recursive: true });
  // --remote-allow-origins=* is REQUIRED since Chrome 111: without it the CDP
  // websocket from a non-chrome origin (our Node process) is refused.
  const proc = spawn(SHELL,
    ['--headless', '--no-sandbox', '--disable-gpu',
      '--remote-allow-origins=*', `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${prof}`, '--window-size=1440,900', 'about:blank'],
    { stdio: 'pipe' });
  let chromeLog = '';
  proc.stderr.on('data', (d) => (chromeLog += d));
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      // page target's websocket (a blank tab already exists from about:blank)
      const list = await httpGet(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const tab = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (!tab) continue;
      const ws = new WebSocket(tab.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      return { proc, cdp: new CDP(ws), kill: () => proc.kill('SIGKILL') };
    } catch { if (proc.exitCode != null) break; }
  }
  console.error('chrome did not open CDP; log:\n' + chromeLog.slice(-500));
  throw new Error('CDP connect failed');
}
function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve(JSON.parse(d))); }).on('error', reject);
  });
}
// server-up probe: any HTTP response (even HTML 200) means the port is live
function rawGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
}
// sign in through the real server: POST /signin, grab xt_session
async function signIn(cdp, email) {
  // drive the SPA signin via the classic form to get the cookie, simpler: fetch /signin GET then POST with the body the server expects
  const body = 'email=' + encodeURIComponent(email) + '&password=xacqora';
  await cdp.send('Runtime.evaluate', {
    expression: `fetch('/signin', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:${JSON.stringify(body)}, redirect:'follow' })
      .then(r => document.cookie.match(/xt_session=/) ? 'ok' : 'no-cookie')`,
    awaitPromise: true, returnByValue: true,
  });
}

const SCREENS = [
  { name: 'dashboard', hash: '#/dashboard', as: 'owner', wait: 1600 },
  { name: 'lead-timeline', hash: '#/lead/101', as: 'owner', wait: 1400 },
  // funnel-report: top-of-page crop of /reports (banner, filters, KPI strip,
  // funnel + chart cards). ad-performance: same route, cropped at the
  // Ad-performance table. CDP clip is document-anchored (CSS px) and does not
  // honor scroll in the headless shell, so both are captured as explicit
  // y-offset slices with captureBeyondViewport — deterministic, no scroll.
  { name: 'funnel-report', hash: '#/reports', as: 'owner', wait: 1800, clip: '0' },
  // ad-performance: the "Spend vs revenue — per ad" dual-bar card (the per-ad
  // performance view) — clip at its document Y so it differs from the top crop.
  { name: 'ad-performance', hash: '#/reports', as: 'owner', wait: 1800,
    clip: "(() => { const t = [...document.querySelectorAll('h2')].find(h => /Spend vs revenue/i.test(h.textContent)); const el = t ? t.parentElement : document.querySelector('main'); const top = el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : 0; return Math.max(0, top - 12); })()" },
  { name: 'client-portal', hash: '#/dashboard', as: 'client', wait: 1600 },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'tmp'), { recursive: true });

  // ensure a seeded db exists on the active engine
  const isPG = !!process.env.DATABASE_URL;
  if (isPG) {
    execSync('node scripts/seed.js', { cwd: ROOT, stdio: 'pipe' });
  } else {
    // fresh scratch db for the screenshot run so charts are deterministic
    execSync('rm -f xacqora.sqlite3 xacqora.sqlite3-wal xacqora.sqlite3-shm && node scripts/seed.js', { cwd: ROOT, stdio: 'pipe' });
  }

  // start the app server
  const server = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), XT_RATE_PER_MIN_IP: '100000' }, stdio: 'pipe' });
  let serverLog = '';
  server.stderr.on('data', (d) => (serverLog += d));
  server.stdout.on('data', (d) => (serverLog += d));
  // wait for the port
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try { const code = await rawGet('http://127.0.0.1:' + PORT + '/signin'); if (code < 500) break; } catch { /* not up yet */ }
  }

  const { cdp, kill } = await connectChrome();
  await cdp.send('Page.enable', {});
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

  let session = null;
  for (const s of SCREENS) {
    const email = s.as === 'client' ? 'client@xacqora.local' : 'owner@xacqora.local';
    if (session !== s.as) {
      // fresh navigation so the /signin cookie state resets per role
      await cdp.send('Page.navigate', { url: BASE + '/signin' });
      await cdp.wait(500);
      await signIn(cdp, email);
      await cdp.send('Page.navigate', { url: BASE + '/app' });
      await cdp.wait(800);
      session = s.as;
    }
    await cdp.send('Runtime.evaluate', { expression: `location.hash = ${JSON.stringify(s.hash)}` });
    await cdp.wait(s.wait || 1200);
    await cdp.wait(250);
    // default: full-page capture. When s.clip is set, captureBeyondViewport +
    // a 1440x900 document slice at a measured CSS-px y-offset (the headless
    // shell's clip is document-anchored and ignores scroll, so we offset the
    // clip itself instead of scrolling).
    let shot;
    if (s.clip != null) {
      // s.clip is a JS expression that evaluates to a CSS-px document Y-offset
      const r = await cdp.send('Runtime.evaluate', { expression: String(s.clip), returnByValue: true });
      const y = Number(r.result && r.result.value != null ? r.result.value : 0);
      shot = { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width: 1440, height: 900, scale: 1 } };
      console.log('   clip y ->', y);
    } else {
      shot = { format: 'png', captureBeyondViewport: true };
    }
    const layout = await cdp.send('Page.captureScreenshot', shot);
    const png = Buffer.from(layout.data, 'base64');
    const file = path.join(OUT, `shot-${s.name}.png`);
    fs.writeFileSync(file, png);
    console.log('shot  ' + file + ' (' + png.length + 'b, ' + s.as + ')');
  }

  kill();
  server.kill('SIGKILL');
  console.log('DONE — ' + SCREENS.length + ' screenshots in docs/screenshots/');
})().catch((e) => { console.error('SCREENSHOTS FAILED:', e.message); console.error(serverLog ? serverLog.slice(-800) : ''); process.exit(1); });
