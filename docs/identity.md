# Module: Identity & lead record

**What it does** — normalises every phone to E.164 `+91XXXXXXXXXX` (strips spaces,
`0`, `91`, `+91` prefixes), matches a lead on phone first then lower-cased email,
attaches all earlier anonymous visitor touchpoints to the lead the moment a form
reveals who it is, and never merges across clients. Same phone + different client =
different leads. Duplicates (same email, different phone) are surfaced for a human
to merge on the Duplicates screen; merge moves touchpoints, events, deals, tasks,
notes and calls onto the kept lead.

**Key files** — `server/lib/identity.js` (normPhone/normEmail live in `server/lib/shared.js`),
`server/screens.js` → `duplicates()`, routes `POST /duplicates/merge`, `POST /admin/prune`
(privacy deletion also suppresses future CAPI for that person).

**How to test** — `node test/replay.js` creates leads from sample payloads and checks
phone-normalised matching. To test the "same person, two forms = one lead" rule, post
`test-samples/meta_leadgen.json` then `test-samples/razorpay.json` (both resolve to
phone `+919812345678` / email `ravi@example.com`) and confirm there is one lead row.
