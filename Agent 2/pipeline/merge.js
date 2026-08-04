// pipeline/merge.js
//
// Combines the normalized output of all three adapters into one flat
// array. Also detects SOURCE-level failures (a whole source with zero
// records) — distinct from the per-record malformed skips the adapters
// already handle internally. This is the missing piece behind the
// `skipped` field in the final output, which used to be hardcoded to
// an empty array with no actual detection behind it.

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
 */
function mergeSources({ sales, ops, support }) {
  const skipped = [];
  const records = [];

  if (isEmptySalesOrSupport(sales)) {
    skipped.push({ source: "sales", reason: "empty" });
  } else {
    records.push(...normalizeSales(sales));
  }

  if (isEmptyOps(ops)) {
    skipped.push({ source: "ops", reason: "empty" });
  } else {
    records.push(...normalizeOps(ops));
  }

  if (isEmptySalesOrSupport(support)) {
    skipped.push({ source: "support", reason: "empty" });
  } else {
    records.push(...normalizeSupport(support));
  }

  return { records, skipped };
}

module.exports = { mergeSources };