// pipeline/testSingleMalformed.js — throwaway test runner, not part of the pipeline
//
// Boundary case for merge.js's "all_malformed" detection: existing
// coverage (testEdgeCases.js) only ever exercises all_malformed against
// fixtures with MULTIPLE raw records per source. This checks a source
// with EXACTLY ONE raw record, where that one record is malformed —
// confirming it's still reported as "all_malformed" (had raw input, zero
// survived normalization) and not misreported as "empty" (had no raw
// input to begin with).
const { mergeSources } = require("./merge");

const sales = require("../fixtures/sales.json");
const ops = require("../fixtures/ops.json");

// Exactly one raw support record, missing `notes` — supportAdapter.js's
// malformed check requires `notes` (it's the text content), so this
// single record should fail normalization and leave support with zero
// usable records despite having had one raw record to start from.
const support = [{ caseId: "SUP-TEST", opened: "2026-07-20", client: "Test Co" }];

function testSingleMalformedSource() {
  console.log("\n=== Boundary case: single malformed support record ===");
  const { records, skipped } = mergeSources({ sales, ops, support });
  console.log(`Records: ${records.length} (expect 17 — sales+ops only, support contributes 0)`);
  console.log("Skipped:", JSON.stringify(skipped));

  const supportSkip = skipped.find((s) => s.source === "support");
  console.log(
    "Support skip reason:",
    supportSkip ? supportSkip.reason : "(no entry found)",
    "— expect 'all_malformed', not 'empty'"
  );
}

testSingleMalformedSource();
