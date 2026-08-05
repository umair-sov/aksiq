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

// Shared OpenRouter request/retry/response-extraction boilerplate —
// see openRouterClient.js. Also the single source of truth for the
// MODEL default fallback now, so dedup.js and synthesize.js can't
// drift out of sync on it again.
const { callOpenRouter } = require("./openRouterClient");

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

  // Request-building, retry-with-backoff on transient failures (bad
  // HTTP status, network error, unparseable HTTP response body), and
  // extraction of the raw content string all live in the shared
  // helper now — see openRouterClient.js.
  const rawText = await callOpenRouter(
    SYSTEM_PROMPT,
    JSON.stringify(compactRecords, null, 2),
    { logLabel: "[dedup]" }
  );

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseErr) {
    throw new Error(
      `[dedup] Model response wasn't valid JSON. Raw content was:\n${rawText}\n\nParse error: ${parseErr.message}`
    );
  }

  // --- Validate response shape BEFORE the cluster-membership-duplicate
  // check below, which assumes `clusters` is an array of objects each
  // with an array `source_ids`. Without this, a malformed shape (e.g.
  // the model returning `clusters` as an object instead of an array)
  // throws an unlabeled native TypeError deep in this file instead of
  // a clear pipeline error. ---
  if (parsed.clusters !== undefined && !Array.isArray(parsed.clusters)) {
    throw new Error(
      `[dedup] Model response shape invalid: expected "clusters" to be an array, got ${typeof parsed.clusters} (${JSON.stringify(parsed.clusters)}).`
    );
  }

  const clusters = parsed.clusters ?? [];

  clusters.forEach((cluster, index) => {
    if (cluster === null || typeof cluster !== "object" || Array.isArray(cluster)) {
      throw new Error(
        `[dedup] Model response shape invalid: clusters[${index}] must be an object, got ${JSON.stringify(cluster)}.`
      );
    }
    if (!Array.isArray(cluster.source_ids)) {
      throw new Error(
        `[dedup] Model response shape invalid: clusters[${index}].source_ids must be an array, got ${typeof cluster.source_ids} (${JSON.stringify(cluster.source_ids)}).`
      );
    }
  });

  // --- Validate: no record assigned to more than one cluster ---
  // SYSTEM_PROMPT tells the model "a record can appear in at most one
  // cluster," but nothing enforces that on this side. If the model
  // violates it, fail loudly here rather than silently letting a
  // record show up in two different merged_events downstream.
  const clusterIndicesBySourceId = new Map();
  clusters.forEach((cluster, index) => {
    for (const sourceId of cluster.source_ids) {
      const indices = clusterIndicesBySourceId.get(sourceId) ?? [];
      indices.push(index);
      clusterIndicesBySourceId.set(sourceId, indices);
    }
  });
  const multiClustered = [...clusterIndicesBySourceId.entries()].filter(
    ([, indices]) => indices.length > 1
  );
  if (multiClustered.length > 0) {
    const detail = multiClustered
      .map(([sourceId, indices]) => `${sourceId} (clusters ${indices.join(", ")})`)
      .join("; ");
    throw new Error(
      `[dedup] Model put the same record in more than one cluster, violating the one-cluster-per-record rule: ${detail}`
    );
  }

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

  // --- Validate: every claimed source_id actually resolved to a record ---
  // A *partial* hallucination — the model claims N ids in a cluster but
  // only M < N of them match a real input record — isn't caught by any
  // check above: shape validation only confirms `source_ids` is an
  // array, and the one-cluster-per-record check only looks at ids that
  // ARE present in clusters, so a made-up id that appears nowhere else
  // just slips through. The `.filter()` right above this then silently
  // produces a `records` array shorter than `source_ids`, and
  // synthesize.js builds the `from` audit trail straight off
  // `cluster.records` — so the one output field this whole pipeline
  // exists to make trustworthy would quietly under-report which sources
  // the model actually claimed, with nothing anywhere flagging it. Runs
  // here (after clustersWithRecords is built, last before return) rather
  // than earlier because it needs `cluster.records` to already exist to
  // compare lengths against `source_ids`, and it's deliberately the last
  // check: it treats a hallucinated id as a distinct failure mode from
  // shape errors or double-clustering, and only makes sense to check
  // once those more basic shape issues are already ruled out. Same
  // aggregate-then-throw-once style as the one-cluster-per-record check
  // above — collect every unresolved id across every cluster first, then
  // throw a single error covering all of it, rather than stopping at the
  // first mismatch.
  const mergedRecordIds = new Set(mergedRecords.map((r) => r.source_id));
  const unresolvedByCluster = [];
  clustersWithRecords.forEach((cluster, index) => {
    if (cluster.records.length !== cluster.source_ids.length) {
      const missingIds = cluster.source_ids.filter(
        (id) => !mergedRecordIds.has(id)
      );
      unresolvedByCluster.push({ index, missingIds });
    }
  });
  if (unresolvedByCluster.length > 0) {
    const detail = unresolvedByCluster
      .map(
        ({ index, missingIds }) =>
          `cluster ${index} claims ${missingIds.join(", ")}`
      )
      .join("; ");
    throw new Error(
      `[dedup] Model claimed source_id(s) in a cluster that don't match any input record (hallucinated id, not just an unresolved duplicate): ${detail}`
    );
  }

  return { clusters: clustersWithRecords, standalone };
}

module.exports = { dedupRecords };