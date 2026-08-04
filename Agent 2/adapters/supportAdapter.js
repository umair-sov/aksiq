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
    // A case is unusable without a stable id and without notes — notes
    // IS the text content here. `client` being null is expected and
    // fine (see SUP-7784), same reasoning as `account`/`customer` in the
    // other two adapters.
    if (!caseId || !notes) {
      console.warn(
        `[supportAdapter] Skipping malformed record (missing caseId or notes):`,
        rawRecord
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