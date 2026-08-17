/**
 * fetchEmails.js
 *
 * First step of the `npm run triage` pipeline. Pulls the WINDOW_SIZE
 * most recent Gmail messages by date, skips any that already carry a
 * Triage/* label (already processed by a prior run), and caches the
 * rest to emails.json.
 *
 * STRICT-RECENCY, by design: this deliberately does NOT search with a
 * label-exclusion query and backfill to reach WINDOW_SIZE the way an
 * earlier version did. That older approach meant "the 25 most recent"
 * could silently mean "the 25 most recent among mail from days ago,"
 * once enough of the truly-recent mail had already been labeled by
 * prior runs. This version fetches the WINDOW_SIZE most recent
 * messages, full stop, and explicitly skips (with a loud, per-message
 * log line — never silent) whichever of those are already labeled.
 * The real cost of this trade-off: any older unlabeled backlog outside
 * the current window is now permanently orphaned unless someone
 * manually goes and finds it. A run can legitimately produce fewer
 * than WINDOW_SIZE emails, or zero — that's expected, not an error.
 * emailPriority.js's chunking already handles any array length
 * correctly with no changes needed there.
 *
 * NOTE: despite this file's previous header comment claiming an
 * unread-only filter, the actual query never included is:unread — this
 * version keeps that same (real, not documented-but-wrong) behavior:
 * read and unread messages are both candidates. If unread-only
 * filtering is wanted, that's a separate, deliberate change to make,
 * not bundled into this one.
 *
 * Depends on:
 * - googleAuth.js for an authorized Gmail API client.
 * - The Gmail REST API directly (via `auth.request`), not the
 *   `googleapis` wrapper library.
 * - `html-to-text` to convert HTML-only email bodies into plain text.
 * - Writes: emails.json (consumed by emailPriority.js, formatDigest.js,
 *   askInbox.js, emailLookup.js).
 *
 * Where it fits in the pipeline: runs first in `npm run triage`, before
 * emailPriority.js, syncToGoogle.js, applyLabels.js, and postDigest.js.
 */
import fs from 'fs';
import { getAuthorizedClient } from './googleAuth.js';
import { htmlToText } from 'html-to-text';

/**
 * Inputs: headers (Array<{name: string, value: string}>) — the raw header
 * list from a Gmail message payload; name (string) — the header name to look
 * up, e.g. "Subject".
 * Output: string — the header's value, or '' if not present.
 * What it does: finds a single header by name in Gmail's header array format.
 * How it does it: case-insensitive comparison, since header casing from Gmail
 * isn't guaranteed to match the casing used when searching for it.
 */
function getHeader(headers, name) {
  const h = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : '';
}

/**
 * Inputs: fromHeader (string) — the raw "From" header value, e.g.
 * `"Jane Doe" <jane@example.com>` or just `jane@example.com`.
 * Output: { name: string, email: string } — the display name (may be '') and
 * the email address.
 * What it does: splits a From header into separate name/email fields.
 * How it does it: matches the common `Display Name <email>` shape with a
 * regex; if the header doesn't have angle brackets at all (no display name),
 * it falls back to treating the whole header as the email address.
 */
function parseFrom(fromHeader) {
  const match = fromHeader.match(/^(.*?)\s*<(.+)>$/);
  if (match) {
    return { name: match[1].replace(/"/g, '').trim(), email: match[2].trim() };
  }
  return { name: '', email: fromHeader.trim() };
}

/**
 * Inputs: headerValue (string) — a raw comma-separated address header such as
 * "To" or "Cc", e.g. `"Jane Doe" <jane@example.com>, bob@example.com`.
 * Output: Array<string> — plain email addresses (display names discarded).
 * What it does: extracts just the email addresses from a multi-recipient
 * header.
 * How it does it: splits on commas, then per entry pulls out whatever is
 * inside `<...>` if present, otherwise uses the raw entry as-is (covers
 * addresses with no display name).
 */
function parseAddressList(headerValue) {
  if (!headerValue) return [];
  return headerValue.split(',').map((part) => {
    const match = part.match(/<(.+)>/);
    return match ? match[1].trim() : part.trim();
  });
}

/**
 * Inputs: payload (Object) — a Gmail message payload or MIME part, which may
 * itself contain nested `parts`.
 * Output: string|null — the base64url-encoded body data of the first
 * text/plain part found, or null if none exists.
 * What it does: recursively searches a (possibly multipart) MIME structure
 * for a plain-text body.
 * How it does it: Gmail message payloads mirror MIME's tree structure
 * (a multipart/alternative or multipart/mixed part contains child `parts`,
 * each of which can itself be multipart), so this walks that tree
 * depth-first and returns as soon as a text/plain leaf with body data is
 * found.
 */
function findPlainTextPart(payload) {
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return payload.body.data;
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = findPlainTextPart(part);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Inputs: payload (Object) — same shape as `findPlainTextPart`.
 * Output: string|null — the base64url-encoded body data of the first
 * text/html part found, or null if none exists.
 * What it does: same recursive search as `findPlainTextPart`, but looking
 * for an HTML part instead — used as a fallback when no plain-text part
 * exists.
 * How it does it: identical depth-first walk over `payload.parts`.
 */
function findHtmlPart(payload) {
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return payload.body.data;
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const found = findHtmlPart(part);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Inputs: html (string) — raw HTML email body.
 * Output: string — plain-text rendering of that HTML.
 * What it does: converts an HTML-only email body to readable plain text.
 * How it does it: delegates to `html-to-text`, disabling word-wrap (so
 * lines aren't artificially broken for a terminal width) and configuring
 * `a` tags to keep their visible text without appending the href, and
 * `img` tags to be skipped entirely rather than rendered as alt text.
 */
function stripHtml(html) {
  return htmlToText(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
    ],
  });
}

/**
 * Inputs: payload (Object) — the top-level Gmail message payload.
 * Output: string — the best-effort plain-text body of the email, or ''
 * if no body data could be found at all.
 * What it does: extracts a single plain-text body string from a Gmail
 * message, regardless of whether it was sent as plain text, HTML, or a
 * non-multipart message.
 * How it does it: prefers an existing text/plain part (no conversion
 * needed); falls back to the text/html part run through `stripHtml`;
 * falls back further to the top-level `payload.body.data` directly for
 * non-multipart messages that have no `parts` array at all. Every path
 * decodes Gmail's base64url body encoding before use, since Gmail returns
 * body data as base64url (URL-safe base64) rather than standard base64.
 */
function extractBody(payload) {
  const plainData = findPlainTextPart(payload);
  if (plainData) {
    return normalizeWhitespace(Buffer.from(plainData, 'base64url').toString('utf-8'));
  }
  const htmlData = findHtmlPart(payload);
  if (htmlData) {
    return normalizeWhitespace(stripHtml(Buffer.from(htmlData, 'base64url').toString('utf-8')));
  }
  if (payload.body?.data) {
    return normalizeWhitespace(Buffer.from(payload.body.data, 'base64url').toString('utf-8'));
  }
  return '';
}

/**
 * Inputs: text (string) — raw extracted email body text.
 * Output: string — the same text with runs of whitespace collapsed to a
 * single space and leading/trailing whitespace trimmed.
 * What it does: cleans up formatting artifacts (extra newlines, indentation)
 * left over from HTML conversion or plain-text quoting so the cached body is
 * compact and consistent.
 * How it does it: a single regex replace of any whitespace run.
 */
function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

// The six labels applyLabels.js creates/applies. A message carrying any
// of these has already been through a prior triage run.
const TRIAGE_LABEL_NAMES = [
  'Triage/Action-Required',
  'Triage/FYI',
  'Triage/Newsletter',
  'Triage/Meeting',
  'Triage/Personal',
  'Triage/Unknown',
];

// Fixed recency window: always the WINDOW_SIZE most recent messages by
// date, never backfilled with older mail to make up the count. Renamed
// from the old MAX_EMAILS to reflect this — it's a window size, not a
// target count of emails to end up with.
const WINDOW_SIZE = 25;

/**
 * Inputs: auth (Object) — an authorized Google auth client from
 * googleAuth.js.
 * Output: Promise<Set<string>> — the Gmail label IDs corresponding to
 * TRIAGE_LABEL_NAMES (only the ones that actually exist yet — a label
 * that's never been created has nothing to match against).
 * What it does: resolves the human-readable Triage/* label names to
 * their opaque Gmail label IDs, once per run, so per-message label
 * checks below are a local Set lookup rather than another API call.
 * How it does it: a single labels.list call; Gmail label IDs are not
 * derivable from their names, so this lookup is unavoidable, but only
 * needs to happen once regardless of how many messages get checked.
 */
async function getTriageLabelIds(auth) {
  const result = await auth.request({
    url: 'https://gmail.googleapis.com/gmail/v1/users/me/labels',
  });
  const labels = result.data.labels || [];
  const ids = new Set();
  for (const name of TRIAGE_LABEL_NAMES) {
    const match = labels.find((l) => l.name === name);
    if (match) ids.add(match.id);
  }
  return ids;
}

/**
 * Inputs: auth (Object) — an authorized Google auth client.
 * Output: Promise<Array<{id: string, threadId: string}>> — up to
 * WINDOW_SIZE message reference objects, the most recent by date,
 * regardless of label state.
 * What it does: retrieves the WINDOW_SIZE most recent message ids.
 * How it does it: a single messages.list call with no query filter at
 * all — deliberately no label exclusion here (see the file header
 * comment for why). Gmail's default ordering is newest-first, and
 * WINDOW_SIZE fits within a single page (Gmail's page cap is 100), so
 * no pagination loop is needed.
 */
async function listRecentMessageRefs(auth) {
  const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
  url.searchParams.set('maxResults', String(WINDOW_SIZE));

  const listResult = await auth.request({ url: url.toString() });
  return (listResult.data.messages || []).slice(0, WINDOW_SIZE);
}

/**
 * Inputs: none.
 * Output: Promise<void> — writes emails.json as a side effect.
 * What it does: the main entry point — fetches the WINDOW_SIZE most
 * recent Gmail messages, skips whichever are already Triage/*-labeled
 * (loudly, one log line per skip, never silently), extracts a flattened
 * representation of everything else, and caches the result to disk.
 * How it does it: resolves the Triage/* label IDs once, lists the
 * WINDOW_SIZE most recent message refs, then for each one fetches the
 * full message (format=full) and checks its labelIds against the
 * resolved set before deciding whether to process or skip it. A run
 * can legitimately produce fewer than WINDOW_SIZE emails — that's
 * expected under strict-recency, not a failure.
 */
async function fetchEmails() {
  const auth = await getAuthorizedClient();

  const triageLabelIds = await getTriageLabelIds(auth);
  const messageRefs = await listRecentMessageRefs(auth);
  console.log(`Found ${messageRefs.length} most recent messages. Checking labels and fetching content...`);

  const emails = [];
  let skippedCount = 0;

  for (const ref of messageRefs) {
    const full = await auth.request({
      url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`,
    });

    const labelIds = full.data.labelIds || [];
    const alreadyTriaged = labelIds.some((id) => triageLabelIds.has(id));

    if (alreadyTriaged) {
      const headers = full.data.payload.headers;
      const subject = getHeader(headers, 'Subject');
      const from = getHeader(headers, 'From');
      console.log(
        `[fetchEmails] Skipping already-triaged message (id ${full.data.id}): "${subject}" from ${from}. ` +
        `Not backfilled with an older message — strict-recency means this run may end up with fewer than ${WINDOW_SIZE} emails.`
      );
      skippedCount++;
      continue;
    }

    const headers = full.data.payload.headers;

    emails.push({
      id: full.data.id,
      from: parseFrom(getHeader(headers, 'From')),
      to: parseAddressList(getHeader(headers, 'To')),
      cc: parseAddressList(getHeader(headers, 'Cc')),
      subject: getHeader(headers, 'Subject'),
      body: extractBody(full.data.payload),
      // internalDate is a string of milliseconds-since-epoch, per the Gmail API.
      timestamp: new Date(parseInt(full.data.internalDate)).toISOString(),
      labels: full.data.labelIds || [],
      threadId: full.data.threadId,
      messageIdHeader: getHeader(headers, 'Message-ID'),
    });
  }

  console.log(
    `Processed ${emails.length} of ${messageRefs.length} most-recent messages ` +
    `(${skippedCount} already triaged, skipped — not backfilled).`
  );

  fs.writeFileSync('emails.json', JSON.stringify(emails, null, 2));
  console.log(`Saved ${emails.length} emails to emails.json`);
}

await fetchEmails();
