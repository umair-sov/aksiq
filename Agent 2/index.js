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

const { mergeSources } = require("./pipeline/merge");
const { dedupRecords } = require("./pipeline/dedup");
const { synthesize } = require("./pipeline/synthesize");
const { emit } = require("./pipeline/emit");

async function run() {
  console.log("[index] Loading fixtures...");
  const sales = require("./fixtures/sales.json");
  const ops = require("./fixtures/ops.json");
  const support = require("./fixtures/support.json");

  console.log("[index] Merging + normalizing...");
  const { records: merged, skipped } = mergeSources({ sales, ops, support });
  console.log(`[index] ${merged.length} records after normalize/merge.`);
  if (skipped.length > 0) {
    console.log(`[index] ${skipped.length} source(s) skipped (empty):`, skipped);
  }

  console.log("[index] Running dedup (LLM call)...");
  const { clusters, standalone } = await dedupRecords(merged);
  console.log(
    `[index] Dedup found ${clusters.length} cluster(s), ${standalone.length} standalone record(s).`
  );

  console.log("[index] Synthesizing summary (LLM call)...");
  const summary = await synthesize({ clusters, standalone }, skipped);

  console.log("[index] Validating + writing output...");
  const { jsonPath, markdownPath } = emit(summary);

  console.log("[index] Done.");
  console.log(`[index] JSON:     ${jsonPath}`);
  console.log(`[index] Markdown: ${markdownPath}`);
}

run().catch((err) => {
  console.error("[index] Pipeline failed:", err.message);
  process.exit(1);
});