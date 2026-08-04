// pipeline/synthesize.js
//
// Turns dedup's output ({ clusters, standalone }) into the final
// output shape from the design doc:
//   { period, sections, merged_events, skipped }
//
// Two very different jobs live here, deliberately handled differently:
//
//   - CLUSTERS need synthesis: multiple sources describing one event,
//     sometimes in conflicting or overlapping language, need to become
//     ONE readable sentence. That's a genuine LLM job — one BATCHED
//     call across all clusters at once (not one call per cluster),
//     same cost-conscious pattern as dedup.js (N5).
//
//   - STANDALONE records need none of that. There's only one source's
//     account of the event — there's nothing to synthesize FROM. These
//     pass through with their original `text` untouched. Spending an
//     LLM call rewriting a single-source sentence would just be
//     rephrasing for its own sake, and risks quietly drifting from
//     what that source actually said (works against N1 - accuracy).
//
// Grouping: the design's grouping dimension for this domain is
// "source" (Sales/Ops/Support). Standalone records group cleanly under
// their one source. A cluster usually spans MULTIPLE sources, so it
// doesn't have a single "home" group — it's labeled with all
// contributing sources joined together (e.g. "Sales + Ops + Support"),
// rather than arbitrarily picked one and hidden the others.

require("../config/env");

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL =
  process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";

const SYSTEM_PROMPT = `You are writing a weekly status summary from clusters of records. Each cluster contains 2+ records from different sources describing the SAME real-world event.

For each cluster, write ONE synthesized sentence that captures the full picture from all the records in it.

Critical rules:
- If the records in a cluster AGREE, combine their detail into one clear sentence.
- If the records in a cluster CONTRADICT each other (report different facts about the same event), your sentence must surface BOTH facts and flag the disagreement explicitly — do not silently pick one side as "the truth." Example: "Sales reports the Umbrella Ltd deal as closed, though Ops still shows the contract pending legal review — these are out of sync and worth reconciling."
- Stay factual. Do not add detail that isn't present in the records.
- Write plain, readable prose — this is read by a human reviewing the week, not a machine.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "highlights": [
    { "cluster_index": 0, "highlight": "<one synthesized sentence>" }
  ]
}`;

/**
 * Get one synthesized highlight sentence per cluster, via a single
 * batched LLM call (not one call per cluster).
 *
 * @param {object[]} clusters - clusters from dedupRecords(), each with
 *   .records (the actual normalized record objects)
 * @returns {Promise<Map<number, string>>} cluster index -> highlight text
 */
async function synthesizeClusterHighlights(clusters) {
  if (clusters.length === 0) {
    return new Map();
  }

  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Export it before running synthesize."
    );
  }

  const compactClusters = clusters.map((cluster, index) => ({
    cluster_index: index,
    records: cluster.records.map((r) => ({
      source: r.source,
      entity: r.entity,
      text: r.text,
    })),
  }));

  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000, // same reasoning-model headroom as dedup.js
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(compactClusters, null, 2) },
      ],
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const rawText = data.choices?.[0]?.message?.content ?? "";

  console.log("[synthesize] Raw model response:", JSON.stringify(data, null, 2));

  if (!rawText || rawText.trim() === "") {
    throw new Error(
      "[synthesize] Model returned empty content. Full response logged above."
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseErr) {
    throw new Error(
      `[synthesize] Model response wasn't valid JSON. Raw content was:\n${rawText}\n\nParse error: ${parseErr.message}`
    );
  }

  const highlightMap = new Map();
  for (const h of parsed.highlights ?? []) {
    highlightMap.set(h.cluster_index, h.highlight);
  }
  return highlightMap;
}

/** Capitalize a source name for display ("sales" -> "Sales"). */
function displaySource(source) {
  return source.charAt(0).toUpperCase() + source.slice(1);
}

/**
 * Label a cluster's group by every source it spans, e.g. "Sales + Ops"
 * — never picks one contributing source and hides the others.
 */
function groupLabelForCluster(cluster) {
  const sources = [...new Set(cluster.records.map((r) => r.source))]
    .map(displaySource)
    .sort();
  return sources.join(" + ");
}

/** Earliest-to-latest timestamp span across every record in the run. */
function computePeriod(allRecords) {
  const times = allRecords.map((r) => new Date(r.timestamp).getTime());
  const start = new Date(Math.min(...times)).toISOString().slice(0, 10);
  const end = new Date(Math.max(...times)).toISOString().slice(0, 10);
  return start === end ? start : `${start} to ${end}`;
}

/**
 * Build the merged_events audit log (D2/N4 — reviewability): what
 * clustered with what, and why, in plain "source/source_id" form.
 */
function buildMergedEvents(clusters, clusterHighlights) {
  return clusters.map((cluster, index) => ({
    event: clusterHighlights.get(index) ?? cluster.reasoning,
    from: cluster.records.map((r) => `${r.source}/${r.source_id}`),
  }));
}

/**
 * @param {object} dedupResult - { clusters, standalone } from dedupRecords()
 * @param {object[]} [skipped] - source-level failures from merge.js,
 *   e.g. [{ source: "support", reason: "empty" }]. Defaults to none.
 * @returns {Promise<object>} { period, sections, merged_events, skipped }
 */
async function synthesize({ clusters, standalone }, skipped = []) {
  // Zero records overall (every source empty/failed) — nothing to
  // summarize. Emit a valid "no updates" summary instead of erroring
  // or calling the model with nothing to synthesize.
  if (clusters.length === 0 && standalone.length === 0) {
    console.log("[synthesize] No records at all — emitting an empty summary.");
    return {
      period: "no data",
      sections: [],
      merged_events: [],
      skipped,
    };
  }

  const clusterHighlights = await synthesizeClusterHighlights(clusters);

  // group -> array of highlight strings
  const sectionsMap = {};

  // Standalone: pass through original text verbatim, grouped by source.
  for (const record of standalone) {
    const group = displaySource(record.source);
    (sectionsMap[group] ??= []).push(record.text);
  }

  // Clusters: grouped by every source they span, using the synthesized
  // (or, on failure, the raw dedup reasoning as a fallback) highlight.
  clusters.forEach((cluster, index) => {
    const group = groupLabelForCluster(cluster);
    const highlight = clusterHighlights.get(index) ?? cluster.reasoning;
    (sectionsMap[group] ??= []).push(highlight);
  });

  const sections = Object.entries(sectionsMap).map(([group, highlights]) => ({
    group,
    highlights,
  }));

  const allRecords = [
    ...standalone,
    ...clusters.flatMap((c) => c.records),
  ];

  return {
    period: computePeriod(allRecords),
    sections,
    merged_events: buildMergedEvents(clusters, clusterHighlights),
    // Now a REAL input from merge.js's source-level detection, not a
    // hardcoded placeholder. Per-record malformed skips (OPS-1043,
    // SUP-7785) still aren't in here — those are logged by their
    // adapters directly, since they're a different kind of failure
    // (a bad record within a valid source) than what this tracks
    // (a whole source that had nothing to give in the first place).
    skipped,
  };
}

module.exports = { synthesize };