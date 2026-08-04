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
    // can't fall back on: a stable id, and the actual text content.
    // Note: `account` (our entity) being null is NOT malformed — it's a
    // valid record that just has no correlation hint. That's an expected,
    // designed-for case (see SAL-010 in the fixture), not an error.
    if (!id || !summary) {
      console.warn(
        `[salesAdapter] Skipping malformed record (missing id or summary):`,
        rawRecord
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