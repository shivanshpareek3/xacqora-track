/* Xacqora Track — Phase F SPA shared UI: DOM builder, formatters, icons,
   hand-rolled charts (SVG area/donut + HTML bars/funnel), toasts, modal.
   Zero dependencies; loads as a classic script sharing the global scope. */
(function () {
  'use strict';

  // ---------- DOM builder ----------
  const NS = 'http://www.w3.org/2000/svg';
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'selected') el.selected = !!v; // reflects the attribute correctly
      else el.setAttribute(k, v);
    }
    for (const c of kids.flat()) {
      if (c == null || c === false || c === true) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS(NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
    for (const c of kids.flat()) if (c != null) el.append(c);
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  // ---------- formatters (mirror server/lib/shared.js) ----------
  const fmtINR = (n) => (n == null ? '—' : '₹' + Math.round(n).toLocaleString('en-IN'));
  const fmtINRk = (n) => {
    if (n == null) return '—';
    const a = Math.abs(n);
    if (a >= 1e7) return '₹' + (n / 1e7).toFixed(2) + ' Cr';
    if (a >= 1e5) return '₹' + (n / 1e5).toFixed(2) + ' L';
    if (a >= 1e3) return '₹' + (n / 1e3).toFixed(1) + 'k';
    return '₹' + Math.round(n).toLocaleString('en-IN');
  };
  const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
  const fmtPct = (n) => (n == null ? '—' : n + '%');
  function fmtDT(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' IST';
  }
  function relTime(iso) {
    if (!iso) return '';
    const d = new Date(iso).getTime(); if (isNaN(d)) return '';
    const s = Math.max(0, (Date.now() - d) / 1000);
    if (s < 60) return Math.floor(s) + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // deterministic hash for ad thumbnail gradients
  function hashStr(s) { let x = 0; for (let i = 0; i < String(s).length; i++) x = (x * 31 + String(s).charCodeAt(i)) >>> 0; return x; }
  function hueFrom(seed) { return 200 + (hashStr(String(seed)) % 140); } // 200–340 blue→pink

  // ---------- stage colors (shared) ----------
  const STAGE_COLOR = {
    'New': '#38bdf8', 'Registered': '#6d7cff', 'Attended': '#fbbf24', 'Hot': '#fb7185',
    'Call Booked': '#a78bfa', 'Paid': '#34d399', 'Lost': '#6b7594',
  };
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function stagePill(stage) {
    const c = STAGE_COLOR[stage] || '#98a2c0';
    return h('span', { class: 'stg', style: { color: c, background: hexA(c, .12), borderColor: hexA(c, .32) } },
      h('span', { class: 'dot', style: { background: c } }), stage || '—');
  }
  function eventTone(t) {
    return ({ payment_success: 'g', purchase: 'g', refund: 'r', webinar_joined: 'o', call_booked: 'p', registered: 'b', meta_form_lead: 'b', ad_click: 'c', form_submit: 'b', stage_changed: 'm' }[t]) || 'm';
  }

  // ---------- platform icons (colored badge + short label) ----------
  const PLAT = {
    meta_leadgen: ['Meta', 'M', '#6d7cff'], meta: ['Meta', 'M', '#6d7cff'],
    razorpay: ['Razorpay', 'R', '#fb923c'], cashfree: ['Cashfree', 'C', '#38bdf8'],
    cosmofeed: ['Cosmofeed', 'C', '#a78bfa'], aevent: ['Aevent', 'A', '#f472b6'],
    zoom: ['Zoom', 'Z', '#38bdf8'], calendly: ['Calendly', 'C', '#fbbf24'],
    flexifunnels: ['FlexiFunnels', 'F', '#34d399'], pabbly: ['Pabbly', 'P', '#6d7cff'],
    whatsapp: ['WhatsApp', 'W', '#34d399'], google_sheets: ['Sheets', 'S', '#34d399'],
    'xt.js': ['Tracker', 'X', '#2dd4bf'], csv: ['CSV', 'M', '#98a2c0'], auto: ['Auto', 'A', '#98a2c0'],
  };
  function platIcon(name) {
    const [label, letter, color] = PLAT[name] || [(name || '—'), ((name || '?')[0] || '?').toUpperCase(), '#98a2c0'];
    return h('span', { class: 'pb' },
      h('span', { class: 'pbx', style: { background: hexA(color, .16), color, border: `1px solid ${hexA(color, .3)}` }, text: letter }), label);
  }
  function adThumb(seed, name) {
    const hh = hueFrom(seed);
    const gid = 'g' + hashStr(String(seed));
    const g = svg('linearGradient', { id: gid, x1: 0, y1: 0, x2: 1, y2: 1 });
    g.append(svg('stop', { offset: '0%', 'stop-color': `hsl(${hh} 70% 46%)` }));
    g.append(svg('stop', { offset: '100%', 'stop-color': `hsl(${(hh + 50) % 360} 70% 30%)` }));
    const s = svg('svg', { class: 'thumb', viewBox: '0 0 56 56', width: 56, height: 56, 'aria-hidden': 'true' });
    s.append(svg('defs', {}, g));
    s.append(svg('rect', { width: 56, height: 56, rx: 12, fill: `url(#${gid})` }));
    s.append(svg('rect', { width: 56, height: 56, rx: 12, fill: 'rgba(8,10,20,.16)' }));
    s.append(svg('text', { x: 28, y: 35, 'text-anchor': 'middle', 'font-size': 17, 'font-weight': 800, fill: 'rgba(255,255,255,.94)', 'font-family': 'ui-sans-serif,system-ui' }, (name || 'AD').slice(0, 2).toUpperCase()));
    return s;
  }

  // ---------- charts ----------
  function spark(values, color) {
    const w = 92, hh = 30, pad = 2;
    const el = svg('svg', { class: 'spark', width: w, height: hh, viewBox: `0 0 ${w} ${hh}`, 'aria-hidden': 'true' });
    const ids = (values || []).map(Number);
    if (ids.length < 2) { el.append(svg('text', { x: w / 2, y: hh / 2 + 4, 'text-anchor': 'middle', 'font-size': 9, fill: '#6b7594' }, '—')); return el; }
    const min = Math.min(...ids), max = Math.max(...ids), rng = (max - min) || 1;
    const pts = ids.map((v, i) => [pad + (i / (ids.length - 1)) * (w - 2 * pad), hh - pad - ((v - min) / rng) * (hh - 2 * pad)]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    el.append(svg('path', { d: line + ` L${pts[pts.length - 1][0].toFixed(1)} ${hh - pad} L${pts[0][0].toFixed(1)} ${hh - pad} Z`, fill: hexA(color || '#6d7cff', .14) }));
    el.append(svg('path', { d: line, fill: 'none', stroke: color || '#6d7cff', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    const last = pts[pts.length - 1];
    el.append(svg('circle', { cx: last[0], cy: last[1], r: 2.4, fill: color || '#6d7cff' }));
    return el;
  }

  // SVG multi-series area/line chart. series = [{color, points:[{label,y}]}]
  function areaChart(series, opts = {}) {
    const W = opts.width || 640, HH = opts.height || 200, P = { t: 18, r: 16, b: 28, l: 52 };
    const iw = W - P.l - P.r, ih = HH - P.t - P.b;
    const first = series[0];
    if (!first || !first.points || !first.points.length) return null;
    const all = series.flatMap((s) => s.points.map((p) => p.y));
    const min = opts.min != null ? opts.min : Math.min(0, ...all);
    const max = Math.max(...all, 1);
    const rng = (max - min) || 1;
    const n = Math.max(...series.map((s) => s.points.length));
    const X = (i) => P.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
    const Y = (v) => P.t + ih - ((v - min) / rng) * ih;
    const el = svg('svg', { width: '100%', height: HH, viewBox: `0 0 ${W} ${HH}`, preserveAspectRatio: 'none', 'aria-label': opts.title || 'chart', role: 'img' });
    el.style.fontFamily = 'ui-sans-serif, system-ui, sans-serif';
    const defs = svg('defs');
    series.forEach((s, si) => {
      const grad = svg('linearGradient', { id: 'ag' + si + '_' + hashStr(s.color || 'x'), x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.append(svg('stop', { offset: '0%', 'stop-color': s.color || '#6d7cff', 'stop-opacity': .30 }));
      grad.append(svg('stop', { offset: '100%', 'stop-color': s.color || '#6d7cff', 'stop-opacity': 0 }));
      defs.append(grad);
    });
    el.append(defs);
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const v = min + (rng * t) / ticks, yy = Y(v);
      el.append(svg('line', { x1: P.l, y1: yy, x2: W - P.r, y2: yy, stroke: '#1f2639', 'stroke-width': 1 }));
      el.append(svg('text', { x: P.l - 8, y: yy + 3, 'text-anchor': 'end', 'font-size': 9, fill: '#6b7594' }, opts.fmtY ? opts.fmtY(v) : Math.round(v).toLocaleString('en-IN')));
    }
    // x labels from the first series' points
    const labels = first.points.map((p) => p.label).filter((x) => x != null && x !== '');
    const step = Math.max(1, Math.ceil(labels.length / 5));
    labels.forEach((lb, li) => {
      if (li % step !== 0) return;
      const idx = first.points.findIndex((p) => p.label === lb);
      el.append(svg('text', { x: X(idx), y: HH - 8, 'text-anchor': 'middle', 'font-size': 9, fill: '#6b7594' }, lb));
    });
    series.forEach((s, si) => {
      const pts = s.points; if (pts.length < 2) return;
      const line = pts.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.y).toFixed(1)).join(' ');
      if (!s.noArea) el.append(svg('path', { d: line + ` L${X(pts.length - 1).toFixed(1)} ${P.t + ih} L${X(0).toFixed(1)} ${P.t + ih} Z`, fill: `url(#ag${si}_${hashStr(s.color || 'x')})` }));
      el.append(svg('path', { d: line, fill: 'none', stroke: s.color || '#6d7cff', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      el.append(svg('circle', { cx: X(pts.length - 1), cy: Y(pts[pts.length - 1].y), r: 3, fill: s.color || '#6d7cff', stroke: '#0a0d16', 'stroke-width': 2 }));
    });
    return el;
  }

  // SVG donut + legend. segments = [{label, value, color}]
  function donut(segments, opts = {}) {
    const total = segments.reduce((a, s) => a + s.value, 0) || 1;
    const size = opts.size || 184, r = size / 2, ring = opts.thickness || 26, ir = r - ring;
    const cx = r, cy = r;
    const s = svg('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-label': opts.centerLabel || 'chart' });
    s.append(svg('circle', { cx, cy, r: ir, fill: 'none', stroke: '#1f2639', 'stroke-width': ring }));
    let off = -Math.PI / 2;
    segments.forEach((seg) => {
      const frac = seg.value / total; if (frac <= 0) return;
      const a0 = off, a1 = off + frac * 2 * Math.PI; off = a1;
      const large = frac > 0.5 ? 1 : 0;
      const p = (a) => [cx + ir * Math.cos(a), cy + ir * Math.sin(a)];
      const [x0, y0] = p(a0), [x1, y1] = p(a1);
      if (frac >= 1) s.append(svg('circle', { cx, cy, r: ir, fill: 'none', stroke: seg.color, 'stroke-width': ring }));
      else s.append(svg('path', { d: `M${x0.toFixed(2)} ${y0.toFixed(2)} A${ir} ${ir} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`, fill: 'none', stroke: seg.color, 'stroke-width': ring }));
    });
    s.append(svg('text', { x: cx, y: cy - 3, 'text-anchor': 'middle', 'font-size': 28, 'font-weight': 800, fill: '#e9edf8' }, String(opts.centerValue != null ? opts.centerValue : total)));
    s.append(svg('text', { x: cx, y: cy + 15, 'text-anchor': 'middle', 'font-size': 10.5, fill: '#98a2c0' }, opts.centerLabel || ''));
    return h('div', { class: 'donut-wrap' },
      s,
      h('div', { class: 'donut-legend' }, segments.map((seg) => h('div', { class: 'dl' },
        h('span', { class: 'sw', style: { background: seg.color } }),
        h('span', { text: seg.label }), h('span', { class: 'pc', text: Math.round((seg.value / total) * 100) + '%' }),
        h('span', { class: 'n', text: (opts.valueFmt || fmtN)(seg.value) })))))
  }

  // funnel: steps = [{label, value, color}]
  function funnel(steps) {
    const wrap = h('div', { class: 'funnel-chart' });
    const max = Math.max(...steps.map((s) => s.value), 1);
    let prev = null;
    steps.forEach((s, i) => {
      const w = Math.max(4, (s.value / max) * 100);
      const conv = prev ? (prev > 0 ? Math.round((s.value / prev) * 100) + '%' : '—') : '100%';
      wrap.append(h('div', { class: 'fstep' },
        h('div', { class: 'fl' }, s.label),
        h('div', { class: 'ftrack' },
          h('i', { style: { width: w + '%', background: `linear-gradient(90deg, ${s.color}, ${hexA(s.color, .55)})` } }, s.value > 0 ? fmtN(s.value) : ''),
          h('span', { class: 'pct', text: conv })),
        h('div', { class: 'fconv' }, i === 0 ? 'top of funnel' : 'vs previous'),
        h('div', { class: 'fconv', style: { color: '#6b7594' } }, s.hint || '')));
      prev = s.value;
    });
    return wrap;
  }

  // bar track helper: a single horizontal track with an optional inline label
  function barTrack(pct, color, raw, fmt, showLabel) {
    return h('div', { class: 'htrack' },
      h('i', { style: { width: Math.max(2, pct) + '%', background: color, opacity: .92 } },
        showLabel ? h('span', { style: { position: 'absolute', right: 6, top: 0, bottom: 0, display: 'flex', alignItems: 'center', fontSize: 10, fontWeight: 700, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,.55)' } }, (fmt || fmtINRk)(raw)) : null));
  }
  // dual (spend vs revenue) or single horizontal bar list
  function hbars(items, opts = {}) {
    const maxV = Math.max(...items.map((i) => Math.max(i.spend || 0, i.revenue || 0, i.value || 0)), 1);
    const wrap = h('div', { class: 'hbars' });
    items.forEach((it) => {
      let barEl;
      if (opts.dual) {
        barEl = h('div', { class: 'dualbar' },
          barTrack((it.spend || 0) / maxV * 100, '#fb7185', it.spend || 0, opts.fmt, (it.spend || 0) / maxV > .2),
          barTrack((it.revenue || 0) / maxV * 100, '#34d399', it.revenue || 0, opts.fmt, (it.revenue || 0) / maxV > .2));
      } else {
        const v = Math.abs(it.value || 0);
        barEl = barTrack(v / maxV * 100, it.color || '#6d7cff', it.value || 0, opts.fmt, v / maxV > .16);
      }
      wrap.append(h('div', { class: 'hbar-row' },
        h('div', { class: 'hl' }, it.label, it.sub ? h('span', { class: 'sm' }, ' · ' + it.sub) : null),
        barEl,
        h('div', { class: 'hv', style: { color: (opts.valueColor && opts.valueColor(it)) || '#e9edf8' } },
          opts.valueLabel ? opts.valueLabel(it) : (opts.fmt ? opts.fmt(it.value) : String(it.roas != null ? it.roas : '')))));
    });
    return wrap;
  }
  // single-value horizontal bar list (ROAS ranking)
  function vbars(items, opts = {}) {
    const maxV = Math.max(...items.map((i) => Math.abs(i.value || 0)), 1);
    const wrap = h('div', { class: 'hbars' });
    items.forEach((it) => {
      const pct = Math.max(2, (Math.abs(it.value || 0) / maxV) * 100);
      wrap.append(h('div', { class: 'hbar-row' },
        h('div', { class: 'hl' }, it.label, it.sub ? h('span', { class: 'sm' }, ' · ' + it.sub) : null),
        barTrack(pct, it.color || '#6d7cff', it.value || 0, opts.fmt, pct > 18),
        h('div', { class: 'hv', style: { color: (opts.valueColor && opts.valueColor(it)) || '#e9edf8' } }, opts.fmt ? opts.fmt(it.value) : String(it.value))));
    });
    return wrap;
  }

  // ---------- toast + modal ----------
  let toastHost;
  function toast(msg, kind) {
    if (!toastHost) { toastHost = h('div', { id: 'toast-host' }); document.body.append(toastHost); }
    const t = h('div', { class: 'toast ' + (kind || ''), text: msg });
    toastHost.append(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 3200);
    return t;
  }
  function modal(content, onClose) {
    const scrim = h('div', { class: 'modal-scrim' }, h('div', { class: 'modal' }, content));
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
    document.body.append(scrim);
    function close() { scrim.remove(); onClose && onClose(); }
    return close;
  }

  // ---------- line icons ----------
  const I = {
    dash: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
    leads: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    board: '<rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="12" rx="1"/>',
    chart: '<path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 5-5"/>',
    bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7z"/>',
    plug: '<path d="M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0zM12 17v5"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 3v18"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    gate: '<circle cx="12" cy="12" r="9"/><path d="M9 12l2 2 4-4"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.5 12.5 21 2l2 2-4.5 4.5M16 7l3 3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3-8.6A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.6a2 2 0 0 1-.5 2.1L8.1 9.8a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.8.3 1.7.6 2.6.7a2 2 0 0 1 1.7 2z"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
    dollar: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    funnel: '<path d="M4 4h16l-6 8v6l-4 2v-8z"/>',
    layers: '<path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>',
  };
  function icon(name, size) {
    const s = size || 18;
    const el = document.createElement('span');
    el.innerHTML = `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${I[name] || ''}</svg>`;
    return el.firstChild;
  }

  window.XT = { h, svg, clear, fmtINR, fmtINRk, fmtN, fmtPct, fmtDT, relTime, esc, stagePill, eventTone, platIcon, adThumb, spark, areaChart, donut, funnel, hbars, vbars, toast, modal, icon, STAGE_COLOR, hexA };
})();
