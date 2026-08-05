// pipeline/testYearBoundary.js — throwaway test runner, not part of the pipeline
//
// Investigates a case that's never been deliberately exercised: computePeriod()
// in synthesize.js only ever gets called against a run's real records (which
// are all "this week", per the README's known-limitations notes on date-range
// filtering) or synthetic records built by prior investigative scripts, which
// have all stayed within a single short window. Nobody has tested what happens
// when the earliest and latest timestamps in a run straddle a YEAR boundary —
// e.g. a run that spans New Year's Eve into New Year's Day.
//
// computePeriod() itself:
//
//   function computePeriod(allRecords) {
//     const times = allRecords.map((r) => new Date(r.timestamp).getTime());
//     const start = new Date(Math.min(...times)).toISOString().slice(0, 10);
//     const end = new Date(Math.max(...times)).toISOString().slice(0, 10);
//     return start === end ? start : `${start} to ${end}`;
//   }
//
// It works off raw epoch millis (Math.min/Math.max over getTime()), not
// calendar-aware month/year fields, so nothing in the implementation itself
// looks year-boundary-specific — but that's exactly the kind of assumption
// worth confirming with a real run rather than just reading the source.
//
// THREE synthetic records (not fixture data), just the `timestamp` field
// since that's all computePeriod() reads: one just before midnight on
// 2026-12-30, one on New Year's Eve, and one a couple days into 2027 —
// giving Math.min/Math.max real cross-year values to resolve, and a
// slightly more realistic multi-record spread than testing only the two
// extremes.

const { computePeriod } = require("./synthesize");

const records = [
  { timestamp: "2026-12-30T10:00:00Z" },
  { timestamp: "2026-12-31T23:00:00Z" },
  { timestamp: "2027-01-02T15:00:00Z" },
];

console.log("=== Year-boundary computePeriod() probe ===");
console.log("Input records:");
console.log(JSON.stringify(records, null, 2));

const period = computePeriod(records);

console.log("\n=== computePeriod() result ===");
console.log(period);
