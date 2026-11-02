# Pilot live checklist (Phase G)

What to do to start the 4-week pilot **the moment** Arpit's §6 decisions land
(clients + budget + secrets owner). Everything here is either a system action
(a route / the `/pilot` screen / `test/gates.js`) or a human step. Run the
**Setup** section first, then the **Week 1** gates, then the recurring
**Weekly accuracy** cadence. Pass/fail criteria are stated per step; a failed
gate is a pilot blocker, not a footnote.

> Roles: **Ops** = the person running this list (media buyer / Arpit). **Dev**
> = the engineer on the repo. No real client data or access tokens are pasted
> into AI chat — fixtures + env vars only.

---

## 0. Entry conditions (before touching anything)

- [ ] Arpit §6 answered: product name decided, 3–4 pilot clients named,
      hosting budget + month, default attribution model picked, call-logging
      owner, **who configures the live webhook secrets** (Razorpay/Cashfree/Meta).
- [ ] `XACQORA_LIVE=1` is **off** until every secret below is in place (the app
      runs in mock/dry-run and is fully safe with fake data).
- [ ] `docs/adapter-verification.md` has **zero pending markers** for Razorpay +
      Cashfree (they were re-verified 2026-11-02; the 5 other adapters stay
      UNVERIFIED with retry dates — do not treat them as live).

---

## 1. Setup (one time, per pilot client)

### 1.1 Webhook + ingest endpoints
For each pilot client, confirm a row exists in `webhook_endpoint` for the
platforms that will be live (typically `meta_leadgen`, `razorpay`, plus
`aevent`/`calendly`/`zoom`/`whatsapp` if the client uses them).

- **Who:** Dev creates the rows; Ops fills the URL + secret.
- **How:** `server/index.js` → `webhook_endpoint` (one row per
  `client_id + platform + url`). Secret is stored **encrypted** (AES-256-GCM,
  Phase S.2). The live signature spec is in `docs/adapter-verification.md`.
- **Pass:** a test POST to `/api/ingest/<platform>?secret=<s>` returns
  `{ ok: true, queued: true }` and a row lands in `webhook_log` with
  `status='queued'`.

### 1.2 Live secrets
- [ ] Razorpay: copy the **Live-mode webhook secret** into the `razorpay`
      endpoint row. (Live & Test mode use separate secrets/URLs — the live one
      is the one that matters.)
- [ ] Cashfree: copy the **client secret** into the `cashfree` endpoint row.
- [ ] Meta: connect the ad account in `meta_ad_account` (token encrypted at
      rest). **Do not** paste the token into chat. Set `XACQORA_LIVE=1`.
- [ ] Set `settings.capi = 'live'` only after the Meta pixel + ad account are
      verified (until then CAPI runs dry and `match_quality` is the 7–9 estimate).
- **Pass/fail:** each gateway webhook, when triggered, verifies its HMAC and
  enqueues; `webhook_log.error` stays null.

### 1.3 Ad destination URLs
- [ ] For **every** pilot ad, take the destination/URL and check it on the
      `/pilot` screen → **Ad URL checker**.
- **Pass/fail:** the checker must report `{{ad.id}}` present on every Meta ad
      (missing ad token = leads land with no `ad_id`, and gate **G1** will fail
      for that ad). `{{adset.id}}` / `{{campaign.id}}` are warnings. Note any
      UTM params missing for non-Meta channels.
- [ ] Re-run the checker after any creative/URL change during the pilot.

### 1.4 Old-lead backfill (optional, per client)
- [ ] Paste the client's historical CSV into `/pilot` → **CSV import** (or
      `/import`). Map the columns (name/phone/email/city/stage/amount/
      registered/attended/paid_at/refund) or let the header be inferred.
- **Pass/fail:** phones arrive E.164 (+91…), existing people match by
      phone-then-email (no duplicate leads), a paid amount backfills a deal,
      and a re-import of the same file adds 0 new rows (idempotent). The action
      is written to `audit_log` (`import.csv`).

---

## 2. Gate suite — run before the 4-week window opens, and on demand

Open `/pilot` → **Gate assertion suite** (the four gates below). All four must
be green; a red gate is a blocker. `test/gates.js` asserts the same suite
against the pilot-mock dataset on both engines, so the *tool* is proven; the
*data* here is what flips the pass/fail.

| Gate | What it checks | Pass when |
|---|---|---|
| **G1** | Instant Form leads land with an `ad_id` | 100% of `meta_leadgen` leads have an ad click touchpoint, and no webhook job is stuck pending > 1 min |
| **G2** | Landing leads carry `ad_id` / UTM | ≥ 95% of leads have an ad_id or a UTM campaign |
| **G3** | Same person, two forms = one lead | 0 phone numbers backing more than one lead (run **Duplicates** if > 0) |
| **G4** | Webhook queue age | 0 unprocessed webhook jobs older than 10 min |

- **Who:** Ops reads the screen; Dev investigates a red gate.
- **Retry dates:** G2/G4 are re-checked daily in week 1; G3 on any merge.

---

## 3. Weekly accuracy cadence (pilot months 1–4)

Run **once a week**, each time the pilot month's exports are available. These
are the "paste the export in" checkers — the app does not fetch gateway
settlements or the Meta Ads Manager dashboard for you.

### 3.1 Revenue vs gateways (≤ 2% diff)
- **Input:** the gateway's **settled** revenue total for the week (Razorpay +
      Cashfree, net of refunds) → `/pilot` → **Accuracy checkers** →
      "revenue vs gateways".
- **Pass/fail:** the system's net-of-refunds `deal` total is within **2%** of the
      gateway settlement. If it fails, the cause is usually a webhook that
      404'd or a refund that didn't post — check `webhook_log` + `deal.refunded_at`.

### 3.2 Spend vs Meta Ads Manager (≤ 1% diff)
- **Input:** the Meta Ads Manager spend export (INR, same window) →
      "spend vs Meta".
- **Pass/fail:** the system's `spend_daily` total is within **1%** of Meta's own
      number. A miss means a Meta pull gap — re-run `/meta` → Pull, and
      compare against the Meta-vs-Track report (`/reports.html`).

### 3.3 CAPI match quality ≥ 7 on Purchase
- **Input:** none (read from `capi_log`). Reads from the `/pilot` screen after a
      week of live CAPI.
- **Pass/fail:** average `match_quality` on `Purchase` events ≥ 7. Low quality
      usually means leads are missing a phone or email — check lead identity
      completeness (G3 territory).

### 3.4 Weekly report time (before/after log)
- **Input:** the minutes it took to *produce* the weekly client summary by hand
      (before), and the minutes using the auto summary (after).
- **What it does:** logs both to `settings` (`weekly_report_time_before_min` /
      `..._after_min`) and shows the improvement %. The auto summary itself is
      the **Monday 9 AM IST** job (Phase R) — no one produces it manually.
- **Pass/fail:** a real pilot week must show the "after" materially below the
      "before" (the whole point of the auto weekly).

---

## 4. Open / handoff items (not pilot-blocking, but decide in week 1)

- **Aevent / Zoom / Calendly** retry: 2026-11-09 (see
  `docs/adapter-verification.md`).
- **Pabbly / FlexiFunnels** retry: 2026-11-16.
- **CAPI live toggle:** only flip `settings.capi='live'` after pixel + ad
      account verified; dry-run until then so `match_quality` is the estimate.

---

## Where each thing lives

| Item | System location | Human action |
|---|---|---|
| Webhook endpoints + secrets | `webhook_endpoint` (encrypted) | Ops fills URL + secret |
| Ad URL checker | `/pilot` → Ad URL checker | Ops pastes each ad URL |
| Old-lead import | `/pilot` / `/import` → CSV | Ops maps + pastes CSV |
| Gate suite (G1–G4) | `/pilot` + `test/gates.js` | Ops reads; Dev fixes reds |
| Accuracy checkers | `/pilot` → Accuracy | Ops pastes gateway/Meta totals |
| Weekly auto summary | Monday 9 AM IST ticker → portal card + `/weekly.pdf` | none (zero manual) |
