/**
 * emailLookup.js
 *
 * Small shared helper for looking up a cached email by a free-text query
 * (sender name, sender address, or subject keyword). Not run directly.
 *
 * Depends on:
 * - emails.json, produced by fetchEmails.js (read-only).
 *
 * Where it fits in the pipeline: used by draftReply.js to resolve a user-
 * supplied search term (from the /draft Discord command) to a specific
 * cached email.
 */
import fs from 'fs';

/**
 * Inputs: none.
 * Output: Array<Object> — the cached emails from emails.json, or [] if that
 * file doesn't exist yet (e.g. triage has never been run).
 * What it does: loads the full cached email list for searching.
 */
export function loadCachedEmails() {
  if (!fs.existsSync('emails.json')) return [];
  return JSON.parse(fs.readFileSync('emails.json', 'utf-8'));
}

/**
 * Inputs: query (string) — a free-text search term, expected to be a sender
 * name, sender email address, or subject keyword.
 * Output: Object|undefined — the first matching cached email record, or
 * undefined if none match.
 * What it does: finds a single cached email matching a loose, case-
 * insensitive text query.
 * How it does it: checks the query against the subject, sender display name,
 * and sender email address, returning the first email (in emails.json order)
 * where any of those three fields contains the query as a substring.
 */
export function findEmail(query) {
  const emails = loadCachedEmails();
  const lower = query.toLowerCase();
  return emails.find((e) =>
    e.subject.toLowerCase().includes(lower) ||
    (e.from.name || '').toLowerCase().includes(lower) ||
    e.from.email.toLowerCase().includes(lower)
  );
}