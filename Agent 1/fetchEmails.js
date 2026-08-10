/**
 * fetchEmails.js
 *
 * First step of the `npm run triage` pipeline. Pulls unread, not-yet-triaged
 * messages from Gmail, parses each one's headers and body out of the Gmail
 * API's MIME structure, and caches the flattened result to emails.json.
 *
 * Depends on:
 * - googleAuth.js for an authorized Gmail API client.
 * - The Gmail REST API directly (via `auth.request`), not the `googleapis`
 *   wrapper library.
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


  // Gmail search query: only unread messages that don't already carry one of
  // our own triage labels. Excluding already-labeled messages prevents
  // re-fetching (and re-triaging) emails from a previous run.
  const QUERY = '-label:Triage/Action-Required -label:Triage/FYI -label:Triage/Newsletter -label:Triage/Meeting -label:Triage/Personal -label:Triage/Unknown';
  const MAX_EMAILS = 25;

  /**
   * Inputs: auth (Object) — an authorized Google auth client from
   * googleAuth.js.
   * Output: Promise<Array<{id: string, threadId: string}>> — up to
   * MAX_EMAILS message reference objects (not full message content).
   * What it does: retrieves the list of message ids matching QUERY, without
   * yet fetching each message's full content.
   * How it does it: the Gmail messages.list endpoint caps each page at 100
   * results and returns a `nextPageToken` when more are available, so this
   * loops, accumulating refs and following `nextPageToken`, until either the
   * API reports no more pages or MAX_EMAILS refs have been collected — then
   * trims to exactly MAX_EMAILS in case the last page overshot it.
   */
  async function listUnreadMessageRefs(auth) {
    let messageRefs = [];
    let pageToken = null;

    do {
      const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      url.searchParams.set('q', QUERY);
      url.searchParams.set('maxResults', '100');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const listResult = await auth.request({ url: url.toString() });
      messageRefs = messageRefs.concat(listResult.data.messages || []);
      pageToken = listResult.data.nextPageToken;
    } while (pageToken && messageRefs.length < MAX_EMAILS);

    return messageRefs.slice(0, MAX_EMAILS);
  }

/**
 * Inputs: none.
 * Output: Promise<void> — writes emails.json as a side effect.
 * What it does: the main entry point for this script — fetches unread,
 * untriaged messages from Gmail, extracts a flattened, easy-to-use
 * representation of each, and caches the result to disk for downstream
 * pipeline steps.
 * How it does it: gets an authorized client, lists candidate message refs via
 * `listUnreadMessageRefs`, then for each ref makes a second API call
 * (`format=full`) to get the complete message including headers and body,
 * parses out the fields the rest of the pipeline needs, and writes the
 * collected array to emails.json.
 */
async function fetchEmails() {
    const auth = await getAuthorizedClient();

  const messageRefs = await listUnreadMessageRefs(auth);
  console.log(`Found ${messageRefs.length} recent, untriaged messages. Fetching full content...`);

  const emails = [];

  for (const ref of messageRefs) {
    const full = await auth.request({
      url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${ref.id}?format=full`,
    });

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

  fs.writeFileSync('emails.json', JSON.stringify(emails, null, 2));
  console.log(`Saved ${emails.length} emails to emails.json`);
}

await fetchEmails();