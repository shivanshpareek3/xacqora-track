// Meta live connect: the env -> DB bridge.
//
// The app stores the Meta system-user token PER AD ACCOUNT in
// meta_ad_account.token (encrypted at rest via security.encryptSecret — the
// XACQORA_SECRET_KEY is what protects it). There is deliberately NO
// META_ACCESS_TOKEN env var the pull path reads: the live pull (liveapi.js)
// reads the token from the row it is pulling for, so each client's ad account
// carries its own token. This module is the bootstrap that turns the .env
// values the operator fills in (META_ACCESS_TOKEN + META_AD_ACCOUNT_IDS)
// into those rows, so "fill the .env and start the server" is all it takes.
//
// CAPI stays in dry-run: settings.capi='dry' (the DB setting, toggled on the
// alerts screen) is the gate — the env loader never flips it on. Live CAPI
// post is additionally required to have liveMode() + a real row token, which
// is only wired at pilot cutover.
const sec = require('./security');

// Upsert one meta_ad_account row: token encrypted at rest, status connected.
// adAccountIds: ACT_... ids. Returns a summary line per account.
function syncMetaAccountsFromEnv(tx, { token, adAccountIds, pixelId, name, clientId = 1, tokenExpiresAt }) {
  const out = [];
  if (!token || !adAccountIds.length) return out;
  const enc = sec.encryptSecret(token);
  for (const act of adAccountIds) {
    const id = String(act).trim();
    if (!id) continue;
    const existing = tx.get(`SELECT id, client_id FROM meta_ad_account WHERE ad_account_id=?`, id);
    if (existing) {
      tx.run(`UPDATE meta_ad_account SET token=?, pixel_id=?, status='connected', last_error=NULL,
        token_expires_at=? WHERE id=?`,
        enc, pixelId || null, tokenExpiresAt || null, existing.id);
      out.push(`${id}: token refreshed (client ${existing.client_id})`);
    } else {
      tx.run(`INSERT INTO meta_ad_account (client_id, name, ad_account_id, token, pixel_id, status, auto_pull, token_expires_at)
        VALUES (?,?,?,?,?,?,?,?)`,
        Number(clientId) || 1, name || id, id, enc, pixelId || null, 'connected', 1, tokenExpiresAt || null);
      out.push(`${id}: created (client ${Number(clientId) || 1}, ${name || 'unnamed'})`);
    }
  }
  return out;
}

// Map a raw Meta pull error (meta_ad_account.last_error) to an operator-facing
// line for /alerts. Pure string classification — no fetch, both engines.
function classifyMetaError(rawErr) {
  const e = String(rawErr || '');
  if (/401|invalid (oauth )?access token|token (has )?(been )?(expired|revoked)|session has expired/i.test(e))
    return 'Meta token invalid/expired (401) — regenerate the system-user token and re-run the pull.';
  if (/permission|error code 200|error code 100|not assigned|user does not have permissions/i.test(e))
    return 'Permission error — the system user lacks ads_read or the ad account is not assigned to it (Business Settings > System Users > assign).';
  if (/insights|api (returned|call)|econn|fetch|network|timeout/i.test(e))
    return 'Meta API/network failure — the ticker retries with backoff; check network + rate limits.';
  if (e) return e;
  return 'unknown error';
}

// Token-expiry signal for /alerts: flag rows whose token_expires_at is within
// 48h (or already past). Returns { expired: n, expiringSoon: n, note }.
function metaTokenExpiry(tx) {
  const now = Date.now();
  const soon = now + 48 * 3600000;
  const rows = tx.all(`SELECT ad_account_id, name, token_expires_at FROM meta_ad_account WHERE token_expires_at IS NOT NULL AND token_expires_at != ''`);
  let expired = 0, expiringSoon = 0;
  for (const r of rows) {
    const t = Date.parse(String(r.token_expires_at).replace(' ', 'T') + (/[Z]$/.test(String(r.token_expires_at)) ? '' : 'Z'));
    if (Number.isNaN(t)) continue;
    if (t <= now) expired++;
    else if (t <= soon) expiringSoon++;
  }
  return {
    tracked: rows.length, expired, expiringSoon,
    note: expired + expiringSoon
      ? `${expired} expired + ${expiringSoon} expiring within 48h — regenerate the system-user token`
      : (rows.length ? 'all tracked tokens current' : 'no token expiry tracked yet (run node scripts/meta-validate.js to record it)'),
  };
}

module.exports = { syncMetaAccountsFromEnv, classifyMetaError, metaTokenExpiry };
