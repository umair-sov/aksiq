// pipeline/dedup.js
//
// Identifies records across sources that describe the SAME real-world
// event, and clusters them. This is the auditable step from the design
// doc (D2) — it doesn't blend duplicates into synthesis silently, it
// returns which source_ids merged and why, so a human can review it.
//
// Approach: one bounded LLM call given ALL normalized records at once,
// rather than hand-rolled text-similarity math. Reasoning (worth
// re-checking against real runs, this is the one genuinely non-obvious
// design call in the whole pipeline):
//   - Entity match alone is NOT enough to merge (Stark Industries and
//     Initech each appear twice in the fixture for two UNRELATED events
//     — merging on entity alone would wrongly collapse those).
//   - Some real duplicates have NO entity on one or both sides
//     (SAL-003 / OPS-1041 / SUP-7784 — the outage described three
//     different ways, only one side has an entity at all). Pure
//     entity-matching would miss this case entirely.
//   - A single call over the whole record set is both cheaper (N5 —
//     one call per run, not one per pair) and lets the model use the
//     actual event content semantically, which plain string-similarity
//     would struggle with here (three very different vocabularies for
//     the same outage).
//   - Trade-off to watch: this makes clustering non-deterministic in
//     principle. N3 only requires the eventual FACT SET to be stable
//     across runs, not that every borderline clustering call is
//     bit-identical — but if you see a cluster's membership shift
//     between runs during testing, that's the thing to investigate.
//
// Routed through OpenRouter (OpenAI-compatible chat completions format),
// not Anthropic's native Messages API. Key differences from a direct
// Anthropic call:
//   - Endpoint + auth: Bearer token against /chat/completions, not
//     x-api-key against /v1/messages.
//   - System prompt goes in the `messages` array as a `system`-role
//     entry, not a separate top-level `system` field.
//   - JSON is forced via `response_format: { type: "json_object" }`
//     rather than an assistant-turn prefill — prefill-to-force-JSON is
//     an Anthropic-specific pattern and doesn't carry over cleanly.
//   - Response body is `choices[0].message.content` (a full string),
//     not a `content` array of blocks.

// Loads .env from aksiq/ (the parent of Agent 2/) — see config/env.js
// for exactly where it looks. Every file using process.env.* in this
// project should require this first, same as here.
require("../config/env");

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Swap this for whatever's current on OpenRouter's model list — this is
// a cheaper/faster tier per your "downgrade" ask, but verify the exact
// string yourself since these get renamed/deprecated over time.
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-3.5-haiku";

const SYSTEM_PROMPT = `You are deduplicating status update records from multiple independent sources (sales, ops, support).

You will be given a list of records, each with: source, source_id, entity (may be null), and text.

Your job: identify groups of records that describe the SAME real-world event, even if worded completely differently or reported by different teams.

Critical rules:
- Two records mentioning the SAME entity are NOT automatically the same event. Only cluster them if the actual content describes the same underlying event.
- Two records can describe the same event even if their "entity" fields don't match, or one/both have no entity at all — judge by the content of "text", not just "entity".
- IMPORTANT: records can describe the same event even if they report CONFLICTING or CONTRADICTORY facts about it (e.g. one says a deal closed, another says the same deal is still pending). A contradiction is NOT evidence the records are about different events — it is often evidence they're about the SAME event, seen from two out-of-sync sources. When you notice two records about the same subject that disagree on a fact, that is exactly the case that should be clustered, precisely so a human can see the disagreement. Do not use "these facts conflict" as a reason to treat two records as unrelated.
- Only include a record in a cluster if you are genuinely confident it's the same event. When unsure, leave it out (it will be treated as standalone, not lost).
- A record can appear in at most one cluster.
- Do not force every record into a cluster — most records will have no duplicate at all, and that's expected.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "clusters": [
    {
      "source_ids": ["<source_id>", "<source_id>"],
      "reasoning": "<one sentence: why these are the same event>"
    }
  ]
}`;

/**
 * Cluster merged records into same-event groups via one LLM call.
 *
 * @param {object[]} mergedRecords - common-shape records from merge.js
 * @returns {Promise<{clusters: object[], standalone: object[]}>}
 */
async function dedupRecords(mergedRecords) {
  // Zero records overall (e.g. every source was empty) — nothing to
  // judge, and calling the model with an empty list would just waste
  // a call for a guaranteed-empty answer. Short-circuit instead.
  if (mergedRecords.length === 0) {
    console.log("[dedup] No records to dedup — skipping the LLM call.");
    return { clusters: [], standalone: [] };
  }

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Export it before running dedup."
    );
  }

  // Only send what the model needs to judge — not the full `raw` blob.
  const compactRecords = mergedRecords.map((r) => ({
    source: r.source,
    source_id: r.source_id,
    entity: r.entity,
    text: r.text,
  }));

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      // Bumped up from 2000: reasoning-tier models (like Nemotron 3
      // Ultra) can spend a chunk of the token budget on internal
      // reasoning before writing the actual answer. If max_tokens runs
      // out mid-reasoning, `content` comes back empty even though the
      // call itself succeeded — that's what was happening before.
      max_tokens: 8000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(compactRecords, null, 2) },
      ],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content ?? "";

  // Debug visibility — leave this in while you're still verifying
  // against the fixture, strip it out later once dedup is trusted.
  console.log("[dedup] Raw model response:", JSON.stringify(data, null, 2));

  if (!rawText || rawText.trim() === "") {
    throw new Error(
      "[dedup] Model returned empty content. Full response logged above — " +
      "check finish_reason (e.g. 'length' means it ran out of tokens " +
      "before writing an answer)."
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseErr) {
    throw new Error(
      `[dedup] Model response wasn't valid JSON. Raw content was:\n${rawText}\n\nParse error: ${parseErr.message}`
    );
  }

  const clusters = parsed.clusters ?? [];

  // --- Validate: no record silently dropped or duplicated ---
  const clusteredIds = new Set(clusters.flatMap((c) => c.source_ids));
  const allIds = mergedRecords.map((r) => r.source_id);
  const duplicated = allIds.filter((id, i) => allIds.indexOf(id) !== i);
  if (duplicated.length > 0) {
    console.warn("[dedup] Duplicate source_ids in input:", duplicated);
  }

  const standalone = mergedRecords.filter(
    (r) => !clusteredIds.has(r.source_id)
  );

  // Attach the actual record objects to each cluster (not just ids),
  // so downstream synthesize doesn't have to re-look them up.
  const clustersWithRecords = clusters.map((cluster) => ({
    ...cluster,
    records: mergedRecords.filter((r) =>
      cluster.source_ids.includes(r.source_id)
    ),
  }));

  return { clusters: clustersWithRecords, standalone };
}

module.exports = { dedupRecords };