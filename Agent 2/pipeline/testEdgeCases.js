// pipeline/testEdgeCases.js — throwaway test runner, not part of the pipeline
const { mergeSources } = require("./merge");
const { dedupRecords } = require("./dedup");
const { synthesize } = require("./synthesize");
const { emit } = require("./emit");

const sales = require("../fixtures/sales.json");
const ops = require("../fixtures/ops.json");
const support = require("../fixtures/support.json");

async function testEmptySource() {
  console.log("\n=== Edge case 1: empty support source ===");
  const { records, skipped } = mergeSources({ sales, ops, support: [] });
  console.log(`Records: ${records.length} (expect 17 — support's 8 excluded)`);
  console.log("Skipped:", JSON.stringify(skipped));
}

async function testSingleSource() {
  console.log("\n=== Edge case 2: single source only (sales) ===");
  const { records, skipped } = mergeSources({
    sales,
    ops: { week: "x", entries: [] },
    support: [],
  });
  console.log(`Records: ${records.length} (expect 10 — sales only)`);
  console.log("Skipped:", JSON.stringify(skipped));

  const { clusters, standalone } = await dedupRecords(records);
  console.log(
    `Dedup on single source: ${clusters.length} cluster(s), ${standalone.length} standalone — expect 0 clusters, since there's only one source, nothing to cross-reference against`
  );
}

async function testZeroRecords() {
  console.log("\n=== Edge case 3: zero records overall ===");
  const { records, skipped } = mergeSources({
    sales: [],
    ops: { week: "x", entries: [] },
    support: [],
  });
  console.log(`Records: ${records.length} (expect 0)`);
  console.log("Skipped:", JSON.stringify(skipped));

  const dedupResult = await dedupRecords(records);
  console.log("Dedup result (expect no API call, empty result):", JSON.stringify(dedupResult));

  const summary = await synthesize(dedupResult, skipped);
  console.log("Synthesize result (expect no API call, 'no data' summary):");
  console.log(JSON.stringify(summary, null, 2));

  const { jsonPath, markdownPath } = emit(summary, {
    filenameBase: "edge-case-zero-records",
  });
  console.log("Emitted:", jsonPath, markdownPath);
}

async function main() {
  await testEmptySource();
  await testSingleSource();
  await testZeroRecords();
}

main().catch((err) => console.error("Edge case test failed:", err.message));