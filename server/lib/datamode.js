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
//   2. process.env.DATA_MODE — .env / Vercel dashboard (prod default: live)
//   3. 'demo'               — safe default for local dev
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

// mode(tx): settings.data_mode -> env DATA_MODE -> 'demo'
function mode(tx) {
  const s = tx.get(`SELECT value FROM settings WHERE key='data_mode'`)?.value;
  if (s === LIVE || s === DEMO) return s;
  return String(process.env.DATA_MODE || '').toLowerCase() === LIVE ? LIVE : DEMO;
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

module.exports = { LIVE, DEMO, SEED, EMPTY, mode, isLive, leadNotDemo, dealNotDemo, spendNotDemo, metaNotDemo, webhookNotDemo, setDataMode,
  // thin boolean wrappers: pass `live` (bool) instead of the mode string
  liveLeadEx(live, al) { return live ? leadNotDemo(LIVE, al) : ''; },
  liveDealEx(live, al) { return live ? dealNotDemo(LIVE, al) : ''; },
  liveSpendEx(live, al) { return live ? spendNotDemo(LIVE, al) : ''; },
  liveMetaEx(live, al) { return live ? metaNotDemo(LIVE, al) : ''; },
  liveWebhookEx(live, al) { return live ? webhookNotDemo(LIVE, al) : ''; },
};
