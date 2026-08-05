# Agent 2 — Multi-Source Synthesis Agent

A domain-agnostic agent that reads weekly updates from N independent sources
(currently Sales / Ops / Support), removes cross-source duplicates, and
produces one synthesized summary with an auditable merge record. Currently
runs entirely locally against mock fixtures — no n8n port, no live API
integrations yet.

## What it does

1. **Load** — reads each source's raw data (currently JSON fixtures).
2. **Normalize** — one adapter per source maps its own field names/structure
   onto a common shape: `{ source, source_id, timestamp, entity, text, raw }`.
3. **Merge** — combines all sources into one flat list, and flags any source
   that was empty.
4. **Dedup** — a single LLM call identifies records across sources describing
   the *same* real-world event, and clusters them. Contradictory facts about
   the same event are clustered too (flagged, not silently resolved).
5. **Synthesize** — a single LLM call writes one readable sentence per
   cluster; standalone records pass through untouched, since there's nothing
   to synthesize from a single source's account.
6. **Emit** — validates the final shape and writes both a JSON file (the
   structured record) and a Markdown file (the human-readable summary) to
   `output/`.

## How to run

```bash
cd "Agent 2"
npm install
node index.js
```

Requires `aksiq/.env` (one level above `Agent 2/`) with:

```
OPENROUTER_API_KEY=your-key-here
OPENROUTER_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free
```

`OPENROUTER_MODEL` is optional — defaults to the value above. OpenRouter's
free-tier model slugs change frequently; check openrouter.ai/models if a
model ID stops working.

`DEBUG_OPENROUTER=true` prints the full raw OpenRouter response on a
successful call — useful when the output looks off and you want to see
exactly what the model returned; it defaults to off, and HTTP errors,
network failures, and retry attempts are always logged regardless of this
flag.

## Project structure

```
Agent 2/
  adapters/       one normalize function per source — the ONLY files that
                   know each source's specific field names/structure
  fixtures/       mock data for sales, ops, support
  pipeline/       source-agnostic core: merge, dedup, synthesize, emit
  config/         shared env loader (points at aksiq/.env)
  output/         generated summaries land here
  index.js        entry point: load -> merge -> dedup -> synthesize -> emit
```

## Input / output shape

**Input:** any shape per source — each adapter maps it onto the common record:

```json
{ "source": "sales", "source_id": "SAL-001", "timestamp": "...", "entity": "Acme Corp", "text": "...", "raw": {...} }
```

**Output:**

```json
{
  "period": "2026-07-20 to 2026-07-24",
  "sections": [ { "group": "Sales", "highlights": ["..."] } ],
  "merged_events": [ { "event": "...", "from": ["sales/SAL-001", "support/SUP-7780"] } ],
  "skipped": [ { "source": "support", "reason": "empty" } ]
}
```

Each run writes this as both `summary-<period>.json` and `summary-<period>.md`
in `output/`. If a file already exists at that period-derived path (e.g. a
repeat run against the same week), a trailing Unix timestamp is appended
instead of silently overwriting the previous run's output — each run's
audit trail stays intact. Alongside that pair, `output/summary-latest.json`
and `output/summary-latest.md` are also written every run, always
overwritten with the same content — a stable filename for "the most recent
run" that doesn't disturb the versioned history above.

## Known limitations / findings

- **Dedup is non-deterministic on borderline cases.** Across 11 total runs
  against the same fixture, the three high-confidence clusters (the Acme
  Corp renewal, the 3-way Globex Inc outage, and the Umbrella Ltd
  contradiction) have been identical on every single run — zero exceptions.
  The one borderline case — an entity-missing cluster between an ops record
  and a support record, `OPS-1041`/`SUP-7784` — formed on exactly 3 of the
  11 runs. When it does form, it's always exactly those two records; a
  third related record, `SAL-003` (from sales), has never joined it in any
  run. This is an inherent property of using an LLM for judgment calls
  rather than fixed rules: the *fact set* stays stable, but not every
  borderline clustering decision is bit-identical run to run.
- **The entity-missing fallback path is real but weak.** Dedup can correctly
  match records with no entity on either side using pure text similarity —
  confirmed working — but it's the least reliable path in the system.
- **Free-tier model availability is unstable.** OpenRouter's `:free` model
  slugs have been deprecated mid-project multiple times during development.
  Don't hardcode a slug and assume it'll still exist later.
- **`skipped` tracks two source-level failure reasons** — `"empty"` (zero
  raw records) and `"all_malformed"` (records existed, but none survived
  normalization) — not per-record malformed skips. Per-record skips (e.g.
  a ticket with no description) are logged to the console by their
  adapter but don't appear in the final output's audit trail.
- **That console-only visibility extends to duplicate `source_id`s too.**
  Same as the per-record malformed skips above, a duplicate `source_id`
  within a source (e.g. two records sharing the same ticket_id from a
  source-side bug) is caught and `console.warn`'d by `dedup.js`, but never
  propagated into `skipped` or anywhere else in the output — confirmed via
  a deliberate test: the warning fires correctly and no data was lost in
  the tested case, but there's no way to see it happened after the fact
  without having read console output at run time. Same deliberate scoping
  as above, not a bug: `skipped` only ever covers source-level failures.
- **Two distinct transient failure modes have been observed and handled.**
  (1) A truncated/invalid JSON body on an otherwise-200 response — this
  resolved on retry, and is what the retry logic added to
  `pipeline/openRouterClient.js` now handles automatically. (2) An
  OpenRouter rate limit (a 502 `ResourceExhausted` error) — retry logic does
  **not** help here, since it's a sustained capacity issue rather than a
  one-off blip; this requires either waiting or switching models.
- **A checkpoint mechanism now exists** (`output/.checkpoint-dedup.json`):
  if dedup succeeds but a later stage (synthesize/emit) fails, the next run
  resumes from the checkpoint instead of re-paying for a fresh dedup call.
  Verified working end-to-end on a real run: written on dedup success,
  correctly resumed after a rate-limit failure in synthesize, then
  correctly cleared once a full run finally succeeded. The checkpoint
  deliberately excludes each record's `raw` field before persisting to
  disk, so full record content isn't held in plaintext on disk between runs
  any longer than necessary. Its staleness check (`signatureOf()` in
  `index.js`) only compares source+source_id pairs, not content — it will
  reuse a checkpoint even if a record's text changed while its id stayed
  the same. That's a non-issue against static JSON fixtures, which never
  change once written, but it becomes a real gap once real APIs replace
  them: a support ticket can be edited (e.g. an agent updates its
  notes/description) without its ticket ID changing, and the checkpoint
  would silently reuse dedup output computed against the old content.

## Extending to a new source

Only the adapter layer needs to change. Write a `normalizeX()` function that
maps the new source's raw shape onto the common record shape, wire it into
`merge.js`, and everything downstream (dedup, synthesize, emit) works
unchanged. This is the core design boundary the whole pipeline is built
around — deliberately, so a new source is never more than an adapter.

## Integrating real APIs (for a team / production use)

The pipeline architecture supports swapping fixtures for live data sources —
Salesforce/HubSpot for sales, PagerDuty/Jira/ServiceNow for ops,
Zendesk/Freshdesk/Intercom for support — but a few things need deliberate
work first. Treat this as a checklist for whoever picks this up next, not
something that's already handled:

### Adapter changes needed
- **Split fetch from normalize.** Adapters currently `require()` an
  already-loaded JSON fixture. A real integration needs an explicit fetch
  step (HTTP call + auth + pagination) *before* normalization — these should
  be separate functions per adapter (`fetchXRecords()` / `normalizeX()`),
  not blended together.
- **Make the load step in `index.js` async.** Currently synchronous
  (`require(...)`). Real API calls aren't — `run()` should `await` the fetch
  step the same way it already awaits dedup and synthesize.
- **Separate error handling for network/auth failures vs. malformed
  records.** The current malformed-record check assumes clean, already-
  parsed JSON. A live API adds failure modes with no home yet: expired
  OAuth tokens, timeouts, rate limits. These need their own handling
  (retry/skip/abort), distinct from a single bad record.
- **Add date-range filtering.** Every fixture record is implicitly "this
  week." A live pull needs an explicit "since last run" boundary, or every
  run reprocesses the entire history of every connected account.

### Credentials
- Each service's OAuth2 credentials should live in the same `aksiq/.env`
  file, loaded through the existing `config/env.js` pattern — just more
  variables (e.g. `SALESFORCE_CLIENT_ID`, `ZENDESK_API_TOKEN`), not a new
  loading mechanism.
- Real OAuth2 flows (token refresh, consent) are meaningfully more work than
  OpenRouter's static API key — closer to Agent 1's Gmail OAuth setup than
  anything currently in this project.

### Scaling dedup/synthesize past fixture size
- Both currently send **every** record in one single LLM call — fine for
  ~25 fixture records, not fine for a real week of Salesforce + Zendesk +
  PagerDuty data (likely hundreds of records). This needs actual design
  work before going live: chunking/batching strategy, or pre-filtering by
  date/team before dedup runs at all. Don't assume this "just works" at
  scale — it was explicitly verified only against small volumes.
- Non-determinism (see above) will surface more often at higher volume,
  since more records means more borderline cases. Worth deciding whether
  low-confidence clusters should be flagged for human review rather than
  silently included or excluded.

### Keep the fixtures
- Once adapters hit real endpoints, testing against live data on every run
  is slow and burns real API quota. Keep `fixtures/` around as **regression
  fixtures** — snapshots of real API responses — to test adapter mapping
  logic without a network call every time.

### For team use specifically
- Decide who owns `aksiq/.env` and how credentials are shared/rotated —
  currently a single local file, fine for one person, not fine for a team.
- Decide on a run cadence (manual, cron, or triggered via the existing
  n8n instance) once this moves past local-only use.
- The output currently writes to a local `output/` folder. A team version
  would need a real destination — Slack post, email, or a shared doc —
  which is its own emit-stage extension, not yet built.
