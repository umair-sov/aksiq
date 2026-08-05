// pipeline/testDuplicateId.js — throwaway test runner, not part of the pipeline itself
//
// Investigative script (NOT a fixture change, NOT a fix). Purpose: exercise
// the never-before-triggered "[dedup] Duplicate source_ids in input" path in
// dedup.js with a hand-built mergedRecords array where two physically
// distinct records collide on the exact same {source, source_id}, but
// describe clearly different, unrelated events. See dedup.js for the
// mechanics being probed:
//   - the duplicate-id check only warns, it never throws or dedupes
//   - `mergedRecords.filter((r) => cluster.source_ids.includes(r.source_id))`
//     matches EVERY record sharing a claimed id, not just one
//   - a newer check throws if `cluster.records.length !== cluster.source_ids.length`
// This script does not assume which of these actually fires — it just runs
// the real call and logs the real result.

const { dedupRecords } = require("./dedup");

const mergedRecords = [
  // Two distinct records, same source AND same source_id (the collision),
  // but unrelated content — no legitimate reason for the model to treat
  // them as the same event on merit.
  {
    source: "ops",
    source_id: "OPS-9999",
    timestamp: "2026-07-21T09:15:00Z",
    entity: null,
    text: "Overnight billing-service database migration completed successfully with zero downtime.",
    raw: { note: "synthetic record A — migration event" },
  },
  {
    source: "ops",
    source_id: "OPS-9999",
    timestamp: "2026-07-22T14:40:00Z",
    entity: null,
    text: "Office printer hardware in the Chicago location is malfunctioning; replacement unit has been ordered.",
    raw: { note: "synthetic record B — unrelated hardware issue, same source_id as A by construction" },
  },
  // One ordinary, unambiguous record with a distinct id and no relation to
  // either record above — gives the model something uncontroversial to
  // leave standalone.
  {
    source: "sales",
    source_id: "SAL-9001",
    timestamp: "2026-07-23T11:00:00Z",
    entity: "Acme Corp",
    text: "Acme Corp signed a 2-year renewal contract worth $150k.",
    raw: { note: "synthetic record C — ordinary unrelated record" },
  },
];

dedupRecords(mergedRecords)
  .then((result) => {
    console.log("=== dedupRecords() result ===");
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((err) => {
    console.error("dedup failed:", err.message);
  });
