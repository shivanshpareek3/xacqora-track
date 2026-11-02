# Module: Pilot gates tooling (Phase G)

**What it does** — everything the pilot needs to run and self-verify on
fake/pilot-mock data, on BOTH engines:

- **CSV import of old leads** — `server/lib/pilot.js` → `importOldLeads()`:
  column-mapping screen (`/pilot` → CSV import; also `/import` when the body
  carries a `csv` string). E.164 normalisation (India +91), duplicate skip
  (phone-then-email identity match), deal + refund + registered/attended
  backfill, fully idempotent. Explicit mapping wins; otherwise the header row
  is inferred (`inferMapping`). Fixture: `samples/old-leads.csv`.
- **Ad URL checker** — `checkAdUrl()`: paste a pilot ad destination URL →
  report where `{{ad.id}}` / `{{adset.id}}` / `{{campaign.id}}` / fbclid are
  missing (missing ad token ⇒ leads land with no ad_id ⇒ G1 fails for that ad).
- **Gate assertion suite** — `runGates()`: G1 Instant-Form leads land with an
  ad_id (100%), G2 landing-lead ad_id/UTM coverage ≥95%, G3 same person two
  forms = one lead, G4 webhook queue age 0 > 10 min. G1/G4 key off the
  `job.next_run_at` epoch column (engine-agnostic; webhook timestamps differ
  per engine).
- **Accuracy checkers** (pilot month, run by pasting in exports) —
  `revenueVsGateways()` (net-of-refunds, ≤2%), `spendVsMeta()` (≤1%),
  `capiQuality()` (avg ≥7 on Purchase), `weeklyTiming()` (before/after log in
  `settings`).
- **Live checklist** — `docs/pilot-live-checklist.md`, served in-app at
  `/pilot-live-checklist`.

**Files** — `server/lib/pilot.js`, `screens.pilot` in `server/screens.js`,
routes in `server/index.js` (GET `/pilot` team-only; POST `/pilot/import`,
`/pilot/accuracy`, `/pilot/timing`; the legacy `/import/csv` accepts a `csv`
string → mapped import), `samples/old-leads.csv`, `test/gates.js`.

**How to test** — `node test/gates.js` on SQLite and with `DATABASE_URL` on
Postgres (scratch db): CSV import (6 rows, E.164, refund backfill), duplicate
skip + idempotency on re-import, header inference, URL checker, all four gates
on a pilot-mock dataset, and the four accuracy checkers.
Screen: sign in as owner → **Pilot** in the nav (team roles only).

**Constraints met** — zero new dependencies; runs read-only against the live
DB except the import + accuracy log (both audit-logged: `import.csv`,
`pilot.accuracy`, `pilot.weekly_timing`).
