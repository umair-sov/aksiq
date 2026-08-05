// pipeline/testEmptyEntity.js — throwaway test runner, not part of the pipeline
//
// Investigates a case that's never been deliberately exercised: every
// adapter maps a missing/null entity field to `null` via `?? null`, but
// none of them guard against an upstream source sending an actual empty
// string `entity: ""` instead of `null`/`undefined`. dedup.js's
// SYSTEM_PROMPT tells the model records can describe the same event
// "even if their entity fields don't match, or one/both have no entity
// at all" — and primes it with "entity (may be null)". An empty string
// is neither a match nor (literally) null. Does the model still fall
// back to text similarity the way it does for a genuine null, or does
// `""` get treated as a real, present-but-mismatched entity value?
//
// Two SYNTHETIC records (not fixture data) modeled on the real
// OPS-1041/SUP-7784 precedent noted in dedup.js's comments and the
// README's "known limitations" section: an outage described two
// different ways by two different sources, where only the text content
// (not the entity field) signals it's the same event.
//
// Deliberate choice on the entity values: ops gets `entity: ""`, support
// gets `entity: null` — NOT `""` on both. Giving both records the same
// empty string would confound the test: two identical `""` values could
// trivially look like a matched entity to the model, which would produce
// clustering for the wrong reason and tell us nothing about whether `""`
// is being treated as "no entity." Pairing one true `null` (the case
// already confirmed to work via text-similarity fallback) against one
// `""` isolates the actual variable — does the model extend the same
// "no entity, fall back to text" treatment to `""` that it clearly
// extends to `null`, or does `""` register as a distinct, mismatched
// value against a genuine null on the other side?

const { dedupRecords } = require("./dedup");

const opsRecord = {
  source: "ops",
  source_id: "OPS-9911",
  timestamp: "2026-07-22T14:03:00Z",
  entity: "",
  text:
    "Checkout API returned 500s for roughly 40 minutes starting ~14:00 UTC; " +
    "root cause was a saturated DB connection pool after a deploy. Rolled " +
    "back and connections recovered by 14:45 UTC. No data loss.",
  raw: { incident_id: "INC-9911", severity: "high", service: "checkout-api" },
};

const supportRecord = {
  source: "support",
  source_id: "SUP-9911",
  timestamp: "2026-07-22T14:20:00Z",
  entity: null,
  text:
    "Spike of tickets between 2pm and 3pm from customers unable to complete " +
    "purchases — checkout kept failing with a generic error. Volume dropped " +
    "off after ~2:45pm once whatever was happening on the backend got fixed.",
  raw: { ticket_count: 27, tags: ["checkout", "outage"] },
};

console.log("=== Empty-entity dedup probe ===");
console.log("Input records (entity: \"\" vs entity: null, same underlying outage):");
console.log(JSON.stringify([opsRecord, supportRecord], null, 2));

dedupRecords([opsRecord, supportRecord])
  .then((result) => {
    console.log("\n=== dedupRecords() result ===");
    console.log(JSON.stringify(result, null, 2));

    const clustered =
      result.clusters.length === 1 &&
      result.clusters[0].source_ids.includes("OPS-9911") &&
      result.clusters[0].source_ids.includes("SUP-9911");

    console.log(
      `\n=== Verdict: ${clustered ? "CLUSTERED TOGETHER" : "NOT clustered together"} ===`
    );
  })
  .catch((err) => {
    console.error("dedup failed:", err.message);
  });
