// pipeline/emit.js
//
// Takes the object synthesize() returns and actually does something
// with it: validates the shape (so a bug upstream fails loudly here,
// not silently as a malformed file), writes it to disk as JSON (the
// structured "contract" per D5), and renders a plain-language markdown
// version alongside it (the "prose" a human actually reads).
//
// Nothing upstream of this file has persisted anything yet — every
// stage so far has just been console.log'd from a throwaway test
// script. This is the first point the pipeline produces a real,
// standing artifact.

const fs = require("fs");
const path = require("path");

/**
 * Validate the shape coming out of synthesize(). Throws with a specific,
 * actionable message on the first thing that's wrong, rather than
 * writing a malformed file and finding out later.
 *
 * @param {object} summary - output of synthesize()
 */
function validateSummary(summary) {
  if (typeof summary !== "object" || summary === null) {
    throw new Error("[emit] Expected synthesize() to return an object.");
  }

  if (typeof summary.period !== "string" || summary.period.trim() === "") {
    throw new Error("[emit] Missing or invalid `period` (expected a non-empty string).");
  }

  if (!Array.isArray(summary.sections)) {
    throw new Error("[emit] Missing or invalid `sections` (expected an array).");
  }
  summary.sections.forEach((section, i) => {
    if (typeof section.group !== "string" || section.group.trim() === "") {
      throw new Error(`[emit] sections[${i}] is missing a valid \`group\`.`);
    }
    if (!Array.isArray(section.highlights)) {
      throw new Error(`[emit] sections[${i}] ("${section.group}") is missing a valid \`highlights\` array.`);
    }
    section.highlights.forEach((h, j) => {
      if (typeof h !== "string" || h.trim() === "") {
        throw new Error(`[emit] sections[${i}].highlights[${j}] is not a non-empty string.`);
      }
    });
  });

  if (!Array.isArray(summary.merged_events)) {
    throw new Error("[emit] Missing or invalid `merged_events` (expected an array).");
  }
  summary.merged_events.forEach((event, i) => {
    if (typeof event.event !== "string" || event.event.trim() === "") {
      throw new Error(`[emit] merged_events[${i}] is missing a valid \`event\` string.`);
    }
    if (!Array.isArray(event.from) || event.from.length < 2) {
      throw new Error(
        `[emit] merged_events[${i}] ("${event.event}") should have a \`from\` array with at least 2 entries — a merge with fewer than 2 sources isn't really a merge.`
      );
    }
  });

  if (!Array.isArray(summary.skipped)) {
    throw new Error("[emit] Missing or invalid `skipped` (expected an array, even if empty).");
  }

  // --- Cross-check: every merged_event's records should trace back to
  // an actual section somewhere. This won't catch every possible bug,
  // but it catches the most likely one: a cluster whose highlight text
  // never made it into `sections` at all.
  const allHighlightText = summary.sections.flatMap((s) => s.highlights);
  const missingFromSections = summary.merged_events.filter(
    (event) => !allHighlightText.includes(event.event)
  );
  if (missingFromSections.length > 0) {
    console.warn(
      "[emit] Warning: some merged_events don't have a matching highlight in `sections` — " +
        "these events are logged in the audit trail but won't appear in the readable summary:",
      missingFromSections.map((e) => e.event)
    );
  }
}

/**
 * Render the summary as readable markdown — this is the "prose" half
 * of D5, meant for a human to actually read, as opposed to the JSON
 * which is the structured contract other code/tests work against.
 *
 * @param {object} summary - a validated synthesize() output
 * @returns {string} markdown text
 */
function renderMarkdown(summary) {
  const lines = [];

  lines.push(`# Weekly Status Summary — ${summary.period}`, "");

  for (const section of summary.sections) {
    lines.push(`## ${section.group}`, "");
    for (const highlight of section.highlights) {
      lines.push(`- ${highlight}`);
    }
    lines.push("");
  }

  if (summary.merged_events.length > 0) {
    lines.push("## Merged events (audit log)", "");
    lines.push(
      "The following records were identified as describing the same underlying event and were combined above:",
      ""
    );
    for (const event of summary.merged_events) {
      lines.push(`- **${event.from.join(", ")}** \u2192 "${event.event}"`);
    }
    lines.push("");
  }

  if (summary.skipped.length > 0) {
    lines.push("## Skipped sources", "");
    for (const s of summary.skipped) {
      lines.push(`- ${s.source}: ${s.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Validate and write the summary to disk as both JSON and markdown.
 *
 * Filenames default to a period-derived slug (e.g.
 * "summary-2026-07-20_to_2026-07-24"). If a file already exists at that
 * path — most commonly a repeat run against the same period — a Unix
 * timestamp is appended to both filenames instead of silently overwriting
 * the previous run's output (e.g.
 * "summary-2026-07-20_to_2026-07-24_1785847177.json"). The clean,
 * unsuffixed name is used whenever it wouldn't collide with an existing
 * file.
 *
 * Alongside that versioned pair, `summary-latest.json` / `summary-latest.md`
 * are also written every run, unconditionally overwritten — no collision
 * check, no versioning. They always hold the exact same content as the
 * versioned pair from the run that just completed, giving a stable
 * "check one filename for the most recent run" path without disturbing
 * the versioned audit history above.
 *
 * @param {object} summary - output of synthesize()
 * @param {object} [options]
 * @param {string} [options.outputDir] - defaults to Agent 2/output
 * @param {string} [options.filenameBase] - defaults to a period-based slug
 * @returns {{ jsonPath: string, markdownPath: string, latestJsonPath: string, latestMarkdownPath: string }}
 */
function emit(summary, options = {}) {
  validateSummary(summary);

  const outputDir = options.outputDir || path.resolve(__dirname, "..", "output");
  fs.mkdirSync(outputDir, { recursive: true });

  const baseFilenameBase =
    options.filenameBase || `summary-${summary.period.replace(/\s+/g, "_")}`;

  let filenameBase = baseFilenameBase;
  let jsonPath = path.join(outputDir, `${filenameBase}.json`);
  let markdownPath = path.join(outputDir, `${filenameBase}.md`);

  // Don't silently clobber a previous run's output — the merged_events
  // audit trail only means something if it can't be overwritten out from
  // under you. Repeat runs against the same period get their own files.
  if (fs.existsSync(jsonPath) || fs.existsSync(markdownPath)) {
    filenameBase = `${baseFilenameBase}_${Math.floor(Date.now() / 1000)}`;
    jsonPath = path.join(outputDir, `${filenameBase}.json`);
    markdownPath = path.join(outputDir, `${filenameBase}.md`);
  }

  const jsonContent = JSON.stringify(summary, null, 2);
  const markdownContent = renderMarkdown(summary);

  fs.writeFileSync(jsonPath, jsonContent, "utf-8");
  fs.writeFileSync(markdownPath, markdownContent, "utf-8");

  // Always-overwritten convenience copy of the same content — unlike the
  // pair above, no versioning and no collision check: that's the point,
  // it's meant to be clobbered every run so there's one stable filename
  // for "the most recent summary," alongside the versioned history.
  const latestJsonPath = path.join(outputDir, "summary-latest.json");
  const latestMarkdownPath = path.join(outputDir, "summary-latest.md");
  fs.writeFileSync(latestJsonPath, jsonContent, "utf-8");
  fs.writeFileSync(latestMarkdownPath, markdownContent, "utf-8");

  console.log(`[emit] Wrote ${jsonPath}`);
  console.log(`[emit] Wrote ${markdownPath}`);
  console.log(`[emit] Wrote ${latestJsonPath}`);
  console.log(`[emit] Wrote ${latestMarkdownPath}`);

  return { jsonPath, markdownPath, latestJsonPath, latestMarkdownPath };
}

module.exports = { emit, validateSummary, renderMarkdown };