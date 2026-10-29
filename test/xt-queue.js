// Proves xt.js survives the API being down: it queues locally in
// localStorage and flushes when the API returns, so no event is lost.
//
// Drives the real public/xt.js in a stubbed browser environment and toggles
// the fake API across three phases (sharing one localStorage, like a tab):
//   1. API up    -> landing touchpoint arrives
//   2. API down  -> events are held in the queue (not lost)
//   3. API up    -> a new page load triggers the queue to flush; held events arrive
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'xt.js'), 'utf8');

let apiUp = true;
const SENT = [];             // events that actually reached the API
const queueStore = {};       // fake localStorage (persists across "page loads")
const cookies = {};          // fake document.cookie

// ---- one shared fake browser world -----------------------------------------
const documentStub = {
  readyState: 'complete',
  referrer: 'http://facebook.com',
  querySelectorAll: () => [],
  addEventListener() {},
  createElement() { return { set type(_) {}, set name(_) {}, set value(_) {} }; },
};
// document.currentScript is read by xt.js; a real load sets it, so keep it.
Object.defineProperty(documentStub, 'currentScript', {
  get() {
    return {
      src: 'http://page/xt.js?c=1',
      getAttribute: (n) => (n === 'data-endpoint' ? 'http://xacqora.local' : null),
    };
  },
});
Object.defineProperty(documentStub, 'cookie', {
  get() { return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; '); },
  set(v) {
    const [pair] = v.split(';');
    const i = pair.indexOf('=');
    cookies[pair.slice(0, i)] = pair.slice(i + 1);
  },
});

globalThis.window = globalThis; // xt.js reads bare `window.location` etc.
globalThis.document = documentStub;
globalThis.location = {
  href: 'http://page/?utm_source=facebook&fbclid=IWD&ad_id=3001&campaign_id=CAM-1',
  origin: 'http://page/',
  hostname: 'page',
  protocol: 'http:',
};
globalThis.navigator = { userAgent: 'XT-Test', sendBeacon: null };
globalThis.crypto = { randomUUID: () => 'uuid-' + Math.random().toString(36).slice(2) };
globalThis.localStorage = {
  getItem: (k) => (k in queueStore ? queueStore[k] : null),
  setItem: (k, v) => { queueStore[k] = v; },
};

// ---- fake fetch: succeeds only while apiUp -----------------------------------
function installFetch() {
  globalThis.fetch = function (url, opts) {
    const u = String(url);
    if (!u.includes('/api/ingest/')) return Promise.resolve({ ok: true });
    if (!apiUp) return Promise.reject(new Error('api down')); // real browser rejects on network error -> event stays queued
    SENT.push(u.split('/api/ingest/')[1]);
    return Promise.resolve({ ok: true });
  };
}
installFetch();

// ---- simulate one page load of the real script ------------------------------
function pageLoad() {
  installFetch();
  // the real IIFE reads the bare globals we set on globalThis above
  new Function(`(function(){ ${src} })();`)();
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const queueLen = () => JSON.parse(queueStore['xt_q_1'] || '[]').length;

(async () => {
  // Phase 1: API up — landing touchpoint should arrive now
  apiUp = true;
  pageLoad();
  await tick(300);
  const p1 = SENT.length;

  // Phase 2: API down — two more loads happen; their events must be held, not lost
  apiUp = false;
  pageLoad(); await tick(300);
  pageLoad(); await tick(300);
  const p2held = queueLen();

  // Phase 3: API back up — the next load's send triggers the queue to flush
  apiUp = true;
  const arrivedAfterDown = SENT.length; // events that survived + flushed
  pageLoad();
  await tick(1200); // queue walks one send at a time (~60ms apart)
  const p3flushed = SENT.length - arrivedAfterDown;
  const p3remaining = queueLen();

  console.log('Phase 1 (API up):   landing arrived now   =', p1, '(expect >=1)');
  console.log('Phase 2 (API down): events held in queue  =', p2held, '(expect >=2, none lost)');
  console.log('Phase 3 (API up):   held events flushed   =', p3flushed, 'queue left =', p3remaining, '(expect left 0)');

  let ok = true;
  if (p1 < 1) { console.log('FAIL: no event arrived while the API was up'); ok = false; }
  if (p2held < 2) { console.log('FAIL: events were not held while the API was down (they would be lost)'); ok = false; }
  if (p3flushed < 2 || p3remaining > 0) { console.log('FAIL: held events did not flush when the API returned'); ok = false; }

  console.log(ok ? '\nPASS - xt.js queues when down, flushes when up, loses nothing.' : '\nFAIL');
  process.exit(ok ? 0 : 1);
})();
