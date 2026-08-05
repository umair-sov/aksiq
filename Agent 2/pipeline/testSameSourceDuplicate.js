// pipeline/testSameSourceDuplicate.js — throwaway test runner, not part of
// the pipeline itself
//
// Investigates a case that's never been deliberately exercised: every
// planted duplicate/cross-reference case tested so far in this project has
// been CROSS-source (the real Globex Inc / Umbrella Ltd fixture cases, the
// OPS-1041/SUP-7784 entity-missing precedent, and testDuplicateId.js, which
// tested a source-side ID COLLISION bug — two records sharing the SAME
// source_id by construction, not this). Nobody has tested two DIFFERENT,
// legitimately-distinct records — different source_ids, no bug — from the
// SAME source describing the SAME real-world event: e.g. a sales rep's
// update getting logged twice under two different record ids (once from a
// manual CRM entry, once from a mobile-app sync), each with its own
// source_id, timestamp, and wording.
//
// dedup.js's SYSTEM_PROMPT and its own code comments discuss cross-source
// matching extensively (the entity-mismatch reasoning, the entity-missing
// fallback path via SAL-003/OPS-1041/SUP-7784) but never explicitly discuss
// same-source duplicates at all. Nothing in the prompt says "sources" must
// differ for two records to cluster, but nothing confirms it either — this
// script checks empirically whether the model (or anything else in the
// pipeline) implicitly assumes duplicates only happen across sources.
//
// Two SYNTHETIC records (not fixture data) describing the exact same deal
// update — same entity, same underlying event, different wording, both
// source: "sales" — with genuinely different source_ids (SAL-TEST-1 /
// SAL-TEST-2). This is NOT the duplicate-source_id-collision scenario
// tested in testDuplicateId.js: these are two legitimately distinct
// records that happen to describe one real-world event twice.
//
// Plus three additional, standalone sales records as noise: different
// companies, different events, unrelated to the duplicate pair or to each
// other — so the test isn't trivially "only two records exist, of course
// they'll get compared."

const { dedupRecords } = require("./dedup");

const duplicatePair = [
  {
    source: "sales",
    source_id: "SAL-TEST-1",
    timestamp: "2026-07-23T10:15:00Z",
    entity: "Cyberdyne Systems",
    text:
      "Cyberdyne Systems signed off on the enterprise tier upsell this " +
      "morning — $180k ARR, effective next billing cycle. Contract fully " +
      "executed.",
    raw: { rep: "J. Connor", stage: "closed_won", note: "logged from desktop CRM" },
  },
  {
    source: "sales",
    source_id: "SAL-TEST-2",
    timestamp: "2026-07-23T16:42:00Z",
    entity: "Cyberdyne Systems",
    text:
      "Closed the Cyberdyne Systems enterprise upsell today, $180k ARR — " +
      "paperwork is fully signed on both sides.",
    raw: { rep: "S. Connor", stage: "closed_won", note: "logged via mobile app sync, same afternoon" },
  },
];

const noiseRecords = [
  {
    source: "sales",
    source_id: "SAL-TEST-3",
    timestamp: "2026-07-23T09:00:00Z",
    entity: "Weyland-Yutani Corp",
    text:
      "Weyland-Yutani requested a custom SOC2 report before their legal " +
      "team will proceed with contract review.",
    raw: { rep: "E. Ripley", stage: "legal_review" },
  },
  {
    source: "sales",
    source_id: "SAL-TEST-4",
    timestamp: "2026-07-23T11:30:00Z",
    entity: "Tyrell Corporation",
    text:
      "Tyrell Corporation pushed back on the enterprise renewal price and " +
      "asked for a 10% discount before they'll sign.",
    raw: { rep: "R. Deckard", stage: "negotiation" },
  },
  {
    source: "sales",
    source_id: "SAL-TEST-5",
    timestamp: "2026-07-23T14:00:00Z",
    entity: "Oscorp Industries",
    text:
      "Scheduled a technical deep-dive call with Oscorp Industries' " +
      "engineering team for next Tuesday to unblock their eval.",
    raw: { rep: "N. Osborn", stage: "technical_eval" },
  },
];

const records = [...duplicatePair, ...noiseRecords];

console.log("=== Same-source duplicate dedup probe ===");
console.log(
  "Input records (SAL-TEST-1 / SAL-TEST-2: same source, different " +
    "source_ids, same underlying event; SAL-TEST-3/4/5: unrelated noise):"
);
console.log(JSON.stringify(records, null, 2));

dedupRecords(records)
  .then((result) => {
    console.log("\n=== dedupRecords() result ===");
    console.log(JSON.stringify(result, null, 2));

    const dupCluster = result.clusters.find(
      (c) =>
        c.source_ids.includes("SAL-TEST-1") &&
        c.source_ids.includes("SAL-TEST-2")
    );
    const duplicatesClustered = Boolean(dupCluster);

    const noiseIds = ["SAL-TEST-3", "SAL-TEST-4", "SAL-TEST-5"];
    const standaloneIds = new Set(result.standalone.map((r) => r.source_id));
    const noiseStayedStandalone = noiseIds.every((id) => standaloneIds.has(id));
    const noiseFalselyClustered = result.clusters.filter((c) =>
      c.source_ids.some((id) => noiseIds.includes(id))
    );

    console.log(
      `\n=== Verdict: duplicate pair ${
        duplicatesClustered ? "CLUSTERED TOGETHER" : "NOT clustered together"
      } ===`
    );
    if (dupCluster) {
      console.log(`Cluster reasoning: ${dupCluster.reasoning}`);
    }
    console.log(
      `=== Verdict: noise records ${
        noiseStayedStandalone ? "all stayed standalone" : "did NOT all stay standalone"
      } ===`
    );
    if (noiseFalselyClustered.length > 0) {
      console.log(
        "Noise record(s) unexpectedly pulled into a cluster:",
        JSON.stringify(noiseFalselyClustered, null, 2)
      );
    }
  })
  .catch((err) => {
    console.error("dedup failed:", err.message);
  });
