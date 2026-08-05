// index.js
//
// The single entry point for the whole pipeline: load fixtures -> merge
// -> dedup -> synthesize -> emit. Everything up to now has been proven
// in isolation via throwaway testX.js scripts (testDedup.js,
// testSynthesize.js) — this is the first point the pipeline runs as
// ONE thing, end to end, on a real run rather than a stage-by-stage
// check.
//
// Run with: node index.js

const fs = require("fs");
const path = require("path");

const { mergeSources } = require("./pipeline/merge");
const { dedupRecords } = require("./pipeline/dedup");
const { synthesize } = require("./pipeline/synthesize");
const { emit } = require("./pipeline/emit");

// --- Dedup checkpoint -----------------------------------------------------
//
// dedupRecords() is a PAID LLM call. If synthesize() or emit() fails after
// dedup already succeeded, restarting the whole run used to mean paying for
// dedup all over again even though its result was already correct. This is
// a single, hardcoded checkpoint for dedup's output only — deliberately not
// a general-purpose checkpointing framework, and no other stage gets one.
//
// Lifecycle:
//   1. Before calling dedupRecords(), check for a checkpoint file. If it
//      exists (and matches this run's input — see below), reuse it and skip
//      the LLM call.
//   2. Otherwise call dedupRecords() as normal, then write its result to
//      the checkpoint file before moving on to synthesize().
//   3. Once emit() has succeeded — i.e. the FULL run succeeded — delete the
//      checkpoint file, so the next run starts fresh.
//   4. A missing, corrupt, or unreadable checkpoint is never fatal: it just
//      falls back to a normal fresh dedupRecords() call.
//
// Path: resolved the same way pipeline/emit.js resolves its default output
// dir (path.resolve(__dirname, "..", "output"), from pipeline/). index.js
// already lives at the package root, so the equivalent from here is
// path.resolve(__dirname, "output").
const CHECKPOINT_PATH = path.resolve(__dirname, "output", ".checkpoint-dedup.json");

/**
 * Cheap, non-cryptographic fingerprint of the merged record set. Its only
 * job is to catch the common "stale checkpoint" case — fixtures edited, or a
 * source added/removed/emptied — between the run that wrote the checkpoint
 * and the run that would reuse it. It compares source+source_id pairs, so it
 * will NOT catch a record whose id stayed the same but whose text/content
 * changed; a full content hash would catch that too but is more than this
 * "keep it simple" checkpoint is meant to carry. Given this only guards a
 * local, single-user fixture pipeline, that tradeoff is fine.
 */
function signatureOf(records) {
  return records.map((r) => `${r.source}/${r.source_id}`).sort();
}

function sameSignature(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, i) => value === b[i])
  );
}

/**
 * Validate a single record as persisted to the checkpoint: the common-shape
 * fields (source, source_id, timestamp, entity, text). Deliberately does
 * NOT require `raw` — writeDedupCheckpoint() below strips `raw` before
 * serializing (data-minimization: see the comment there), so a legitimately
 * -written checkpoint will never have it. Requiring it here would make
 * every checkpoint this file writes fail its own read-side validation.
 */
function isValidCheckpointRecord(record) {
  return (
    record !== null &&
    typeof record === "object" &&
    typeof record.source === "string" &&
    typeof record.source_id === "string" &&
    typeof record.timestamp === "string" &&
    (typeof record.entity === "string" || record.entity === null) &&
    typeof record.text === "string" &&
    record.text.trim().length > 0
  );
}

/**
 * Validate a single cluster as persisted to the checkpoint: a `source_ids`
 * array and a `records` array of the SAME length (mirroring the
 * `cluster.records.length === cluster.source_ids.length` invariant
 * dedup.js itself enforces), with every record in `records` individually
 * valid.
 */
function isValidCheckpointCluster(cluster) {
  return (
    cluster !== null &&
    typeof cluster === "object" &&
    Array.isArray(cluster.source_ids) &&
    Array.isArray(cluster.records) &&
    cluster.source_ids.length === cluster.records.length &&
    cluster.records.every(isValidCheckpointRecord)
  );
}

/**
 * Read+validate the dedup checkpoint, if any. Returns null (and logs why)
 * for: no file, corrupt/unreadable JSON, unexpected top-level shape,
 * malformed nested cluster/record contents, or a signature mismatch
 * against the current run's merged records — in every case the caller
 * falls back to a fresh dedupRecords() call rather than crashing deep
 * inside a later stage on garbage checkpoint data.
 */
function readDedupCheckpoint(expectedSignature) {
  if (!fs.existsSync(CHECKPOINT_PATH)) return null;

  let parsed;
  try {
    const raw = fs.readFileSync(CHECKPOINT_PATH, "utf-8");
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[index] Checkpoint file exists but couldn't be read/parsed (${err.message}) — ignoring it, running dedup fresh.`
    );
    return null;
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray(parsed.clusters) ||
    !Array.isArray(parsed.standalone) ||
    !Array.isArray(parsed.inputSignature)
  ) {
    console.warn(
      "[index] Checkpoint file has an unexpected shape — ignoring it, running dedup fresh."
    );
    return null;
  }

  if (
    !parsed.clusters.every(isValidCheckpointCluster) ||
    !parsed.standalone.every(isValidCheckpointRecord)
  ) {
    console.warn(
      "[index] Checkpoint file has malformed cluster/record contents — ignoring it, running dedup fresh."
    );
    return null;
  }

  if (!sameSignature(parsed.inputSignature, expectedSignature)) {
    console.warn(
      "[index] Checkpoint exists but doesn't match this run's input (sources/fixtures changed since it was written) — ignoring it, running dedup fresh."
    );
    return null;
  }

  return { clusters: parsed.clusters, standalone: parsed.standalone };
}

/** Drop a record's `raw` field, returning a new object (never mutates the input). */
function stripRaw(record) {
  const { raw, ...rest } = record;
  return rest;
}

/** Write dedup's result to the checkpoint file. Failure here is non-fatal. */
function writeDedupCheckpoint(inputSignature, dedupResult) {
  try {
    fs.mkdirSync(path.dirname(CHECKPOINT_PATH), { recursive: true });

    // Strip `raw` (the untouched original source record) before persisting.
    // For real, non-fixture sources `raw` could hold full customer/deal/
    // complaint content — no reason for that to sit in plaintext on local
    // disk between runs. The checkpoint only exists so a resumed run can
    // skip re-calling dedup, and nothing downstream needs `raw` for that:
    // synthesize() only ever reads source/source_id/entity/text from
    // records. Build fresh copies here rather than mutating dedupResult
    // itself, since run() passes that exact object into synthesize() right
    // after this call and must still see `raw` there.
    const clusters = dedupResult.clusters.map((cluster) => ({
      ...cluster,
      records: cluster.records.map(stripRaw),
    }));
    const standalone = dedupResult.standalone.map(stripRaw);

    fs.writeFileSync(
      CHECKPOINT_PATH,
      JSON.stringify(
        {
          inputSignature,
          clusters,
          standalone,
        },
        null,
        2
      ),
      "utf-8"
    );
    console.log(`[index] Wrote dedup checkpoint: ${CHECKPOINT_PATH}`);
  } catch (err) {
    // Worst case if this fails: a retry just re-runs dedup, same as today.
    console.warn(`[index] Couldn't write dedup checkpoint (${err.message}) — continuing without it.`);
  }
}

/** Remove the checkpoint once a full run has succeeded end to end. */
function clearDedupCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      fs.unlinkSync(CHECKPOINT_PATH);
      console.log("[index] Cleared dedup checkpoint (full run succeeded).");
    }
  } catch (err) {
    console.warn(`[index] Couldn't remove checkpoint file after a successful run (${err.message}).`);
  }
}

async function run() {
  console.log("[index] Loading fixtures...");
  const sales = require("./fixtures/sales.json");
  const ops = require("./fixtures/ops.json");
  const support = require("./fixtures/support.json");

  console.log("[index] Merging + normalizing...");
  const { records: merged, skipped } = mergeSources({ sales, ops, support });
  console.log(`[index] ${merged.length} records after normalize/merge.`);
  if (skipped.length > 0) {
    console.log(`[index] ${skipped.length} source(s) skipped:`, skipped);
  }

  const inputSignature = signatureOf(merged);
  const checkpoint = readDedupCheckpoint(inputSignature);

  let clusters, standalone;
  if (checkpoint) {
    console.log("[index] Resuming from dedup checkpoint — skipping dedup LLM call.");
    ({ clusters, standalone } = checkpoint);
  } else {
    console.log("[index] Running dedup (LLM call)...");
    ({ clusters, standalone } = await dedupRecords(merged));
    writeDedupCheckpoint(inputSignature, { clusters, standalone });
  }
  console.log(
    `[index] Dedup found ${clusters.length} cluster(s), ${standalone.length} standalone record(s).`
  );

  console.log("[index] Synthesizing summary (LLM call)...");
  const summary = await synthesize({ clusters, standalone }, skipped);

  console.log("[index] Validating + writing output...");
  const { jsonPath, markdownPath } = emit(summary);

  // Full run succeeded end to end — the checkpoint's job is done. Clear it
  // so the next run doesn't reuse dedup output from a different input.
  clearDedupCheckpoint();

  console.log("[index] Done.");
  console.log(`[index] JSON:     ${jsonPath}`);
  console.log(`[index] Markdown: ${markdownPath}`);
}

run().catch((err) => {
  console.error("[index] Pipeline failed:", err.message);
  process.exit(1);
});
