/**
 * draftReply.js
 *
 * Implements the /draft Discord command: finds a cached email matching a
 * search term, asks Claude to write a reply based on user-supplied
 * instructions, and creates the reply as a draft in the user's Gmail account
 * (not sent automatically).
 *
 * Depends on:
 * - emailLookup.js to resolve the search query to a cached email.
 * - `@anthropic-ai/sdk` to generate the reply body.
 * - googleAuth.js for an authorized Gmail API client to create the draft.
 * - Reads emails.json indirectly via emailLookup.js.
 *
 * Where it fits in the pipeline: not part of `npm run triage`; called by
 * discordBot.js in response to the /draft slash command, after triage has
 * already populated emails.json.
 */
import Anthropic from '@anthropic-ai/sdk';
import { getAuthorizedClient } from './googleAuth.js';
import { findEmail } from './emailLookup.js';

/**
 * Inputs: { to: string, subject: string, body: string, inReplyTo: string }
 * — destination address, subject line, plain-text reply body, and (if
 * replying within a thread) the original message's Message-ID header value.
 * Output: string — a base64url-encoded raw RFC 2822 email message, in the
 * format the Gmail API's drafts.create endpoint expects for its `raw` field.
 * What it does: constructs a minimal plain-text MIME email message and
 * encodes it the way the Gmail API requires.
 * How it does it: joins the required headers with CRLF (`\r\n`, per the
 * RFC 2822/MIME line-ending convention) followed by a blank line and the
 * body; when replying to a specific message, also sets In-Reply-To and
 * References to that message's Message-ID so mail clients thread the reply
 * correctly. The final string must be base64url (URL-safe base64, no `+`/`/`)
 * rather than standard base64 because that's the encoding the Gmail API's
 * `raw` message field requires.
 */
function buildRawMimeMessage({ to, subject, body, inReplyTo }) {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
  ];
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    headers.push(`References: ${inReplyTo}`);
  }
  const message = headers.join('\r\n') + '\r\n\r\n' + body;
  return Buffer.from(message).toString('base64url');
}

/**
 * Inputs: email (Object) — a cached email record (from emailLookup.js) with
 * `from`, `subject`, and `body`; instructions (string) — free-text
 * instructions for what the reply should say, as typed into the /draft
 * command.
 * Output: Promise<string> — the generated reply body text only (no subject,
 * no greeting).
 * What it does: asks Claude to write a short, professional reply to the given
 * email following the user's instructions.
 * How it does it: caps the quoted original body at 3000 characters to bound
 * prompt size, and explicitly instructs the model to return only the message
 * content (no subject line or "Dear ..." greeting) since those are handled
 * separately by the caller.
 */
async function generateReplyBody(email, instructions) {
  const client = new Anthropic();
  const prompt = `Write a short, professional email reply based on these instructions: "${instructions}"

The original email being replied to:
From: ${email.from.name} <${email.from.email}>
Subject: ${email.subject}
Body: ${email.body.slice(0, 3000)}

Respond with ONLY the reply body text, no subject line, no greeting like "Dear", just the message content. Sign off naturally but briefly.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.content[0].text.trim();
}

/**
 * Inputs: query (string) — sender name/email or subject keyword identifying
 * which cached email to reply to; instructions (string) — free-text
 * instructions for the reply content.
 * Output: Promise<{success: true, draftId: string, subject: string, to:
 * string, body: string} | {success: false, error: string}> — either the
 * created draft's details, or an error message if no matching email was
 * found.
 * What it does: the main export of this module — turns a search query and
 * reply instructions into an actual Gmail draft.
 * How it does it: looks up the target email, generates the reply body via
 * Claude, prefixes the subject with "Re:" (unless it already has one),
 * builds the raw MIME message via `buildRawMimeMessage`, and posts it to the
 * Gmail drafts endpoint tagged with the original message's threadId so it
 * appears in-thread rather than as a new conversation.
 */
export async function draftReplyTo(query, instructions) {
  const email = findEmail(query);
  if (!email) {
    return { success: false, error: `No cached email matches "${query}". Try running /triage first, or a different search term.` };
  }

  const replyBody = await generateReplyBody(email, instructions);
  const subject = email.subject.toLowerCase().startsWith('re:') ? email.subject : `Re: ${email.subject}`;

  const raw = buildRawMimeMessage({
    to: email.from.email,
    subject,
    body: replyBody,
    inReplyTo: email.messageIdHeader,
  });

  const auth = await getAuthorizedClient();
  const result = await auth.request({
    url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
    method: 'POST',
    data: { message: { raw, threadId: email.threadId } },
  });

  return { success: true, draftId: result.data.id, subject, to: email.from.email, body: replyBody };
}