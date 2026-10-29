// Seed demo data: 2 clients, ad accounts, campaigns, a few leads,
// deals, and events so every screen has something to show.
// Real payloads are NOT included (privacy rule: never paste client data).
const { open, makeTx } = require('../server/db');
const { hashPassword, createSession } = require('../server/lib/auth');
const { DEFAULT_STAGES } = require('../server/lib/shared');
const sec = require('../server/lib/security');
const path = require('node:path');

const dbHandle = open();
const tx = makeTx(dbHandle);
// S.2: all secrets are encrypted at rest. The demo uses the shared dev master
// key (flagged insecure); production sets XACQORA_SECRET_KEY.
const enc = (v) => sec.encryptSecret(v);

function seedAll() {
  const now = new Date().toISOString();

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
      const info = tx.run(`INSERT INTO funnel (client_id, name, type) VALUES (?,?,?)`, cid, cid === 1 ? 'Main webinar' : 'Workshop', 'webinar');
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

  // CAPI setting for client 1 (all events)
  if (!tx.get(`SELECT id FROM capi_setting WHERE id=1`)) {
    tx.run(`INSERT INTO capi_setting (id, client_id, pixel_id, event_types) VALUES
      (1, 1, 'PIXEL-1001', ?)`, JSON.stringify(['CompleteRegistration', 'Attended', 'Schedule', 'Purchase']));
  }

  // webhook endpoints (secret stored ENCRYPTED; index.js decrypts on read)
  const platforms = ['meta_leadgen', 'razorpay', 'aevent', 'calendly', 'whatsapp'];
  for (const p of platforms) {
    if (!tx.get(`SELECT id FROM webhook_endpoint WHERE platform=? AND client_id=1`, p)) {
      tx.run(`INSERT INTO webhook_endpoint (client_id, platform, url, secret) VALUES (1, ?, ?, ?)`,
        p, 'https://xacqora.local/api/ingest/' + p, enc('sec-' + p));
    }
  }

  // a few leads
  const leads = [
    [101, 1, '+919812345678', 'ravi@example.com', 'Ravi', 'Mumbai', 'Sales Rep', 'Paid'],
    [102, 1, '+919822233344', 'meera@example.com', 'Meera', 'Delhi', null, 'Attended'],
    [103, 2, '+919777788899', 'karan@example.com', 'Karan', 'Pune', null, 'Call Booked'],
    [104, 1, null, 'unknown@example.com', null, null, null, 'Registered'],
  ];
  for (const l of leads) if (!tx.get(`SELECT id FROM lead WHERE id=?`, l[0])) {
    tx.run(`INSERT INTO lead (id, client_id, phone, email, name, city, owner, stage) VALUES (?,?,?,?,?,?,?,?)`, ...l);
  }

  // deals
  if (!tx.get(`SELECT id FROM deal WHERE id=1`)) {
    tx.run(`INSERT INTO deal (id, lead_id, client_id, product, amount, gateway, gateway_txn_id, status, paid_at) VALUES
      (1,101,1,'Webinar + Course',4999,'razorpay','RAZ-1001','success',?)`, now);
    tx.run(`INSERT INTO deal (id, lead_id, client_id, product, amount, gateway, gateway_txn_id, status, paid_at) VALUES
      (2,103,2,'Workshop',9999,'cashfree','CF-2001','success',?)`, now);
  }

  // CAPI dry-run flag
  if (!tx.get(`SELECT key FROM settings WHERE key='capi'`))
    tx.run(`INSERT INTO settings (key, value) VALUES ('capi','dry')`);
  if (!tx.get(`SELECT key FROM settings WHERE key='attribution_model'`))
    tx.run(`INSERT INTO settings (key, value) VALUES ('attribution_model','last_paid_click')`);
  if (!tx.get(`SELECT key FROM settings WHERE key='attribution_window_days'`))
    tx.run(`INSERT INTO settings (key, value) VALUES ('attribution_window_days','30')`);
  if (!tx.get(`SELECT key FROM settings WHERE key='wasted_spend_threshold'`))
    tx.run(`INSERT INTO settings (key, value) VALUES ('wasted_spend_threshold','5000')`);

  // ----------------------------------------------------------------
  // Enrich the demo leads so the source card and ad-performance revenue
  // attribution have something real to show: ad-click touchpoints + a
  // short timeline each. Only runs once (guarded on the marker event).
  if (!tx.get(`SELECT 1 c FROM event WHERE type='ad_click' LIMIT 1`)) {
      // marker so re-seeding doesn't duplicate the demo touchpoints
    if (tx.get(`SELECT 1 c FROM touchpoint WHERE ad_id IS NOT NULL AND ad_id != '' LIMIT 1`)) {
      console.log('Demo touchpoints already seeded; skipping enrichment.');
      return;
    }
    // ad ids in the mock meta universe
    const a = (n) => 'ACT-100001-' + n, b = (n) => 'ACT-100002-' + n;
    const day = (h) => new Date(Date.now() - h * 3600000).toISOString();
    const tp = (leadId, adId, ts, adset, campaign, utmc) => tx.run(
      `INSERT INTO touchpoint (lead_id, ad_id, adset_id, campaign_id, utm_source, utm_medium, utm_campaign, landing_url, ts)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      leadId, adId, adset, campaign, 'facebook', 'paid', utmc, 'https://example.com/funnel', ts);
    const ev = (leadId, type, ts, platform, value) => tx.run(
      `INSERT INTO event (lead_id, type, source_platform, raw_payload, value, ts) VALUES (?,?,?,?,?,?)`,
      leadId, type, platform, null, value || null, ts);

    // Lead 101 (Ravi, Paid): clicked 2 ads, registered, attended, paid
    tp(101, a('3001'), day(90), 'ACT-100001-111', 'ACT-100001-101', 'Webinar-Cold');
    ev(101, 'meta_form_lead', day(90), 'meta_leadgen');
    tp(101, a('3003'), day(12), 'ACT-100001-112', 'ACT-100001-101', 'Webinar-Retarget');
    ev(101, 'registered', day(88), 'aevent');
    ev(101, 'webinar_joined', day(84), 'aevent');
    ev(101, 'call_booked', day(80), 'calendly');
    ev(101, 'payment_success', now, 'razorpay', 4999);

    // Lead 102 (Meera, Attended): 1 ad click, registered, attended
    tp(102, a('3002'), day(48), 'ACT-100001-111', 'ACT-100001-101', 'Webinar-Cold');
    ev(102, 'meta_form_lead', day(48), 'meta_leadgen');
    ev(102, 'registered', day(46), 'aevent');
    ev(102, 'webinar_joined', day(20), 'aevent');

    // Lead 103 (Karan, Call Booked, client 2): clicked 2 workshop ads
    tp(103, b('4001'), day(70), 'ACT-100002-121', 'ACT-100002-102', 'Workshop-Cold');
    ev(103, 'meta_form_lead', day(70), 'meta_leadgen');
    tp(103, b('4002'), day(30), 'ACT-100002-122', 'ACT-100002-102', 'Workshop-Cold2');
    ev(103, 'registered', day(68), 'aevent');
    ev(103, 'webinar_joined', day(24), 'zoom');
    ev(103, 'call_booked', day(6), 'calendly');
    ev(103, 'payment_success', now, 'cashfree', 9999);

    // Lead 104 (unknown source, Registered): no ad click -> Organic bucket
    ev(104, 'registered', day(5), 'aevent');
  }

  console.log('Seeded demo data (2 clients, 2 ad accounts, 4 leads, users all pw=xacqora).');
}

seedAll();
console.log('Done. UI: ' + (process.env.PORT ? 'http://localhost:' + process.env.PORT : 'http://localhost:4100') + '/signin');
