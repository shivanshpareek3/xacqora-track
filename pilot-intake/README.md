# Pilot cutover intake (v13) — where the real items land

**This whole folder is gitignored except this README.** Anything dropped into
it stays on this machine, never commits, and never leaves to a remote. The
v13 working rule: *real credentials / client data never enter AI chat* — this
folder is the handover point instead.

The 12 items from Master v13 §6 split into two lanes:

## Lane 1 — the 7 written decisions (typeable, no secrets)

| Item | v13 # |
|---|---|
| Product name | 1 |
| 3–4 pilot clients + owner mapping | 2 |
| Product owner + lead developer | 3 |
| Hosting budget (Mumbai PG + Vercel) | 4 |
| Default attribution model | 5 |
| Call-logging owner | 6 |
| Live-secrets owner | 7 |

These can come as plain chat / written answers. When all 7 are in, **Task A
(pilot cutover) unblocks** — the app is already go-live-ready (`ab0e607`).

## Lane 2 — credentials & data (this folder)

Drop the files here; the AI reads them from disk, they never appear in chat:

| File / folder | Contents | v13 # |
|---|---|---|
| `secrets.env` | Gateway credentials: Razorpay webhook+secret, Cashfree client secret, Aevent/Zoom/Calendly/Pabbly/WhatsApp webhook keys | 8 |
| `meta.env` | Meta CAPI pixel/dataset IDs, leadgen webhook subscription, the **rotated** access token | 9 |
| `hosting.env` | Mumbai PG `DATABASE_URL` + `PG_BACKUP_USER`, Vercel project, `track.` + app domain | 10 |
| `csv/<client>.csv` | One old-leads CSV per pilot client (clear headers incl. phone) | 11 |
| `ads-urls.txt` | Active ad destination URLs, one per line (campaign/adset/ad level) | 11 |
| `token-rotation.txt` | One line: the chat-pasted live Meta token was revoked? + confirmation it's the new one | 12 |

`secrets.env` / `meta.env` / `hosting.env` use the same `KEY=VALUE` shape as
the repo-root `.env` (`server/lib/env.js` loads `KEY=VALUE` lines, no inline
comments, quotes optional). You can also just hand the repo-root `.env` and
point the cutover at it.

### CSV header convention (item 11)

The old-leads import is `server/lib/pilot.js → importOldLeads`; it infers the
column mapping from the header row when none is given, else it takes an
explicit mapping. Recognised header names (case-insensitive):

`name, phone, email, city, stage, amount, registered, attended, paid_at, refund`

- `phone` — anything the normaliser can E.164; keep it a single column.
- `amount` + `paid_at` — a paid lead backfills a `deal` row; leave blank if
  the row isn't paid yet.
- `registered` / `attended` — 1/0 or yes/no; they drive the funnel-stage
  auto-move (registered → Registered, attended → Attended).
- `refund` — 1 marks the deal refunded (drives the CAPI Purchase-suppression
  rule the audit in `docs/capi-audit.md` checks).

Idempotent: re-importing the same file matches by phone-then-email and adds
0 new rows.

## After Lane 2 lands

The cutover (v13 §1) reads everything from this folder, wires it into
`.env` / the prod Postgres, runs `scripts/prod-verify.sh` (2FA gate now
expected **PASS**), wires the gateway HMAC specs from
`docs/adapter-verification.md`, imports the CSVs, flips CAPI live, and opens
the 4-week accuracy window. **Human review flags** (v13 §5): the CAPI flip,
any permission change, anything touching money or phone — those step only
after Arpit's explicit sign-off.
