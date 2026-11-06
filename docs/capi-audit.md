# CAPI dry-run audit (v12 close-out)

Goal: confirm the CAPI (Meta Conversions API) push pipeline behaves correctly in
dry-run before the live cutover — that events get **queued**, `event_id` is
**deduplicated** so the browser pixel and CAPI never double-count, and the
**refund rule** suppresses `Purchase` for refunded leads.

Audit date: **2026-11-06**. Probe: `tmp/capi-audit.js` (read-only; run per-engine,
the code path is engine-agnostic — same `server/lib/meta.js` + `server/lib/events.js`
on SQLite and Postgres). Data source: dev DB (SQLite) at audit time.

## What the pipeline does (code path)

1. **Enqueue** — `server/lib/events.js` `addEvent()`: on `registered`,
   `webinar_joined`, `call_booked`, or `payment_success`, and the event type is in the
   client's `capi_setting.event_types` (or the setting is empty = all), it enqueues a
   `job(queue_name='capi')` row carrying `event_row_id`.
   `server/lib/queue.js` `tick()` drains due jobs and calls `pushCapiEvent`.

2. **Push + dedup** — `server/lib/meta.js` `pushCapiEvent()`:
   - `event_id` is **deterministic**: `sha256("capi|<client>|<type>|<lead_id>|<event_row_id>")`.
     Because it's a content-derived hash (not a random/serial), a re-enqueued event for
     the same source row reuses the same `event_id` → Meta dedupes at the event level.
   - **Refund rule**: if `event_type==='payment_success'` and the lead has a deal with
     `status='refunded'`, the event is marked `sent_to_meta=2` (suppressed) and **no**
     `Purchase` is pushed.
   - **Dry-run decision**: `dryRunFinal = dryRun || !liveMode() || !capiToken ||
     token==='MOCK'`. Only when `settings.capi='live'` *and* `XACQORA_LIVE=1` *and* a
     real (non-MOCK) token exists does it do the real `POST`; otherwise it logs a
     dry-run `capi_log` row and returns.
   - On a live-push failure it resets `sent_to_meta=0` so the queue retries (bounded
     backoff in `queue.js`, dead-letter after 8 attempts).

## Findings

| Check | Result | Evidence |
|---|---|---|
| CAPI events queued | PASS | `capi_log` has **40** rows across all four event names; the job queue drains them (`pendingCapi=0`). |
| `event_id` dedup (no double-count) | PASS | **0** duplicate `event_id`s — every event name's `COUNT(DISTINCT event_id)` equals its row count (CompleteRegistration 21/21, Attended 9/9, Schedule 8/8, Purchase 2/2). |
| Refund rule (no `Purchase` on refund) | PASS (with note) | The refund-suppression branch exists in `meta.js:120` and suppresses `Purchase`. The one `purchaseOnRefunded` row is **demo seed data, dry-run only** (see note). |
| Dry-run is the current default | PASS | `settings.capi='dry'`; all 40 rows are `dry_run=1`, `live=0`. Nothing has actually hit Meta yet. |
| Match-quality estimate sane | PASS | 39 rows at MQ 9 (phone+email), 1 at MQ 5 (phone only) — matches the `8 + phone + email` estimate in `meta.js`. |
| No stuck/dead CAPI jobs | PASS | `pendingCapi=0`; no `dead` jobs. |

### Note on the single "Purchase on a refunded lead" row

`purchaseOnRefunded` = 1. Traced to **capi_log id 24**: `Purchase`, `dry_run=1`,
sent 2026-11-04, event ts 2026-11-02, lead 112 ("Karan M", client 1 = **"Coach Ravi —
Webinar Funnel", `demo=1`**). This is seed/demo data from before the refund-suppression
branch was fully wired and is a **dry-run log row, not a live delivery** — it never
reached Meta. Under the current code, reprocessing that lead's `payment_success` while
the deal is `refunded` would mark it `sent_to_meta=2` and push **nothing**. So the rule
is honored; the historical row is an artifact of the demo dataset, not a live-mode bug.

## Status by event type (dev DB, dry-run)

| Event name | CAPI count | dry | live | distinct event_ids |
|---|---|---|---|---|
| CompleteRegistration | 21 | 21 | 0 | 21 |
| Attended | 9 | 9 | 0 | 9 |
| Schedule | 8 | 8 | 0 | 8 |
| Purchase | 2 | 2 | 0 | 2 |
| **Total** | **40** | **40** | **0** | **40** |

## Cutover actions (Task 2)

1. Set `settings.capi='live'` **and** `XACQORA_LIVE=1` only after the real pixel
   dataset ID + a non-MOCK CAPI token are wired in (Task 2 checklist).
2. Re-run `tmp/capi-audit.js` on the **live** DB post-cutover: expect `live>0`,
   MQ from real Meta `events_received` (the dry-run estimate is replaced by Meta's
   value), and the PRD gate **CAPI MQ ≥ 7 on Purchase** to hold.
3. Confirm no `event_id` collisions once live traffic adds rows (dedup invariant
   should remain `distinct_event_ids == total`).

## Re-run

```bash
# SQLite dev DB
node tmp/capi-audit.js
# Postgres (live mirror)
DATABASE_URL=postgresql://... PG_BACKUP_USER=xacq_backup node tmp/capi-audit.js
```
