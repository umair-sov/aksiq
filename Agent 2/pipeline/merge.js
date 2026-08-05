// pipeline/merge.js
//
// Combines the normalized output of all three adapters into one flat
// array. Also detects SOURCE-level failures — distinct from the
// per-record malformed skips the adapters already handle internally.
// Two ways a source can fail at that level: "empty" (zero raw records
// to begin with) or "all_malformed" (had raw records, but every one
// of them failed its adapter's malformed-record check, leaving zero
// usable records). This is the missing piece behind the `skipped`
// field in the final output, which used to be hardcoded to an empty
// array with no actual detection behind it.

const { normalizeSales } = require("../adapters/salesAdapter");
const { normalizeOps } = require("../adapters/opsAdapter");
const { normalizeSupport } = require("../adapters/supportAdapter");

/** True if a raw source payload has zero records to work with. */
function isEmptySalesOrSupport(raw) {
  return !Array.isArray(raw) || raw.length === 0;
}
function isEmptyOps(raw) {
  return !Array.isArray(raw?.entries) || raw.entries.length === 0;
}

/**
 * @param {object} rawSources - { sales, ops, support } raw parsed JSON
 * @returns {{ records: object[], skipped: object[] }}
 *   records: common-shape records from all sources, malformed entries
 *     already dropped by the adapters
 *   skipped: source-level failures, e.g. [{ source: "support", reason: "empty" }]
 *     or [{ source: "support", reason: "all_malformed" }]
 */
function mergeSources({ sales, ops, support }) {
  const skipped = [];
  const records = [];

  if (isEmptySalesOrSupport(sales)) {
    skipped.push({ source: "sales", reason: "empty" });
  } else {
    const normalized = normalizeSales(sales);
    if (normalized.length === 0) {
      skipped.push({ source: "sales", reason: "all_malformed" });
    }
    records.push(...normalized);
  }

  if (isEmptyOps(ops)) {
    skipped.push({ source: "ops", reason: "empty" });
  } else {
    const normalized = normalizeOps(ops);
    if (normalized.length === 0) {
      skipped.push({ source: "ops", reason: "all_malformed" });
    }
    records.push(...normalized);
  }

  if (isEmptySalesOrSupport(support)) {
    skipped.push({ source: "support", reason: "empty" });
  } else {
    const normalized = normalizeSupport(support);
    if (normalized.length === 0) {
      skipped.push({ source: "support", reason: "all_malformed" });
    }
    records.push(...normalized);
  }

  return { records, skipped };
}

module.exports = { mergeSources };