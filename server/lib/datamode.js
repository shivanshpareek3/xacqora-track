// DATA_MODE — demo vs live data switching (Master v9 Task 2).
//
// Two data populations live in the same DB:
//   * demo  — the seed fixture (scripts/seed.js): demo leads/deals, the
//             ACT-1000xx mock ad accounts and their spend, test webhook rows.
//   * live  — real rows: the operator's Meta ad accounts (act_…) pulled by
//             the ticker, gateway webhooks (leads/deals with auto ids).
//
// DATA_MODE=live hides every demo row from the screens (clean empty states
// instead); demo (the safe default) shows both, with the yellow demo band.
//
// Resolution order (first present wins):
//   1. settings.data_mode   — the admin toggle (POST /admin/data-mode, audited)
//   2. process.env.DATA_MODE — .env / Vercel dashboard (v11: live default)
//   3. 'live'               — v11: when neither is set the app is live-only.
//                              Demo (seed data) is opt-in, via .env DATA_MODE=demo
//                              or the admin toggle, and is never the default.
//
// The demo predicates key off the seed's OWN conventions (explicit lead ids
// 101–126, deal ids 1–10, `ACT-…` ad-account + entity ids, seed webhook refs)
// — never off ranges of auto-generated ids — so real gateway rows are never
// excluded. All helpers return '' in demo mode: every screen appends the
// clause, so demo-mode SQL is byte-identical to before the feature.
const LIVE = 'live', DEMO = 'demo';

// Seed conventions (scripts/seed.js) — the single source of truth for the filters.
const SEED = {
  leadIds: [101, 126],        // explicit-id demo leads (seed.js coreLeads + demoLeads)
  dealIds: [1, 10],           // explicit-id demo deals (core + enrichment blocks)
  metaPrefix: 'ACT-',         // demo meta ad accounts; their entity ids are `ACT-…-…`
  webhookRef: 'pay_seedfail', // demo webhook_log failure refs
  webhookRaw: '{"seed":true', // demo webhook_log payloads
};

// Empty-state copy for live mode (professional, one line + CTA).
const EMPTY = {
  leads: 'No leads yet — your first lead lands when the Meta Instant Form webhook goes live (pilot cutover). Ad spend below is already real.',
  revenue: 'No revenue yet — attribution runs on gateway payments (Razorpay/Cashfree webhooks), which switch on at pilot cutover.',
};

// mode(tx): settings.data_mode -> env DATA_MODE -> 'live' (v11 default).
// Explicitly setting demo (env or the admin toggle) is the only way to see
// seed data; an unset env no longer falls back to demo.
function mode(tx) {
  const s = tx.get(`SELECT value FROM settings WHERE key='data_mode'`)?.value;
  if (s === LIVE || s === DEMO) return s;
  const env = String(process.env.DATA_MODE || '').toLowerCase();
  return env === DEMO ? DEMO : LIVE;
}
function isLive(tx) { return mode(tx) === LIVE; }

// Admin toggle (POST /admin/data-mode): 'demo' | 'live' | 'default' (delete the
// row so the env/default wins). Pure settings write; the route audits.
function setDataMode(tx, value) {
  if (value === 'default') {
    tx.run(`DELETE FROM settings WHERE key='data_mode'`);
    return 'default';
  }
  if (value === LIVE || value === DEMO) {
    tx.run(`INSERT INTO settings (key, value) VALUES ('data_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, value);
    return value;
  }
  return 'invalid';
}

// Per-table NOT-predicates for live mode ('' in demo). `al` = the table alias
// (or '' for unqualified). Screens call mode(tx) once, then append e.g.
//   const ex = { lead: dm.leadNotDemo(m, 'l'), spend: dm.spendNotDemo(m, 's') };
//   `... WHERE l.client_id IN (…) AND ${ex.lead}`
function leadNotDemo(m, al = 'l') {
  if (m !== LIVE) return '';
  return `NOT (${al}.id BETWEEN ${SEED.leadIds[0]} AND ${SEED.leadIds[1]})`;
}
function dealNotDemo(m, al = 'd') {
  if (m !== LIVE) return '';
  return `NOT (${al}.id BETWEEN ${SEED.dealIds[0]} AND ${SEED.dealIds[1]})`;
}
// spend_daily: demo rows carry the demo account AND demo ad ids (both ACT-%)
function spendNotDemo(m, al = 's') {
  if (m !== LIVE) return '';
  return `NOT (${al}.ad_account_id LIKE '${SEED.metaPrefix}%' AND ${al}.ad_id LIKE '${SEED.metaPrefix}%')`;
}
// meta_ad_account / meta_campaign / meta_adset / meta_ad share ad_account_id
function metaNotDemo(m, al = '') {
  if (m !== LIVE) return '';
  const p = al ? `${al}.` : '';
  return `NOT (${p}ad_account_id LIKE '${SEED.metaPrefix}%')`;
}
// webhook_log: the seed's 30 test rows + 2 failure rows
function webhookNotDemo(m, al = 'w') {
  if (m !== LIVE) return '';
  const p = al ? `${al}.` : '';
  return `NOT (${p}ref LIKE '${SEED.webhookRef}%' OR ${p}raw LIKE '${SEED.webhookRaw}%' OR ${p}test=1)`;
}
// v11: whole-CLIENT demo hiding. Seed clients are marked `client.demo=1`, so in
// live mode every row that belongs to a demo client is hidden — not just the
// seed lead/deal ids, but that client's ad accounts + their spend_daily rows
// too. Keyed off the `client.demo` flag, never off auto-ids, so a real client
// is never excluded. `al` = table alias with its own client_id (lead/deal/
// meta_ad_account); spend_daily has no client_id, so it is excluded through the
// account's client (spendClientNotDemo).
function clientNotDemo(m, al = 'l') {
  if (m !== LIVE) return '';
  const p = al ? `${al}.` : '';
  return `NOT EXISTS (SELECT 1 FROM client c WHERE c.id=${p}client_id AND c.demo=1)`;
}
function spendClientNotDemo(m, al = 's') {
  if (m !== LIVE) return '';
  const p = al ? `${al}.` : '';
  return `NOT EXISTS (SELECT 1 FROM meta_ad_account ma JOIN client c ON c.id=ma.client_id WHERE ma.ad_account_id=${p}ad_account_id AND c.demo=1)`;
}
// v11 combined live predicates: the seed-convention row filter PLUS the whole
// client.demo=1 hiding, in one clause per table. These are what the screens
// append (so demo mode stays byte-identical: every helper returns '' there).
//   lead / deal -> NOT(seed ids) AND NOT(demo client)
//   spend       -> NOT(seed ACT- rows) AND NOT(demo-client account's spend)
//   meta_ad_account -> NOT(seed ACT- accounts) AND NOT(demo client)
//   meta_* entities (campaign/adset/ad: no client_id column) ->
//                    NOT(seed ACT- entities) AND NOT(demo-client account)
const _and = (parts) => parts.filter(Boolean).join(' AND ');
function leadEx(m, al = 'l') { return m === LIVE ? _and([leadNotDemo(m, al), clientNotDemo(m, al)]) : ''; }
function dealEx(m, al = 'd') { return m === LIVE ? _and([dealNotDemo(m, al), clientNotDemo(m, al)]) : ''; }
function spendEx(m, al = 's') { return m === LIVE ? _and([spendNotDemo(m, al), spendClientNotDemo(m, al)]) : ''; }
function metaAccEx(m, al = 'a') { return m === LIVE ? _and([metaNotDemo(m, al), clientNotDemo(m, al)]) : ''; }
function metaEntityEx(m, al = '') { return m === LIVE ? _and([metaNotDemo(m, al), spendClientNotDemo(m, al)]) : ''; }
function webhookEx(m, al = 'w') { return m === LIVE ? _and([webhookNotDemo(m, al), clientNotDemo(m, al)]) : ''; }

// ids of the clients a caller should show in the switcher: live = the
// non-demo (real) clients within baseScope; demo = every in-scope client.
// baseScope null = team role (all); otherwise the caller's own client ids.
function realClientIds(tx, m, baseScope) {
  const inScope = baseScope && baseScope.length ? `AND c.id IN (${baseScope.map((n) => Number(n)).join(',')})` : '';
  const demoClause = m === LIVE ? `AND (c.demo IS NULL OR c.demo = 0)` : '';
  const rows = tx.all(`SELECT c.id, c.name FROM client c WHERE 1=1 ${inScope} ${demoClause} ORDER BY c.id`);
  return rows.map((r) => Number(r.id));
}
// The client switcher's option list: [{ id, name, is_demo }] within the
// caller's baseScope. Live mode drops the demo-flagged clients entirely
// (their whole dataset is hidden); demo mode lists every in-scope client.
function clientOptions(tx, m, baseScope) {
  const inScope = baseScope && baseScope.length ? `AND c.id IN (${baseScope.map((n) => Number(n)).join(',')})` : '';
  const demoClause = m === LIVE ? `AND (c.demo IS NULL OR c.demo = 0)` : '';
  const rows = tx.all(`SELECT c.id, c.name, c.demo FROM client c WHERE 1=1 ${inScope} ${demoClause} ORDER BY c.id`);
  return rows.map((r) => ({ id: Number(r.id), name: r.name, is_demo: !!Number(r.demo) }));
}

module.exports = { LIVE, DEMO, SEED, EMPTY, mode, isLive, leadNotDemo, dealNotDemo, spendNotDemo, metaNotDemo, webhookNotDemo,
  clientNotDemo, spendClientNotDemo, realClientIds, clientOptions, setDataMode,
  // v11 combined live predicates (seed + whole-client demo hiding).
  leadEx, dealEx, spendEx, metaAccEx, metaEntityEx, webhookEx,
  // thin boolean wrappers: pass `live` (bool) instead of the mode string
  liveLeadEx(live, al) { return live ? leadNotDemo(LIVE, al) : ''; },
  liveDealEx(live, al) { return live ? dealNotDemo(LIVE, al) : ''; },
  liveSpendEx(live, al) { return live ? spendNotDemo(LIVE, al) : ''; },
  liveMetaEx(live, al) { return live ? metaNotDemo(LIVE, al) : ''; },
  liveWebhookEx(live, al) { return live ? webhookNotDemo(LIVE, al) : ''; },
};
