// Seed demo data: 2 clients, ad accounts, campaigns, a rich set of leads,
// deals, touchpoints, events, Meta entities + spend, CAPI log, webhook log,
// duplicates, notes/tasks — so EVERY screen has numbers on a fresh open.
// Real payloads are NOT included (privacy rule: never paste client data).
// Idempotent: every block is guarded, re-running the seed adds nothing.
const { open, makeTx, alignSequences } = require('../server/db');
const { hashPassword } = require('../server/lib/auth');
const { DEFAULT_STAGES } = require('../server/lib/shared');
const sec = require('../server/lib/security');
const crypto = require('node:crypto');

const dbHandle = open();
const tx = makeTx(dbHandle);
// S.2: all secrets are encrypted at rest. The demo uses the shared dev master
// key (flagged insecure); production sets XACQORA_SECRET_KEY.
const enc = (v) => sec.encryptSecret(v);

// deterministic pseudo-random (stable across engines/locales; Math.sin spec).
// Used to jitter spend/clicks so charts look organic but a re-seed on a wiped
// db produces identical numbers (both engines see the same fixture).
function rnd(seed) { const x = Math.sin(seed * 997.3) * 10000; return x - Math.floor(x); }
function isha(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

function seedAll() {
  const now = new Date().toISOString();
  const day = (h) => new Date(Date.now() - h * 3600000).toISOString();

  // workspace + clients
  if (!tx.get(`SELECT id FROM workspace WHERE id=1`)) {
    tx.run(`INSERT INTO workspace (id, name, plan) VALUES (1,'Foremost Leads','internal')`);
  }
  const clients = [
    [1, 1, 'Coach Ravi — Webinar Funnel', 'INR', 'Asia/Kolkata', 4999],
    [2, 1, 'Kaya Coach — Workshop', 'INR', 'Asia/Kolkata', 9999],
  ];
  for (const c of clients) if (!tx.get(`SELECT id FROM client WHERE id=?`, c[0]))
    tx.run(`INSERT INTO client (id, workspace_id, name, currency, timezone, offer_price) VALUES (?,?,?,?,?,?)`, ...c);

  // funnels + stages
  for (const cid of [1, 2]) {
    if (!tx.get(`SELECT id FROM funnel WHERE client_id=?`, cid)) {
      const info = tx.run(`INSERT INTO funnel (client_id, name, type) VALUES (?,?,?) RETURNING id`, cid, cid === 1 ? 'Main webinar' : 'Workshop', 'webinar');
      const fid = Number(info.lastInsertRowid);
      DEFAULT_STAGES.forEach((s, i) => tx.run(`INSERT INTO funnel_stage (funnel_id, name, sort_order) VALUES (?,?,?)`, fid, s, i));
    }
  }

  // meta ad accounts (token stored ENCRYPTED; 'MOCK' sentinel stays plain so
  // the mock path still triggers — meta.js treats a non-MOCK value as live)
  if (!tx.get(`SELECT id FROM meta_ad_account WHERE id=1`)) {
    tx.run(`INSERT INTO meta_ad_account (id, client_id, name, ad_account_id, token, pixel_id, status, last_pull_at) VALUES
      (1,1,'Coach Ravi — main','ACT-100001',?,'PIXEL-1001','connected',?)`, enc('MOCK'), now);
    tx.run(`INSERT INTO meta_ad_account (id, client_id, name, ad_account_id, token, pixel_id, status, last_pull_at) VALUES
      (2,2,'Kaya — workshop','ACT-100002',?,'PIXEL-1002','connected',?)`, enc('MOCK'), now);
    // account 3: a connected prospecting account with a recent failed pull so
    // /health + the Alerts screen show a Meta-pull-failure signal on open.
    tx.run(`INSERT INTO meta_ad_account (id, client_id, name, ad_account_id, token, pixel_id, status, auto_pull, last_pull_at, last_error) VALUES
      (3,2,'Kaya — prospecting','ACT-100003',?,'PIXEL-1003','connected',1,?,?)`,
      enc('MOCK'), day(2), 'live pull failed: token expired (401)');
  }

  // fx rate
  if (!tx.get(`SELECT date FROM fx_rate WHERE date=?`, now.slice(0, 10))) {
    tx.run(`INSERT INTO fx_rate (date, currency, inr_per_unit) VALUES (?,?,1)`, now.slice(0, 10), 'INR');
  }

  // users
  const users = [
    [1, 'owner@xacqora.local', 'Owner', 'owner', ''],
    [2, 'arpit@xacqora.local', 'Arpit', 'media_buyer', ''],
    [3, 'rep@xacqora.local', 'Sales Rep', 'sales_rep', ''],
    [4, 'client@xacqora.local', 'Client Login', 'client', '1'],
  ];
  const hp = hashPassword('xacqora');
  for (const u of users) {
    if (!tx.get(`SELECT id FROM user WHERE id=?`, u[0])) {
      tx.run(`INSERT INTO user (id, email, name, password_hash, role, client_ids) VALUES (?,?,?,?,?,?)`,
        u[0], u[1], u[2], hp, u[3], u[4]);
    }
  }

  // CAPI settings (client 1 + client 2 push all demo event types)
  if (!tx.get(`SELECT id FROM capi_setting WHERE id=1`))
    tx.run(`INSERT INTO capi_setting (id, client_id, pixel_id, event_types) VALUES
      (1, 1, 'PIXEL-1001', ?)`, JSON.stringify(['CompleteRegistration', 'Attended', 'Schedule', 'Purchase']));
  if (!tx.get(`SELECT id FROM capi_setting WHERE id=2`))
    tx.run(`INSERT INTO capi_setting (id, client_id, pixel_id, event_types) VALUES
      (2, 2, 'PIXEL-1002', ?)`, JSON.stringify(['CompleteRegistration', 'Attended', 'Schedule', 'Purchase']));

  // webhook endpoints (secret stored ENCRYPTED; index.js decrypts on read)
  const epList = [
    [1, 'meta_leadgen'], [1, 'razorpay'], [1, 'aevent'], [1, 'calendly'], [1, 'whatsapp'],
    [2, 'meta_leadgen'], [2, 'cashfree'], [2, 'zoom'],
  ];
  for (const [cid, p] of epList) {
    if (!tx.get(`SELECT id FROM webhook_endpoint WHERE platform=? AND client_id=?`, p, cid)) {
      tx.run(`INSERT INTO webhook_endpoint (client_id, platform, url, secret) VALUES (?, ?, ?, ?)`,
        cid, p, 'https://xacqora.local/api/ingest/' + p, enc('sec-' + p));
    }
  }

  // ----------------------------------------------------------------
  // Core demo leads (the canonical four, swept by test/sweep.sh:
  // masking + isolation checks key off 101/102/103/104).
  const coreLeads = [
    [101, 1, '+919812345678', 'ravi@example.com', 'Ravi', 'Mumbai', 'Sales Rep', 'Paid'],
    [102, 1, '+919822233344', 'meera@example.com', 'Meera', 'Delhi', null, 'Attended'],
    [103, 2, '+919777788899', 'karan@example.com', 'Karan', 'Pune', null, 'Paid'],
    [104, 1, null, 'unknown@example.com', null, null, null, 'Registered'],
  ];
  for (const l of coreLeads) if (!tx.get(`SELECT id FROM lead WHERE id=?`, l[0])) {
    tx.run(`INSERT INTO lead (id, client_id, phone, email, name, city, owner, stage) VALUES (?,?,?,?,?,?,?,?)`, ...l);
  }

  // core deals
  if (!tx.get(`SELECT id FROM deal WHERE id=1`)) {
    tx.run(`INSERT INTO deal (id, lead_id, client_id, product, amount, gateway, gateway_txn_id, status, paid_at) VALUES
      (1,101,1,'Webinar + Course',4999,'razorpay','RAZ-1001','success',?)`, now);
    tx.run(`INSERT INTO deal (id, lead_id, client_id, product, amount, gateway, gateway_txn_id, status, paid_at) VALUES
      (2,103,2,'Workshop',9999,'cashfree','CF-2001','success',?)`, now);
  }

  // CAPI dry-run flag + default attribution settings
  if (!tx.get(`SELECT key FROM settings WHERE key='capi'`))
    tx.run(`INSERT INTO settings (key, value) VALUES ('capi','dry')`);
  if (!tx.get(`SELECT key FROM settings WHERE key='attribution_model'`))
    tx.run(`INSERT INTO settings (key, value) VALUES ('attribution_model','last_paid_click')`);
  if (!tx.get(`SELECT key FROM settings WHERE key='attribution_window_days'`))
    tx.run(`INSERT INTO settings (key, value) VALUES ('attribution_window_days','30')`);
  if (!tx.get(`SELECT key FROM settings WHERE key='wasted_spend_threshold'`))
    tx.run(`INSERT INTO settings (key, value) VALUES ('wasted_spend_threshold','5000')`);

  // ----------------------------------------------------------------
  // Phase F — rich demo population (guarded on lead 105): 22 more leads
  // across every stage, deals (incl. refunds + a failed payment), ad-click
  // touchpoints, Meta entities + 14 days of spend (so the Meta hub and
  // Reports show numbers with zero pulls), CAPI log, webhook log,
  // duplicates, notes/tasks. Deterministic (rnd) so both engines agree.
  if (tx.get(`SELECT 1 c FROM lead WHERE id=105`)) {
    console.log('Demo data already seeded; skipping enrichment.');
    return;
  }

  const ev = (leadId, type, ts, platform, value, sourceRef) => tx.run(
    `INSERT INTO event (lead_id, type, source_platform, source_ref, value, ts) VALUES (?,?,?,?,?,?) RETURNING id`,
    leadId, type, platform, sourceRef || null, value != null ? value : null, ts);
  const evId = (r) => Number(r.lastInsertRowid);

  // ---- ad universe. Entity ids are '<ad_account_id>-<suffix>' (matching the
  // mock puller in shared.js): two accounts, each 5 ads across 4 adsets. ----
  const AD = { // adNum -> [adsetSuffix, campaignSuffix, name, status]
    3001: ['111', '101', 'Webinar hook A (video)', 'ACTIVE'],
    3002: ['111', '101', 'Webinar hook B (creative)', 'ACTIVE'],
    3003: ['112', '101', 'Webinar retarget', 'ACTIVE'],
    4001: ['121', '102', 'Workshop offer 1', 'ACTIVE'],
    4002: ['122', '102', 'Workshop offer 2', 'PAUSED'],
  };
  const ACC = [ // [client, ad_account_id, name]
    [1, 'ACT-100001', 'Coach Ravi — main'],
    [2, 'ACT-100002', 'Kaya — workshop'],
  ];
  const adId = (acc, n) => acc + '-' + n;               // e.g. ACT-100001-3001
  const adsetOfNum = (n) => AD[n][0];
  const campOfNum = (n) => AD[n][1];

  // ---- leads 105-126 (client 1: 105-117, client 2: 118-126) ----
  const demoLeads = [
    // id, client, phone, email, name, city, owner, stage
    [105, 1, '+919811000105', 'ananya@example.com', 'Ananya', 'Bengaluru', 'Sales Rep', 'Paid'],
    [106, 1, '+919811000106', 'rahul@example.com', 'Rahul', 'Chennai', 'Arpit', 'Hot'],
    [107, 1, '+919811000107', 'priya@example.com', 'Priya', 'Kolkata', null, 'New'],
    [108, 1, '+919811000108', 'arjun@example.com', 'Arjun', 'Hyderabad', null, 'New'],
    [109, 1, '+919811000109', 'sneha@example.com', 'Sneha', 'Mumbai', 'Sales Rep', 'Call Booked'],
    [110, 1, '+919811000110', 'vikram@example.com', 'Vikram', 'Delhi', 'Arpit', 'Lost'],
    [111, 1, '+919811000111', 'devika@example.com', 'Devika', 'Pune', null, 'Registered'],
    [112, 1, '+919811000112', 'karanm@example.com', 'Karan M', 'Jaipur', 'Sales Rep', 'Lost'],
    [113, 1, '+919811000113', 'farah@example.com', 'Farah', 'Ahmedabad', 'Arpit', 'Attended'],
    [114, 1, '+919811000114', 'ishaan@example.com', 'Ishaan', 'Indore', null, 'New'],
    [115, 1, '+919811000115', 'ritika@example.com', 'Ritika', 'Surat', 'Sales Rep', 'Hot'],
    [116, 1, '+919811000116', 'sameer@example.com', 'Sameer', 'Nagpur', 'Arpit', 'Paid'],
    [117, 1, '+919811000117', 'zoya@example.com', 'Zoya', 'Lucknow', null, 'Attended'],
    [118, 2, '+919830000118', 'aditya@example.com', 'Aditya', 'Mumbai', 'Sales Rep', 'Paid'],
    [119, 2, '+919830000119', 'pooja@example.com', 'Pooja', 'Gurgaon', null, 'Paid'],
    [120, 2, '+919830000120', 'rohan@example.com', 'Rohan', 'Noida', 'Arpit', 'New'],
    [121, 2, null, null, null, null, null, 'New'], // no phone/email: Organic / unknown bucket
    [122, 2, '+919830000122', 'neha@example.com', 'Neha', 'Faridabad', null, 'Registered'],
    [123, 2, '+919830000123', 'aman@example.com', 'Aman', 'Kanpur', 'Sales Rep', 'Attended'],
    [124, 2, '+919830000124', 'sana@example.com', 'Sana', 'Agra', 'Arpit', 'Paid'],
    [125, 2, '+919830000125', 'varun.k@example.com', 'Varun', 'Prayagraj', null, 'Call Booked'],
    [126, 2, '+919830000126', 'varun.k@example.com', 'Varun K', 'Prayagraj', null, 'Lost'], // same email, diff phone -> duplicate
  ];
  for (const l of demoLeads) if (!tx.get(`SELECT id FROM lead WHERE id=?`, l[0]))
    tx.run(`INSERT INTO lead (id, client_id, phone, email, name, city, owner, stage) VALUES (?,?,?,?,?,?,?,?)`, ...l);
  tx.run(`UPDATE lead SET source_unknown=1 WHERE id=121`);

  // ---- deals (explicit ids; alignSequences re-points the SERIAL after) ----
  const deals = [
    // id, lead, client, product, amount, gateway, txn, status, paid_at, refunded_at
    [3, 105, 1, 'Webinar + Course', 4999, 'razorpay', 'RAZ-3003', 'success', day(30), null],
    [4, 112, 1, 'Webinar + Course', 4999, 'razorpay', 'RAZ-4004', 'refunded', day(50), day(40)],
    [5, 116, 1, 'Webinar + Course', 4999, 'cashfree', 'CF-5005', 'success', day(10), null],
    [6, 118, 2, 'Workshop', 9999, 'razorpay', 'RAZ-6006', 'success', day(45), null],
    [7, 119, 2, 'Workshop', 9999, 'cashfree', 'CF-7007', 'success', day(25), null],
    [8, 124, 2, 'Workshop', 9999, 'razorpay', 'RAZ-8008', 'success', day(8), null],
    [9, 110, 1, 'Webinar + Course', 4999, 'razorpay', 'RAZ-9009', 'failed', day(20), null], // payment_failed (no revenue)
    [10, 126, 2, 'Workshop', 9999, 'razorpay', 'RAZ-10010', 'refunded', day(60), day(55)],
  ];
  for (const d of deals) if (!tx.get(`SELECT id FROM deal WHERE id=?`, d[0]))
    tx.run(`INSERT INTO deal (id, lead_id, client_id, product, amount, gateway, gateway_txn_id, status, paid_at, refunded_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, ...d);

  // ---- Meta entities: campaigns, adsets, ads for BOTH accounts (upserts) ----
  for (const [cid, acc, accName] of ACC) {
    for (const c of [101, 102])
      tx.run(`INSERT INTO meta_campaign (id, ad_account_id, name, status, object_type) VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO NOTHING`, acc + '-' + c, acc, c === 101 ? 'LeadGen Webinar' : 'Workshop Cold Reach', 'ACTIVE', 'campaign');
    for (const s of [['111', '101', 'Webinar — lookalike'], ['112', '101', 'Webinar — retargeting'], ['121', '102', 'Workshop — cold'], ['122', '102', 'Workshop — cold 2']])
      tx.run(`INSERT INTO meta_adset (id, ad_account_id, campaign_id, name, status) VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO NOTHING`, acc + '-' + s[0], acc, acc + '-' + s[1], s[2], 'ACTIVE');
    for (const n of Object.keys(AD))
      tx.run(`INSERT INTO meta_ad (id, ad_account_id, adset_id, name, status, creative_img) VALUES (?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, status=excluded.status, creative_img=excluded.creative_img`,
        adId(acc, n), acc, acc + '-' + adsetOfNum(n), AD[n][2], AD[n][3], 'CR-' + n);
  }

  // ---- 14 days of spend per ad (INR, fx 1:1). Deterministic; tuned so:
  //   * every ad has spend (charts populated with zero pulls),
  //   * ACT-100002 ad 3002 (Webinar hook B) is the single wasted ad
  //     (spend ≥ 5000 threshold, 0 attributed sales),
  //   * overall ROAS ≈ 1.4 (revenue 54,993 net of refunds).
  const S_BY_AD = { 3001: 1000, 3002: 500, 3003: 600, 4001: 450, 4002: 250 };   // client 1
  const S_BY_AD2 = { 3001: 200, 3002: 950, 3003: 250, 4001: 900, 4002: 600 };   // client 2
  const today = new Date();
  for (let d = 13; d >= 0; d--) {
    const date = new Date(today.getTime() - d * 86400000).toISOString().slice(0, 10);
    for (const [i, [cid, acc]] of ACC.entries()) {
      const perAd = i === 0 ? S_BY_AD : S_BY_AD2;
      for (const n of Object.keys(perAd)) {
        const seed = Number(acc.slice(-6)) + Number(n) + d;
        const spendInr = Math.round(perAd[n] * (0.85 + rnd(seed) * 0.4));
        const clicks = Math.round(40 + rnd(seed + 1) * 200);
        const imp = Math.round(clicks * (25 + rnd(seed + 2) * 20));
        const conv = Math.max(0, Math.round(clicks * (0.12 + rnd(seed + 3) * 0.3)));
        tx.run(`INSERT INTO spend_daily (ad_id, date, ad_account_id, spend, spend_inr, impressions, reach, clicks, conversions, currency)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(ad_id, date, ad_account_id) DO UPDATE SET
            spend=excluded.spend, spend_inr=excluded.spend_inr, impressions=excluded.impressions,
            reach=excluded.reach, clicks=excluded.clicks, conversions=excluded.conversions`,
          adId(acc, n), date, acc, spendInr, spendInr, imp, Math.round(imp * 0.7), clicks, conv, 'INR');
      }
    }
  }

  // ---- ad-click touchpoints (last click drives last_paid_click revenue).
  // Attribution design: client1 3001<-105, 3002<-116, 3003<-101;
  // client2 4001<-118,124, 4002<-103,119. 103 has two clicks (last = 4002).
  const TPLAN = [
    // [leadId, client, adNum, hoursAgo, utmCampaign]
    [101, 1, 3001, 90, 'Webinar-Cold'], [101, 1, 3003, 12, 'Webinar-Retarget'],
    [102, 1, 3002, 48, 'Webinar-Cold'],
    [103, 2, 4001, 70, 'Workshop-Cold'], [103, 2, 4002, 30, 'Workshop-Cold2'],
    [105, 1, 3001, 40, 'Webinar-Lookalike'],
    [106, 1, 3003, 30, 'Webinar-Retarget'],
    [109, 1, 3001, 60, 'Webinar-Cold'],
    [111, 1, 3001, 80, 'Webinar-Lookalike'],
    [113, 1, 3003, 45, 'Webinar-Retarget'],
    [115, 1, 3001, 25, 'Webinar-Lookalike'],
    [116, 1, 3002, 9, 'Webinar-Retarget'],
    [118, 2, 4001, 66, 'Workshop-Cold'],
    [119, 2, 4002, 44, 'Workshop-Cold2'],
    [123, 2, 4001, 20, 'Workshop-Cold'],
    [124, 2, 4001, 14, 'Workshop-Cold'],
    [125, 2, 4002, 10, 'Workshop-Cold2'],
  ];
  for (const [lid, cid, adNum, hours, utmc] of TPLAN) {
    const acc = cid === 1 ? 'ACT-100001' : 'ACT-100002';
    tx.run(`INSERT INTO touchpoint (lead_id, ad_id, adset_id, campaign_id, utm_source, utm_medium, utm_campaign, landing_url, ts)
      VALUES (?,?,?,?,?,?,?,?,?)`,
      lid, adId(acc, adNum), acc + '-' + adsetOfNum(adNum), acc + '-' + campOfNum(adNum),
      'facebook', 'paid', utmc, 'https://xacqora.local/funnel/' + utmc.toLowerCase(), day(hours));
  }
  // UTM-only touches (no ad_id): feed the lead_source / first_click models.
  for (const [lid, src, med, camp, h] of [
    [107, 'google', 'cpc', 'Webinar-Google', 72],
    [120, 'whatsapp', 'broadcast', 'Workshop-WA', 36],
    [122, 'google', 'cpc', 'Workshop-Google', 33],
  ])
    tx.run(`INSERT INTO touchpoint (lead_id, utm_source, utm_medium, utm_campaign, landing_url, ts) VALUES (?,?,?,?,?,?)`,
      lid, src, med, camp, 'https://xacqora.local/funnel/' + camp.toLowerCase(), day(h));

  // ---- events per lead (timeline + funnel stages + CAPI sources).
  // Each [type, platform, value, hoursAgo, ref]; a lead may have several.
  const EPLAN = {
    101: [['meta_form_lead', 'meta_leadgen', null, 90, 'mfl101'], ['registered', 'aevent', null, 88, 'reg101'],
          ['webinar_joined', 'aevent', null, 84, 'att101'], ['call_booked', 'calendly', null, 80, 'cb101'],
          ['payment_success', 'razorpay', 4999, 4, 'ps101']],
    102: [['meta_form_lead', 'meta_leadgen', null, 48, 'mfl102'], ['registered', 'aevent', null, 46, 'reg102'],
          ['webinar_joined', 'aevent', null, 20, 'att102']],
    103: [['meta_form_lead', 'meta_leadgen', null, 70, 'mfl103'], ['registered', 'aevent', null, 68, 'reg103'],
          ['webinar_joined', 'zoom', null, 24, 'att103'], ['call_booked', 'calendly', null, 6, 'cb103']],
    104: [['registered', 'aevent', null, 5, 'reg104']],
    105: [['meta_form_lead', 'meta_leadgen', null, 40, 'mfl105'], ['registered', 'aevent', null, 38, 'reg105'],
          ['webinar_joined', 'aevent', null, 32, 'att105'], ['call_booked', 'calendly', null, 28, 'cb105']],
    106: [['meta_form_lead', 'meta_leadgen', null, 30, 'mfl106'], ['registered', 'aevent', null, 28, 'reg106'],
          ['call_booked', 'calendly', null, 12, 'cb106']],
    107: [['registered', 'aevent', null, 60, 'reg107']],
    109: [['meta_form_lead', 'meta_leadgen', null, 60, 'mfl109'], ['registered', 'aevent', null, 58, 'reg109'],
          ['webinar_joined', 'aevent', null, 50, 'att109'], ['call_booked', 'calendly', null, 2, 'cb109']],
    110: [['meta_form_lead', 'meta_leadgen', null, 45, 'mfl110'], ['registered', 'aevent', null, 42, 'reg110'],
          ['webinar_joined', 'aevent', null, 40, 'att110'], ['payment_failed', 'razorpay', 4999, 20, 'pf110']],
    111: [['meta_form_lead', 'meta_leadgen', null, 80, 'mfl111'], ['registered', 'aevent', null, 78, 'reg111']],
    112: [['meta_form_lead', 'meta_leadgen', null, 55, 'mfl112'], ['registered', 'aevent', null, 52, 'reg112'],
          ['payment_success', 'razorpay', 4999, 50, 'ps112'], ['refund', 'razorpay', 4999, 40, 'rf112']],
    113: [['meta_form_lead', 'meta_leadgen', null, 45, 'mfl113'], ['registered', 'aevent', null, 43, 'reg113'],
          ['webinar_joined', 'zoom', null, 41, 'att113']],
    115: [['meta_form_lead', 'meta_leadgen', null, 25, 'mfl115'], ['registered', 'aevent', null, 23, 'reg115']],
    116: [['meta_form_lead', 'meta_leadgen', null, 9, 'mfl116'], ['registered', 'aevent', null, 8, 'reg116'],
          ['call_booked', 'calendly', null, 5, 'cb116']],
    117: [['registered', 'aevent', null, 15, 'reg117'], ['webinar_joined', 'aevent', null, 12, 'att117']],
    118: [['meta_form_lead', 'meta_leadgen', null, 66, 'mfl118'], ['registered', 'aevent', null, 64, 'reg118'],
          ['call_booked', 'calendly', null, 30, 'cb118']],
    119: [['meta_form_lead', 'meta_leadgen', null, 44, 'mfl119'], ['registered', 'aevent', null, 42, 'reg119']],
    122: [['registered', 'aevent', null, 33, 'reg122']],
    123: [['meta_form_lead', 'meta_leadgen', null, 20, 'mfl123'], ['registered', 'aevent', null, 18, 'reg123'],
          ['webinar_joined', 'zoom', null, 16, 'att123']],
    125: [['meta_form_lead', 'meta_leadgen', null, 10, 'mfl125'], ['registered', 'aevent', null, 9, 'reg125'],
          ['call_booked', 'calendly', null, 3, 'cb125']],
    126: [['registered', 'aevent', null, 58, 'reg126']],
  };
  const capiEventIds = [];
  for (const [lid, list] of Object.entries(EPLAN)) {
    for (const [type, platform, value, hours, ref] of list) {
      const r = ev(Number(lid), type, day(hours), platform, value, ref || ('seed-' + lid + type));
      const eid = evId(r);
      if (['registered', 'webinar_joined', 'call_booked', 'payment_success'].includes(type)) capiEventIds.push([eid, Number(lid)]);
    }
  }

  // ---- CAPI log: pre-push the demo events in DRY-RUN (mock CAPI) so the CAPI
  // screen + /health show a populated log + good match quality on open.
  for (const [eid, lid] of capiEventIds) {
    const lead = tx.get(`SELECT * FROM lead WHERE id=?`, lid);
    const row = tx.get(`SELECT * FROM event WHERE id=?`, eid);
    const eventName = { registered: 'CompleteRegistration', webinar_joined: 'Attended', call_booked: 'Schedule', payment_success: 'Purchase' }[row.type];
    const pixel = lead.client_id === 1 ? 'PIXEL-1001' : 'PIXEL-1002';
    const eventId = isha(`capi|${lead.client_id}|${row.type}|${lid}|${eid}`);
    const mq = (lead.phone ? 8 : 4) + (lead.email ? 1 : 0);
    tx.run(`INSERT INTO capi_log (event_row_id, event_name, pixel_id, dry_run, payload, event_id, match_quality, sent_at)
      VALUES (?,?,?,?,?,?,?,?)`,
      eid, eventName, pixel, 1, JSON.stringify({ eventName, event_id: eventId }), eventId, mq, day(1));
    tx.run(`UPDATE event SET sent_to_meta=1, meta_event_id=?, meta_match_quality=? WHERE id=?`, eventId, mq, eid);
  }

  // ---- webhook log: ~30 realistic recent ingests (both clients) + 2 failures
  // inside 24h so /health + the Alerts screen show a webhook-failure signal.
  const WL = [
    ['meta_leadgen', 1, 'processed'], ['razorpay', 1, 'processed'], ['aevent', 1, 'processed'],
    ['calendly', 1, 'processed'], ['whatsapp', 1, 'processed'], ['meta_leadgen', 2, 'processed'],
    ['cashfree', 2, 'processed'], ['zoom', 2, 'processed'],
  ];
  for (let i = 0; i < 30; i++) {
    const [platform, client] = WL[i % WL.length];
    const isTest = i === 13;
    const isFail = i === 7;
    tx.run(`INSERT INTO webhook_log (client_id, platform, ref, dedup_key, status, error, raw, test, ingested_at, processed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`,
      client, platform, platform.slice(0, 3) + Math.floor(rnd(i + 50) * 9000) + 1000, null,
      isFail ? 'failed' : isTest ? 'test' : 'processed',
      isFail ? 'field map: missing phone column' : null,
      JSON.stringify({ seed: true, platform, client_id: client }), isTest ? 1 : 0,
      day(1 + i * 1.7), isTest || isFail ? null : day(1 + i * 1.7 - 0.01));
  }
  tx.run(`INSERT INTO webhook_log (client_id, platform, ref, status, error, raw, test, ingested_at) VALUES (?,?,?,?,?,?,?,?)`,
    1, 'razorpay', 'pay_seedfail1', 'failed', 'signature mismatch', '{"event":"payment.captured"}', 0, day(6));
  tx.run(`INSERT INTO webhook_log (client_id, platform, ref, status, error, raw, test, ingested_at) VALUES (?,?,?,?,?,?,?,?)`,
    2, 'zoom', 'z_seedfail2', 'failed', 'bad secret', '{"event":"meeting.attended"}', 0, day(10));

  // ---- notes / task / call log (lead 101): the timeline shows team activity.
  tx.run(`INSERT INTO note (lead_id, user_name, body, ts) VALUES (?,?,?,?)`, 101, 'Sales Rep', 'Good webinar fit; wants 2x cohort. Quote sent.', day(50));
  tx.run(`INSERT INTO task (lead_id, user_name, type, due_at, outcome, notes, ts) VALUES (?,?,?,?,?,?,?)`,
    118, 'Arpit', 'followup', day(-48), null, 'Call Tue AM IST — renew + upsell', day(20));
  tx.run(`INSERT INTO call_log (lead_id, user_name, outcome, notes, ts) VALUES (?,?,?,?,?)`,
    109, 'Sales Rep', 'connected', 'Rescheduled call to Thursday 6 PM IST.', day(2));

  // ---- audit trail rows (Admin screen populated on open).
  const audit = [
    ['system', 'seed.demo', 'lead', null, 'Phase F demo dataset (26 leads, 8 deals, 10 ads)'],
    ['owner@xacqora.local', 'settings.update', 'settings', null, 'attribution_model=last_paid_click window=30'],
    ['owner@xacqora.local', 'export.csv', 'leads', null, 'leads (26 rows)'],
    ['arpit@xacqora.local', 'meta.pull', 'ad_account', '1', 'ACT-100001 mock pull'],
    ['client@xacqora.local', 'export.csv', 'report/funnel', null, 'client 1 funnel export'],
  ];
  audit.forEach((a2, i) => tx.run(
    `INSERT INTO audit_log (user_email, action, entity, entity_id, detail, ts) VALUES (?,?,?,?,?,?)`,
    ...a2, day(1 + i)));

  console.log('Seeded Phase F demo data: +22 leads, 8 deals (incl. refunds), Meta entities + 14d spend, CAPI + webhook log, duplicates, notes/tasks.');
}

seedAll();
// Postgres: the seed used explicit ids, so re-point every SERIAL sequence
// past its max(id) — the first auto-id insert (a webhook deal) must continue
// after them, not collide with deal_pkey. No-op on SQLite.
alignSequences(dbHandle);
console.log('Done. UI: ' + (process.env.PORT ? 'http://localhost:' + process.env.PORT : 'http://localhost:4100') + '/signin');
