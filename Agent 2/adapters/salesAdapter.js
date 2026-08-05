// adapters/salesAdapter.js
//
// Converts raw sales.json records into the pipeline's common shape:
//   { source, source_id, timestamp, entity, text, raw }
//
// This is the ONLY file that knows sales.json's specific field names
// (id, date, account, summary). Nothing downstream of normalize should
// ever need to know those names — that's the isolation boundary (D1)
// from the design doc.
//
// Malformed-record policy (decided before writing this): each adapter
// is responsible for deciding what "malformed" means for its own source,
// and returns null for anything that should be skipped. The shared
// merge step just filters out nulls and logs them — it never needs to
// know *why* a record from a given source was invalid.

/**
 * Normalize a single raw sales record.
 *
 * @param {object} rawRecord - one entry from sales.json
 * @returns {object|null} a common-shape record, or null if malformed
 */
function normalizeSalesRecord(rawRecord) {
    const { id, date, account, summary } = rawRecord;
  
    // --- Malformed check ---
    // For sales, a record is only unusable if it's missing the things we
    // can't fall back on: a stable id, the actual text content, or a date
    // that actually parses (an unparseable date would otherwise reach
    // `.toISOString()` below and throw an unhandled RangeError).
    // Note: `account` (our entity) being null is NOT malformed — it's a
    // valid record that just has no correlation hint. That's an expected,
    // designed-for case (see SAL-010 in the fixture), not an error.
    const malformedReasons = [];
    if (!id) malformedReasons.push("missing id");
    if (!summary) malformedReasons.push("missing summary");
    if (Number.isNaN(new Date(date).getTime())) malformedReasons.push("invalid date");

    if (malformedReasons.length > 0) {
      // Log only the record's own identifier and the reason(s) — never the
      // raw record body. Sales records carry account/deal content that
      // shouldn't be dumped to logs unredacted once this is wired to real
      // Salesforce data.
      console.warn(
        `[salesAdapter] Skipping malformed record (id: ${id || "unknown"}) - ${malformedReasons.join(", ")}`
      );
      return null;
    }
  
    return {
      source: "sales",
      source_id: id,
      // Sales dates are plain "YYYY-MM-DD" with no time component.
      // Normalize to ISO 8601 so every source ends up on the same format,
      // even though sales itself never had a time-of-day to begin with.
      timestamp: new Date(date).toISOString(),
      entity: account ?? null, // preserve null explicitly, don't default to ""
      text: summary,
      raw: rawRecord, // keep the untouched original for audit/debug
    };
  }
  
  /**
   * Normalize an entire sales.json payload (a flat array of records).
   *
   * @param {object[]} rawEntries - the parsed contents of sales.json
   * @returns {object[]} normalized records, with malformed entries dropped
   */
  function normalizeSales(rawEntries) {
    if (!Array.isArray(rawEntries)) {
      console.warn(
        "[salesAdapter] Expected an array from sales.json, got:",
        typeof rawEntries
      );
      return [];
    }
  
    return rawEntries
      .map(normalizeSalesRecord)
      .filter((record) => record !== null); // drop anything skipped above
  }
  
  module.exports = { normalizeSales, normalizeSalesRecord };