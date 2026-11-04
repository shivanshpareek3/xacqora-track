# UI design system (master v9 Task 3)

One shared stylesheet, zero-dep: the classic server-rendered screens draw
their entire look from the `css()` blob in `server/lib/shared.js` (inlined
into every screen via `layout()`). No framework, no build step, no second
stylesheet — so the shell, KPI cards, tables and nav all move in lockstep
when a token changes. The Phase F SPA (`public/app/app.css`) has its own
independent design system and is **not** touched here.

## What it covers (v9)

The v9 pass converts the "website feel" into a clean SaaS dashboard:

- **Two-tier app shell.** Signed-in screens get a fixed left sidebar
  (brand + nav grouped into Workspace / Insight / Integrations / Ops /
  Admin) plus a slim sticky top bar (ad-account switcher + user + sign
  out). Auth / 403 / 404 pages keep the compact single top bar. All 14
  classic screens render through this same shell — routing, paths and
  role-gating are unchanged; only the presentation grouping changed
  (`navFor` now carries a `group` per link; the SPA's `/api/app/me`
  reports the same paths, so the SPA is unaffected).
- **Token palette.** A `:root` block of surface / text / status /
  geometry tokens (rounded radii, card shadow, accent + soft tints).
  Legacy token names (`--blue`, `--green`, `--orange`, `--red`, `--b` …
  `--r`) are kept as aliases because inline styles in `screens.js`
  reference them, so nothing in the markup broke.
- **KPI cards.** Micro-caps label, large tabular value, a hairline
  accent bar on top, softer shadow.
- **Tables / pills / buttons / forms.** Row hover, pill tints from
  `--ok`/`--warn`/`--bad`/`--acc` soft tokens, focus rings on inputs,
  a consistent radius + shadow scale.
- **Everything preserved.** Demo band (`layoutDemoBand`), ad-account
  switcher (`layoutAccSelect`), empty states (Task 2), sparklines,
  kanban, timeline, log boxes, notes — all classes stable, all logic
  untouched.

## Files

| File | Role |
|---|---|
| `server/lib/shared.js` → `css()` | the single stylesheet (design tokens + all primitives) |
| `server/lib/shared.js` → `layout()` | the two-tier shell (sidebar + top bar vs compact top bar) |
| `server/lib/shared.js` → `navFor()` | per-role nav, now grouped (paths unchanged) |
| `server/screens.js` | page-header markup polished to the `pagehead` pattern; KPI grid `g6` |

## Verifying the look

The server is sandbox-blocked from binding localhost from the Bash tool, so
run it from a terminal (as with every other page sweep):

```bash
node server/index.js            # -> http://localhost:4100 (sign in owner@xacqora.local / xacqora)
```

Both engines green after the pass: SQLite 8 suites + replay + sweep
(0 failures); Postgres 9 suites + replay (all PASS). Known pre-existing,
unrelated: the PG sweep's 2FA step (S.3) fails reading the enrolled TOTP
secret on the PG cluster (see `memory: pg-sweep-2fa-preexisting`).
