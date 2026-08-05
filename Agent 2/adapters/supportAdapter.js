// adapters/supportAdapter.js
//
// Converts raw support.json records into the pipeline's common shape:
//   { source, source_id, timestamp, entity, text, raw }
//
// Flat array like sales.json, but with its own field names
// (caseId, opened, client, notes). Same isolation-boundary rule as the
// other two adapters: this file is the only place that knows those
// names.
//
// Malformed-record policy, same as sales/ops: this adapter decides
// what "malformed" means for support data, and returns null for
// anything that should be skipped. Here that's SUP-7785 — a case with
// no `notes`, meaning no text content to normalize.

/**
 * Normalize a single raw support case.
 *
 * @param {object} rawRecord - one entry from support.json
 * @returns {object|null} a common-shape record, or null if malformed
 */
function normalizeSupportRecord(rawRecord) {
    const { caseId, opened, client, notes } = rawRecord;
  
    // --- Malformed check ---
    // A case is unusable without a stable id, without notes — notes IS
    // the text content here — or without a date that actually parses (an
    // unparseable date would otherwise reach `.toISOString()` below and
    // throw an unhandled RangeError). `client` being null is expected and
    // fine (see SUP-7784), same reasoning as `account`/`customer` in the
    // other two adapters.
    const malformedReasons = [];
    if (!caseId) malformedReasons.push("missing caseId");
    if (!notes) malformedReasons.push("missing notes");
    if (Number.isNaN(new Date(opened).getTime())) malformedReasons.push("invalid date");

    if (malformedReasons.length > 0) {
      // Log only the record's own identifier and the reason(s) — never the
      // raw record body. Support cases carry customer complaint text that
      // shouldn't be dumped to logs unredacted once this is wired to real
      // Zendesk/Freshdesk/Intercom data.
      console.warn(
        `[supportAdapter] Skipping malformed record (caseId: ${caseId || "unknown"}) - ${malformedReasons.join(", ")}`
      );
      return null;
    }
  
    return {
      source: "support",
      source_id: caseId,
      // support dates are bare "YYYY-MM-DD" like sales, no time-of-day.
      timestamp: new Date(opened).toISOString(),
      entity: client ?? null,
      text: notes,
      raw: rawRecord,
    };
  }
  
  /**
   * Normalize an entire support.json payload (a flat array of cases).
   *
   * @param {object[]} rawEntries - the parsed contents of support.json
   * @returns {object[]} normalized records, with malformed entries dropped
   */
  function normalizeSupport(rawEntries) {
    if (!Array.isArray(rawEntries)) {
      console.warn(
        "[supportAdapter] Expected an array from support.json, got:",
        typeof rawEntries
      );
      return [];
    }
  
    return rawEntries
      .map(normalizeSupportRecord)
      .filter((record) => record !== null);
  }
  
  module.exports = { normalizeSupport, normalizeSupportRecord };