// adapters/opsAdapter.js
//
// Converts raw ops.json records into the pipeline's common shape:
//   { source, source_id, timestamp, entity, text, raw }
//
// Unlike sales.json, ops.json isn't a flat array — it's wrapped in
// { week, entries: [...] }. Unwrapping that nesting is this adapter's
// job alone; nothing downstream should ever see the "week" wrapper.
//
// Same malformed-record policy as salesAdapter.js: this adapter decides
// what "malformed" means for ops data specifically, and returns null
// for anything that should be skipped. Here, that's OPS-1043 — a ticket
// with no `description`, meaning there's no text content to normalize.

/**
 * Normalize a single raw ops ticket entry.
 *
 * @param {object} rawRecord - one entry from ops.json's `entries` array
 * @returns {object|null} a common-shape record, or null if malformed
 */
function normalizeOpsRecord(rawRecord) {
  const { ticket_id, reported_on, system, customer, description } = rawRecord;

  // --- Malformed check ---
  // For ops, a record is unusable without a stable id, without a
  // description — description IS the text content here, so a ticket
  // with no description has nothing to feed into synthesis — or without a
  // date that actually parses (an unparseable date would otherwise reach
  // `.toISOString()` below and throw an unhandled RangeError).
  // `customer` being missing/null is expected and fine (see OPS-1041,
  // OPS-1044, etc.) — most ops tickets have no customer at all.
  const malformedReasons = [];
  if (!ticket_id) malformedReasons.push("missing ticket_id");
  if (!description) malformedReasons.push("missing description");
  if (Number.isNaN(new Date(reported_on).getTime())) malformedReasons.push("invalid date");

  if (malformedReasons.length > 0) {
    // Log only the record's own identifier and the reason(s) — never the
    // raw record body. Ops tickets carry customer content that shouldn't
    // be dumped to logs unredacted once this is wired to real
    // PagerDuty/Jira/ServiceNow data.
    console.warn(
      `[opsAdapter] Skipping malformed record (ticket_id: ${ticket_id || "unknown"}) - ${malformedReasons.join(", ")}`
    );
    return null;
  }

  return {
    source: "ops",
    source_id: ticket_id,
    // ops timestamps already come in as full ISO 8601 with time-of-day,
    // unlike sales' bare dates — just pass through via Date to confirm
    // it's valid and land on a consistent string format.
    timestamp: new Date(reported_on).toISOString(),
    entity: customer ?? null,
    // Fold `system` into the text itself rather than dropping it, since
    // "what system this happened in" is useful context for synthesis
    // and there's no separate field for it in the common shape.
    text: `[${system}] ${description}`,
    raw: rawRecord,
  };
}

/**
 * Normalize an entire ops.json payload (nested under { week, entries }).
 *
 * @param {object} rawPayload - the parsed contents of ops.json
 * @returns {object[]} normalized records, with malformed entries dropped
 */
function normalizeOps(rawPayload) {
  const entries = rawPayload?.entries;

  if (!Array.isArray(entries)) {
    console.warn(
      "[opsAdapter] Expected rawPayload.entries to be an array, got:",
      rawPayload
    );
    return [];
  }

  return entries
    .map(normalizeOpsRecord)
    .filter((record) => record !== null);
}

module.exports = { normalizeOps, normalizeOpsRecord };