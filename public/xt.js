/*! Xacqora Track (xt.js) — ad-click & funnel tracking, < 10KB.
 *  Paste one line in <head>:
 *    <script src="https://track.xacqora.com/xt.js?c=1" data-endpoint="https://track.xacqora.com" async></script>
 *  c = client id. Works without our server being up: queues and retries.
 */
(function () {
  'use strict';
  var d = document.currentScript || document.querySelector('script[src*="/xt.js"]');
  if (!d) return;
  var qs = new URLSearchParams(d.src.split('?')[1] || '');
  var CLIENT = qs.get('c') || d.getAttribute('data-client') || '';
  var EP = (d.getAttribute('data-endpoint') || 'https://track.xacqora.com').replace(/\/$/, '');
  var COOKIE = 'xt_v' + (CLIENT || 'g');
  var TTL_365D = 365 * 86400 * 1000;

  function readCookie(n) {
    var m = document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)'));
    return m ? m[1] : null;
  }
  function setCookie(n, v) {
    document.cookie = n + '=' + v + ';max-age=' + (TTL_365D / 1000) + ';path=/;SameSite=Lax';
  }
  function guid() {
    try { return crypto.randomUUID().replace(/-/g, ''); } catch (e) {
      return 'xxxxxxxx'.replace(/x/g, function () { return (Math.random() * 16 | 0).toString(16); });
    }
  }

  // 1) read the URL: all UTMs, fbclid, Meta dynamic params
  var url = new URL(window.location.href);
  var P = {};
  ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) {
    if (url.searchParams.get(k)) P[k] = url.searchParams.get(k);
  });
  var fbclid = url.searchParams.get('fbclid');
  if (fbclid) P.fbclid = fbclid;
  ['campaign_id', 'adset_id', 'ad_id'].forEach(function (k) {
    if (url.searchParams.get(k)) P[k] = k === 'ad_id' ? 'AD-' + url.searchParams.get(k) : url.searchParams.get(k);
  });

  // 2) first-party visitor cookie (365 days); create if missing
  var visitorId = readCookie(COOKIE);
  if (!visitorId) { visitorId = guid(); setCookie(COOKIE, visitorId); }

  // 3) fbc from fbclid when missing; read fbp
  var fbc = readCookie('_fbc') || (fbclid ? 'fb.1.' + Date.now() + '.' + fbclid : null);
  if (fbclid && !readCookie('_fbc')) setFbc(fbc);
  function setFbc(v) {
    var host = location.hostname;
    document.cookie = '_fbc=' + v + ';path=/;max-age=' + (2 * 86400000) + ';domain=' + host;
  }
  var fbp = readCookie('_fbp') || null;

  var base = {
    client: CLIENT, visitor_id: visitorId, fbc: fbc, fbp: fbp, fbclid: fbclid,
    referrer: document.referrer || null, device: mobileCheck() ? 'mobile' : 'desktop',
    ua: navigator.userAgent.slice(0, 120)
  };
  function mobileCheck() { return /Mobi|Android|iPhone/i.test(navigator.userAgent); }

  // 4) queue + retry (sendBeacon where available)
  var queue = loadQueue();
  function loadQueue() {
    try { return JSON.parse(localStorage.getItem('xt_q_' + CLIENT) || '[]'); } catch (e) { return []; }
  }
  function saveQueue() {
    try { localStorage.setItem('xt_q_' + CLIENT, JSON.stringify(queue.slice(-50))); } catch (e) {}
  }
  function post(kind, extra) {
    queue.push({ kind: kind, t: Date.now(), p: Object.assign({}, base, extra, P) });
    saveQueue();
    flush(kind);
  }
  var flushing = false;
  function flush(kind) {
    if (flushing) return; flushing = true;
    setTimeout(function () {
      flushing = false;
      var item = queue[0];
      if (!item || item.kind !== kind) return;
      var send = function (body) {
        var req;
        if (navigator.sendBeacon && 'Blob' in window) {
          var blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
          req = navigator.sendBeacon(EP + '/api/ingest/' + kind, blob);
        }
        if (!req) {
          req = fetch(EP + '/api/ingest/' + kind, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body), keepalive: true, mode: 'no-cors'
          }).then(function () { return true; }, function () { return false; });
        }
        Promise.resolve(req).then(function (ok) {
          if (ok) { queue.shift(); saveQueue(); flush(kind); }
        });
      };
      send({ event: item.p });
    }, 60);
  }

  // 5) auto-fill hidden fields in any form on the page
  document.querySelectorAll('form').forEach(function (f) {
    function fill() {
      var fields = {
        xtm_utm_source: P.utm_source, xtm_utm_medium: P.utm_medium, xtm_utm_campaign: P.utm_campaign,
        xtm_utm_content: P.utm_content, xtm_utm_term: P.utm_term,
        xtm_ad_id: P.ad_id, xtm_adset_id: P.adset_id, xtm_campaign_id: P.campaign_id,
        xtm_visitor_id: visitorId, xtm_fbc: fbc, xtm_fbp: fbp, xtm_client: CLIENT
      };
      Object.keys(fields).forEach(function (n) {
        if (fields[n] == null) return;
        if (!f.querySelector('input[name="' + n + '"]')) {
          var i = document.createElement('input');
          i.type = 'hidden'; i.name = n; i.value = fields[n]; f.appendChild(i);
        }
      });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill); else fill();
    f.addEventListener('submit', function () {
      fill();
      post('form_submit', {});
    });
  });

  // 6) append attribution values to outgoing links / checkout buttons
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (!a || !a.href || a.origin !== location.origin) return;
    var u = new URL(a.href);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'visitor_id', 'fbc', 'fbp', 'ad_id', 'adset_id', 'campaign_id', 'xtm_ad_id', 'xtm_campaign_id'].forEach(function (k) {
      if (!u.searchParams.get(k) && P[k]) u.searchParams.set(k, P[k]);
    });
    if (visitorId && !u.searchParams.get('visitor_id')) u.searchParams.set('visitor_id', visitorId);
    a.href = u.toString();
  }, true);

  // 7) send the landing touchpoint
  post('touchpoint', {});
})();
