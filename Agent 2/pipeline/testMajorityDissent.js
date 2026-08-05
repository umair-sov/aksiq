// pipeline/testMajorityDissent.js — throwaway test runner, not part of the pipeline
//
// Investigates a case that's never been deliberately exercised: every
// contradiction case tested so far in this project has been a clean
// 2-record, 1-vs-1 disagreement (the real fixture's Umbrella Ltd case —
// SAL-005 says the deal closed, OPS-1042 says the contract is still
// pending legal review). dedup.js's SYSTEM_PROMPT tells the model that
// contradicting records about the same event should still be clustered
// ("do not use 'these facts conflict' as a reason to treat two records
// as unrelated"), and synthesize.js's SYSTEM_PROMPT tells it to "surface
// BOTH facts and flag the disagreement explicitly" when a cluster's
// records contradict each other.
//
// Neither prompt has ever been exercised against a 3-member cluster with
// a 2-vs-1 majority/minority split instead of a clean 1-vs-1. Two open
// questions the 1-vs-1 case can't answer:
//   - Does dedup still cluster all 3 records together as one event, or
//     does the odd-one-out get left standalone?
//   - synthesize.js's SYSTEM_PROMPT gives the model exactly two modes:
//     "AGREE -> combine detail into one clear sentence" or "CONTRADICT
//     -> surface both facts and flag explicitly." A 2-vs-1 split is
//     technically a contradiction (not everyone agrees), but it also
//     LOOKS more like "agreement with an outlier" than a clean two-sided
//     disagreement — the majority may pull the model toward the "AGREE
//     and combine" branch, smoothing the dissenting minority view into
//     a footnote or dropping it, rather than triggering the "flag
//     explicitly" branch the prompt's own example (Umbrella Ltd) is
//     modeled on.
//
// Three SYNTHETIC records (not fixture data), all unambiguously about
// the same deal at the same fictional company — same entity name,
// overlapping week, cross-referencing details (contract, onboarding,
// paperwork) — so there's no question a human would cluster them. The
// only open variable is the 2-vs-1 split on the underlying fact:
//   - sales:   deal is closed/signed.
//   - ops:     agrees — contract processed, onboarding under way.
//   - support: dissents — the customer's own contact says she never
//              received or signed final paperwork, casting doubt on
//              whether it's actually closed.
//
// "Meridian Robotics" is a fictional entity name chosen to NOT collide
// with any real fixture entity (Acme Corp, Globex Inc, Hooli, Initech,
// Soylent Corp, Stark Industries, Umbrella Ltd, Vandelay Industries,
// Wayne Enterprises) — this must not be mistaken for real fixture data.

const { dedupRecords } = require("./dedup");
const { synthesize } = require("./synthesize");

const salesRecord = {
  source: "sales",
  source_id: "SAL-901",
  timestamp: "2026-07-21T15:30:00Z",
  entity: "Meridian Robotics",
  text:
    "Meridian Robotics deal has closed — contract signed and " +
    "countersigned as of Tuesday afternoon.",
  raw: { deal_id: "DEAL-901", stage: "closed_won", amount: 84000 },
};

const opsRecord = {
  source: "ops",
  source_id: "OPS-902",
  timestamp: "2026-07-22T09:15:00Z",
  entity: "Meridian Robotics",
  text:
    "Meridian Robotics contract has been processed on our end; " +
    "onboarding kicked off Wednesday morning with their IT team.",
  raw: { ticket_id: "OPS-902", system: "Onboarding", status: "in_progress" },
};

const supportRecord = {
  source: "support",
  source_id: "SUP-903",
  timestamp: "2026-07-23T13:45:00Z",
  entity: "Meridian Robotics",
  text:
    "Meridian Robotics's primary contact called in confused — she says " +
    "she never received or signed any final contract paperwork on their " +
    "end, and is asking us to confirm whether the deal actually closed.",
  raw: { ticket_id: "SUP-903", tags: ["billing", "contract"], priority: "medium" },
};

const records = [salesRecord, opsRecord, supportRecord];

console.log("=== Majority/dissent (2-vs-1) dedup+synthesize probe ===");
console.log(
  "Input records (sales + ops agree 'closed', support dissents — all 3 " +
    "about the same Meridian Robotics deal):"
);
console.log(JSON.stringify(records, null, 2));

dedupRecords(records)
  .then((dedupResult) => {
    console.log("\n=== dedupRecords() result ===");
    console.log(JSON.stringify(dedupResult, null, 2));

    const cluster = dedupResult.clusters.find(
      (c) =>
        c.source_ids.includes("SAL-901") &&
        c.source_ids.includes("OPS-902") &&
        c.source_ids.includes("SUP-903")
    );
    const allThreeClusteredTogether =
      dedupResult.clusters.length === 1 && cluster && cluster.source_ids.length === 3;

    console.log(
      `\n=== Dedup verdict: ${
        allThreeClusteredTogether
          ? "ALL 3 CLUSTERED TOGETHER as one group"
          : "NOT all 3 clustered together — see clusters/standalone above"
      } ===`
    );

    return synthesize(dedupResult, []);
  })
  .then((result) => {
    console.log("\n=== synthesize() result (full pipeline output) ===");
    console.log(JSON.stringify(result, null, 2));

    const mergedEvent = result.merged_events.find(
      (e) =>
        e.from.includes("sales/SAL-901") &&
        e.from.includes("ops/OPS-902") &&
        e.from.includes("support/SUP-903")
    );

    console.log("\n=== Synthesized highlight for the 3-way cluster ===");
    console.log(mergedEvent ? mergedEvent.event : "(no single 3-way merged_event found — check output above)");
  })
  .catch((err) => {
    console.error("pipeline failed:", err.message);
  });
