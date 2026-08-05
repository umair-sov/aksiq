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

// Shared OpenRouter request/retry/response-extraction boilerplate —
// see openRouterClient.js. Also the single source of truth for the
// MODEL default fallback now, so dedup.js and synthesize.js can't
// drift out of sync on it again.
const { callOpenRouter } = require("./openRouterClient");

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

  // Request-building, retry-with-backoff on transient failures (bad
  // HTTP status, network error, unparseable HTTP response body), and
  // extraction of the raw content string all live in the shared
  // helper now — see openRouterClient.js.
  const rawText = await callOpenRouter(
    SYSTEM_PROMPT,
    JSON.stringify(compactClusters, null, 2),
    { logLabel: "[synthesize]" }
  );

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseErr) {
    throw new Error(
      `[synthesize] Model response wasn't valid JSON. Raw content was:\n${rawText}\n\nParse error: ${parseErr.message}`
    );
  }

  // --- Validate response shape BEFORE using it. Without this: if the
  // model returns "highlights" as a STRING instead of an array, the
  // `for (const h of parsed.highlights)` loop below would silently
  // iterate individual characters (strings are iterable in JS) — no
  // crash, but h.cluster_index/h.highlight are undefined every time,
  // producing an empty/garbage highlightMap with no signal anything
  // went wrong. Fail loudly here instead. ---
  if (parsed.highlights !== undefined && !Array.isArray(parsed.highlights)) {
    throw new Error(
      `[synthesize] Model response shape invalid: expected "highlights" to be an array, got ${typeof parsed.highlights} (${JSON.stringify(parsed.highlights)}).`
    );
  }

  const highlights = parsed.highlights ?? [];

  highlights.forEach((h, i) => {
    if (h === null || typeof h !== "object" || Array.isArray(h)) {
      throw new Error(
        `[synthesize] Model response shape invalid: highlights[${i}] must be an object, got ${JSON.stringify(h)}.`
      );
    }
    if (typeof h.cluster_index !== "number") {
      // Also catches the case where the model emits "cluster_index": "0"
      // (a string) instead of 0 (a number) — without this check, that
      // response is well-formed enough to pass a looser check but still
      // silently misses in the Map.get(index) lookup below due to
      // strict key equality against the real numeric index.
      throw new Error(
        `[synthesize] Model response shape invalid: highlights[${i}].cluster_index must be a number, got ${typeof h.cluster_index} (${JSON.stringify(h.cluster_index)}).`
      );
    }
    if (typeof h.highlight !== "string") {
      throw new Error(
        `[synthesize] Model response shape invalid: highlights[${i}].highlight must be a string, got ${typeof h.highlight} (${JSON.stringify(h.highlight)}).`
      );
    }
    if (h.highlight.trim().length === 0) {
      throw new Error(
        `[synthesize] Model response shape invalid: highlights[${i}].highlight for cluster_index ${h.cluster_index} must not be empty or whitespace-only, got ${JSON.stringify(h.highlight)}.`
      );
    }
  });

  const highlightMap = new Map();
  for (const h of highlights) {
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
 * Look up cluster `index`'s synthesized highlight. If synthesis didn't
 * produce one for this cluster (the model omitted it from an otherwise
 * valid response, or the whole synthesize call short-circuited), fall
 * back to dedup's raw `reasoning` text — but never silently: this
 * fallback means synthesis quality degraded for that cluster, so it's
 * always logged with a loud console.warn naming which cluster and why.
 */
function resolveHighlight(index, cluster, clusterHighlights) {
  const highlight = clusterHighlights.get(index);
  if (highlight === undefined) {
    console.warn(
      `[synthesize] No synthesized highlight for cluster ${index} — falling back to raw dedup reasoning ("${cluster.reasoning}"). This means synthesis quality degraded for this cluster even though the overall response was otherwise valid.`
    );
    return cluster.reasoning;
  }
  return highlight;
}

/**
 * Build the merged_events audit log (D2/N4 — reviewability): what
 * clustered with what, and why, in plain "source/source_id" form.
 * Takes already-resolved highlights (see resolveHighlight above) so the
 * fallback warning, if any, was already logged once by the caller
 * rather than a second time here.
 */
function buildMergedEvents(clusters, resolvedHighlights) {
  return clusters.map((cluster, index) => ({
    event: resolvedHighlights[index],
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

  // Resolve each cluster's highlight exactly once — this is also where
  // the fallback-to-raw-reasoning warning (if any) gets logged, so it's
  // logged a single time per cluster rather than once per usage site
  // below (sections + merged_events both need the same resolved value).
  const resolvedHighlights = clusters.map((cluster, index) =>
    resolveHighlight(index, cluster, clusterHighlights)
  );

  // group -> array of highlight strings
  const sectionsMap = {};

  // Standalone: pass through original text verbatim, grouped by source.
  for (const record of standalone) {
    const group = displaySource(record.source);
    (sectionsMap[group] ??= []).push(record.text);
  }

  // Clusters: grouped by every source they span, using the synthesized
  // (or, on failure, the raw dedup reasoning as a loudly-logged
  // fallback) highlight.
  clusters.forEach((cluster, index) => {
    const group = groupLabelForCluster(cluster);
    const highlight = resolvedHighlights[index];
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
    merged_events: buildMergedEvents(clusters, resolvedHighlights),
    // Now a REAL input from merge.js's source-level detection, not a
    // hardcoded placeholder. Per-record malformed skips (OPS-1043,
    // SUP-7785) still aren't in here — those are logged by their
    // adapters directly, since they're a different kind of failure
    // (a bad record within a valid source) than what this tracks
    // (a whole source that had nothing to give in the first place).
    skipped,
  };
}

module.exports = { synthesize, computePeriod };