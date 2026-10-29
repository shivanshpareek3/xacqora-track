-- Xacqora Track schema (SQLite dialect for the demo build; maps 1:1 to Postgres in production)
CREATE TABLE IF NOT EXISTS workspace (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, plan TEXT DEFAULT 'trial'
);
CREATE TABLE IF NOT EXISTS client (
  id INTEGER PRIMARY KEY, workspace_id INTEGER NOT NULL REFERENCES workspace(id),
  name TEXT NOT NULL, currency TEXT DEFAULT 'INR', timezone TEXT DEFAULT 'Asia/Kolkata',
  offer_price REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS funnel (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES client(id),
  name TEXT NOT NULL, type TEXT DEFAULT 'webinar',
  landing_urls TEXT DEFAULT '[]', product_ids TEXT DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS funnel_stage (
  id INTEGER PRIMARY KEY, funnel_id INTEGER NOT NULL REFERENCES funnel(id),
  name TEXT NOT NULL, sort_order INTEGER DEFAULT 0, UNIQUE(funnel_id, name)
);
CREATE TABLE IF NOT EXISTS visitor (
  id TEXT PRIMARY KEY, fbp TEXT, first_seen TEXT, last_seen TEXT
);
CREATE TABLE IF NOT EXISTS lead (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES client(id),
  phone TEXT, email TEXT, name TEXT, city TEXT, owner TEXT,
  stage TEXT DEFAULT 'New', source_unknown INTEGER DEFAULT 0,
  first_touch_id INTEGER, last_touch_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lead_phone ON lead(client_id, phone);
CREATE INDEX IF NOT EXISTS idx_lead_email ON lead(client_id, email);
CREATE INDEX IF NOT EXISTS idx_lead_stage ON lead(client_id, stage);
CREATE TABLE IF NOT EXISTS lead_identity (
  link_type TEXT NOT NULL, link_key TEXT NOT NULL, lead_id INTEGER NOT NULL REFERENCES lead(id),
  UNIQUE(link_type, link_key)
);
CREATE TABLE IF NOT EXISTS touchpoint (
  id INTEGER PRIMARY KEY, lead_id INTEGER, visitor_id TEXT,
  utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, utm_content TEXT, utm_term TEXT,
  campaign_id TEXT, adset_id TEXT, ad_id TEXT, fbclid TEXT, fbc TEXT,
  landing_url TEXT, referrer TEXT, device TEXT, ip TEXT, ua TEXT,
  meta_reported_conversions INTEGER DEFAULT 0,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tp_lead ON touchpoint(lead_id, ts);
CREATE INDEX IF NOT EXISTS idx_tp_visitor ON touchpoint(visitor_id);
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES lead(id),
  type TEXT NOT NULL, source_platform TEXT, source_ref TEXT,
  value REAL, currency TEXT DEFAULT 'INR', raw_payload TEXT,
  sent_to_meta INTEGER DEFAULT 0, meta_event_id TEXT, meta_match_quality INTEGER,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_lead ON event(lead_id, ts);
CREATE INDEX IF NOT EXISTS idx_event_type ON event(type, ts);
CREATE INDEX IF NOT EXISTS idx_event_capi ON event(type, sent_to_meta, ts);
CREATE TABLE IF NOT EXISTS deal (
  id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES lead(id),
  client_id INTEGER NOT NULL REFERENCES client(id),
  product TEXT, amount REAL NOT NULL, currency TEXT DEFAULT 'INR',
  gateway TEXT, gateway_txn_id TEXT, status TEXT DEFAULT 'success',
  paid_at TEXT, refunded_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_deal_txn ON deal(gateway_txn_id);
CREATE INDEX IF NOT EXISTS idx_deal_client ON deal(client_id, status, paid_at);
CREATE TABLE IF NOT EXISTS meta_ad_account (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES client(id),
  name TEXT, ad_account_id TEXT, token TEXT, pixel_id TEXT, status TEXT DEFAULT 'connected',
  last_pull_at TEXT, auto_pull INTEGER DEFAULT 1, last_error TEXT
);
CREATE TABLE IF NOT EXISTS meta_campaign (
  id TEXT PRIMARY KEY, ad_account_id TEXT NOT NULL, name TEXT, status TEXT, object_type TEXT
);
CREATE TABLE IF NOT EXISTS meta_adset (
  id TEXT PRIMARY KEY, ad_account_id TEXT NOT NULL, campaign_id TEXT, name TEXT, status TEXT
);
CREATE TABLE IF NOT EXISTS meta_ad (
  id TEXT PRIMARY KEY, ad_account_id TEXT NOT NULL, adset_id TEXT, name TEXT, status TEXT,
  creative_id TEXT, creative_img TEXT
);
CREATE TABLE IF NOT EXISTS spend_daily (
  ad_id TEXT NOT NULL, date TEXT NOT NULL, ad_account_id TEXT,
  spend REAL DEFAULT 0, spend_inr REAL DEFAULT 0,
  impressions INTEGER DEFAULT 0, reach INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0,
  currency TEXT DEFAULT 'INR',
  PRIMARY KEY (ad_id, date, ad_account_id)
);
CREATE INDEX IF NOT EXISTS idx_spend_date ON spend_daily(date, ad_account_id);
CREATE TABLE IF NOT EXISTS fx_rate (
  date TEXT PRIMARY KEY, currency TEXT NOT NULL, inr_per_unit REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS task (
  id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES lead(id),
  user_id INTEGER, user_name TEXT, type TEXT DEFAULT 'followup',
  due_at TEXT, outcome TEXT, notes TEXT, ts TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS note (
  id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES lead(id),
  user_id INTEGER, user_name TEXT, body TEXT, ts TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS call_log (
  id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES lead(id),
  user_name TEXT, outcome TEXT, notes TEXT, ts TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS webhook_endpoint (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES client(id),
  platform TEXT NOT NULL, url TEXT NOT NULL, secret TEXT NOT NULL,
  UNIQUE(client_id, platform, url)
);
CREATE TABLE IF NOT EXISTS webhook_log (
  id INTEGER PRIMARY KEY, client_id INTEGER, platform TEXT NOT NULL,
  ref TEXT, dedup_key TEXT, status TEXT DEFAULT 'received',
  error TEXT, raw TEXT, ingested_at TEXT DEFAULT (datetime('now')),
  processed_at TEXT, test INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_whl_status ON webhook_log(status, ingested_at);
CREATE TABLE IF NOT EXISTS user (
  id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT, password_hash TEXT,
  role TEXT DEFAULT 'viewer', client_ids TEXT,
  totp_secret TEXT, totp_enabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS session_token (
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES user(id),
  created_at TEXT DEFAULT (datetime('now')), expires_at TEXT
);
-- one-row-per-user pending two-factor login (password OK, waiting on the OTP)
CREATE TABLE IF NOT EXISTS tfa_pending (
  user_id INTEGER PRIMARY KEY REFERENCES user(id),
  totp_secret TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, user_email TEXT, action TEXT NOT NULL,
  entity TEXT, entity_id TEXT, ts TEXT DEFAULT (datetime('now')), detail TEXT
);
CREATE TABLE IF NOT EXISTS integration_status (
  platform TEXT PRIMARY KEY, status TEXT DEFAULT 'pending', notes TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS field_map (
  client_id INTEGER NOT NULL, platform TEXT NOT NULL,
  mapping TEXT DEFAULT '{}', PRIMARY KEY (client_id, platform)
);
CREATE TABLE IF NOT EXISTS capi_setting (
  id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES client(id),
  pixel_id TEXT NOT NULL, event_types TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT
);
CREATE TABLE IF NOT EXISTS job (
  id INTEGER PRIMARY KEY, queue_name TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0,
  next_run_at INTEGER DEFAULT 0, last_error TEXT, created_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_due ON job(status, next_run_at);
