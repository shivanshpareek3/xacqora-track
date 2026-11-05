// Phase H — production monitoring: /health JSON + the /alerts.html screen.
// Alerts surface the five PRD §11 signals: webhook failures, queue age >10min,
// Meta pull failures, CAPI send failures, backup success. All read-only,
// system-scoped queries (no RLS — this is an operational view).
//
// Engine safety: webhook_log.ingested_at is display-format and differs per
// engine (SQLite 'YYYY-MM-DD HH:MM:SS' UTC; PG to_char with 'T'/'Z'). The
// queue-age gate therefore keys off job.next_run_at (epoch seconds, set
// identically by enqueue() on both engines) and normalizes timestamps in JS.
const fs = require('node:fs');
const path = require('node:path');
const sec = require('./security');

function normTs(s) {
  if (!s) return null;
  const t = String(s).trim();
  // 'YYYY-MM-DD HH:MM:SS' (SQLite UTC) -> ISO; 'YYYY-MM-DDTHH:MM:SSZ' passes through
  const iso = /^\d{4}-\d{2}-\d{2}[ T]/.test(t) ? t.replace(' ', 'T') + (/[Z]$/.test(t) ? '' : 'Z') : t;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function health(tx, db, dataMode) {
  const now = Date.now();
  const live = require('./liveapi');
  const { engine } = require('../db');

  // 1. webhook failures (last 24h, JS-side filter on the display timestamps).
  //    In live data-mode, exclude the seed's demo webhook rows so the ops
  //    board doesn't report test fixture failures as real.
  const whEx = dataMode === 'live'
    ? require('./datamode').webhookNotDemo('live', 'w') : '';
  const failed = tx.all(`SELECT id, client_id, platform, ref, error, ingested_at FROM webhook_log w
    WHERE status='failed' ${whEx ? `AND ${whEx}` : ''} ORDER BY id DESC LIMIT 50`);
  const cutoff24h = now - 24 * 3600000;
  const webhookFailures = failed.filter((r) => {
    const t = normTs(r.ingested_at);
    return t == null || t >= cutoff24h;
  });

  // 2. queue age — key off the job table epoch columns (engine-agnostic)
  const nowSec = Math.floor(now / 1000);
  const q = tx.get(`SELECT COUNT(*) pending, MIN(next_run_at) oldest_due FROM job
    WHERE queue_name='webhook' AND status='pending'`);
  const pending = q && q.pending ? q.pending : 0;
  // how long ago the oldest still-pending job was due (min) — the queue age
  const queueAgeMin = pending && q.oldest_due ? Math.max(0, Math.round((nowSec - q.oldest_due) / 60)) : 0;
  const queueStale = tx.get(`SELECT COUNT(*) c FROM job
    WHERE queue_name='webhook' AND status='pending' AND next_run_at < ?`, nowSec - 600).c;

  // 3. Meta pull failures (ad accounts carrying a last_error from a live pull).
  //    In live data-mode, drop the seed's ACT- ad accounts so their mock/token
  //    errors don't read as real pull failures on the ops board.
  const metaEx = dataMode === 'live'
    ? require('./datamode').metaNotDemo('live', '') : '';
  const metaFails = tx.all(`SELECT ad_account_id, name, last_error, last_pull_at FROM meta_ad_account a
    WHERE last_error IS NOT NULL AND last_error != '' ${metaEx ? `AND ${metaEx}` : ''} ORDER BY id`);

  // 4. CAPI send failures — CAPI-type events still unsent (sent_to_meta=0)
  const capiStuck = tx.get(`SELECT COUNT(*) c FROM event
    WHERE type IN ('registered','webinar_joined','call_booked','payment_success')
      AND sent_to_meta = 0`).c;
  const capiSuppressed = tx.get(`SELECT COUNT(*) c FROM event WHERE sent_to_meta = 2`).c;

  // 5. backup success — last calendar day (IST) the daily backup ran
  const lastBackup = tx.get(`SELECT value FROM settings WHERE key='last_backup_date'`);
  let latestBackupFile = null;
  try {
    const files = fs.readdirSync(path.join(__dirname, '..', '..', 'backups')).filter((f) => f.startsWith('xacqora-'));
    if (files.length) latestBackupFile = files.sort()[files.length - 1];
  } catch { /* no backup dir yet */ }

  const h = {
    ok: true,
    engine: engine(),
    ts: new Date(now).toISOString(),
    mode: {
      live: live.liveMode(),
      mock: process.env.MOCK === '1',
      secret_key_set: sec.keySecure(), // prod must set it (insecure dev fallback otherwise)
      capi: tx.get(`SELECT value FROM settings WHERE key='capi'`)?.value || 'dry',
      meta_business_verified: tx.get(`SELECT value FROM settings WHERE key='meta_business_verified'`)?.value === '1',
      xt_subdomain: process.env.XACQORA_XT_SUBDOMAIN || null,
    },
    db: {
      ping: 1,
      webhook_failures_24h: webhookFailures.length,
      webhook_failures: webhookFailures.slice(0, 5).map((r) => ({
        platform: r.platform, client: r.client_id, ref: r.ref, error: r.error, at: r.ingested_at,
      })),
      queue: { pending, age_min: queueAgeMin, stale_over_10min: queueStale },
      // friendly, operator-facing classification of each raw pull error
      // (401 vs permission vs network) so /alerts is actionable, not a raw dump
      meta_pull_failures: metaFails.map((r) => ({
        ad_account: r.ad_account_id, name: r.name, error: r.last_error,
        reason: require('./metalive').classifyMetaError(r.last_error),
        last_pull_at: r.last_pull_at,
      })),
      // token expiry (recorded by scripts/meta-validate.js into the
      // meta_ad_account.token_expires_at column; live-token-aware alerting)
      meta_token: require('./metalive').metaTokenExpiry(tx),
      capi_stuck_unsent: capiStuck,
      capi_suppressed_refund: capiSuppressed,
      backup: { last_date: lastBackup ? lastBackup.value : null, latest_file: latestBackupFile },
    },
  };
  h.alerts = {
    webhook_failures: h.db.webhook_failures_24h > 0,
    queue_age_over_10min: queueStale > 0,
    meta_pull_failures: h.db.meta_pull_failures.length > 0,
    capi_send_failures: capiStuck > 0,
    backup_not_recorded: !(lastBackup && lastBackup.value),
  };
  return h;
}

module.exports = { health, normTs };
