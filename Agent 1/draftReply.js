/**
 * draftReply.js
 *
 * Writes an email in either of two modes and creates the result as a draft in
 * the user's Gmail account (never sent automatically):
 *
 * - Reply mode — a search term was given AND matched a cached email: asks an
 *   LLM to write a reply to that email following the user's instructions,
 *   and creates it in-thread.
 * - Fresh-compose mode — no search term was given, or the one given matched
 *   nothing cached: asks an LLM to extract the recipient, subject, and body
 *   from the instructions alone, and creates that as a standalone,
 *   unthreaded email with no quoted original.
 *
 * Reached when messageRouter.js classifies a message in the #gmail channel as
 * intent "draft". It used to back the /draft slash command, whose `email` and
 * `instructions` options are now the router's draft_target and
 * draft_instructions — same two values, extracted from plain English instead
 * of typed into separate fields.
 *
 * The two modes deliberately use different LLM output modes: reply mode wants
 * prose (jsonMode: false), fresh-compose wants a structured {to, subject,
 * body} object and so passes a jsonSchema, routing it down the same forced
 * tool-use path emailPriority.js uses. See generateFreshEmail for why that
 * distinction matters here rather than being a stylistic choice.
 *
 * Depends on:
 * - emailLookup.js to resolve the search query to a cached email (reply mode
 *   only — fresh-compose mode never touches the cache).
 * - llmClient/index.js (callLLM) to generate the message text via whichever
 *   provider LLM_PROVIDER names.
 * - googleAuth.js for an authorized Gmail API client to create the draft.
 * - Reads emails.json indirectly via emailLookup.js.
 *
 * Where it fits in the pipeline: not part of `npm run triage`; called by
 * discordBot.js when the router reads a message as a request to write an
 * email. Reply mode needs triage to have already populated emails.json;
 * fresh-compose mode works whether or not triage has ever run.
 */
import { callLLM } from './llmClient/index.js';
import { getAuthorizedClient } from './googleAuth.js';
import { findEmail } from './emailLookup.js';

// Deliberately permissive — a sanity check that we have something
// address-shaped, not an attempt to validate deliverability (no regex does
// that, and stricter ones reject real addresses). Its one strict property is
// that it rejects ALL whitespace, so an address that passes can never smuggle
// a CRLF into the MIME headers built by buildRawMimeMessage().
const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Passed to callLLM by generateFreshEmail so that providers registered
// jsonMode: 'strict' enforce this shape via forced tool-use rather than
// merely returning parseable JSON. Same reasoning as emailPriority.js's
// CLASSIFICATION_SCHEMA, and the same preconditions apply — Anthropic's
// strict mode REQUIRES additionalProperties: false plus a complete
// `required` array on every object, and rejects the schema without them.
//
// `to` is nullable on purpose. "The instructions named nobody" is a normal
// outcome that must be representable, because the alternative — a required
// string — pressures the model into inventing an address to satisfy the
// schema, which is the single worst failure this function can have.
//
// Verified live 2026-08-13 against claude-sonnet-4-6: an address present in
// the instructions came back copied exactly, absent came back as real null
// (not the string "null", not a guess), and no extra keys appeared.
const FRESH_EMAIL_SCHEMA = {
  type: 'object',
  properties: {
    to: { type: ['string', 'null'] },
    subject: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['to', 'subject', 'body'],
  additionalProperties: false,
};

const FRESH_EMAIL_SYSTEM_PROMPT = `You compose brand-new emails from a short free-text instruction. Read the instruction, then produce a recipient address, a subject line, and a message body.

Rules:
- "to": the recipient's email address, copied EXACTLY as it appears in the instruction. Never invent, guess, autocomplete, or correct an address, and never derive one from a person's name. If the instruction contains no literal email address, set "to" to null — no draft at all is far better than a draft addressed to the wrong person.
- "subject": a short, specific subject line on ONE line, with no line breaks.
- "body": the message body only — no subject line, no To:/From: headers, and no "Dear <name>" placeholder greeting. Sign off naturally but briefly.
- This is a NEW email, not a reply: do not quote, summarize, or refer back to any previous message.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "to": "<email address, or null if the instruction contains none>",
  "subject": "<subject line>",
  "body": "<message body>"
}`;

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
 * correctly. Omitting inReplyTo omits both headers, which is exactly what
 * fresh-compose mode wants — an unthreaded, standalone message. The final
 * string must be base64url (URL-safe base64, no `+`/`/`) rather than standard
 * base64 because that's the encoding the Gmail API's `raw` message field
 * requires.
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
 * Inputs: raw (string) — a base64url-encoded MIME message from
 * buildRawMimeMessage; threadId (string, optional) — the Gmail thread to
 * attach the draft to.
 * Output: Promise<string> — the created draft's id.
 * What it does: posts a prepared message to the Gmail drafts endpoint.
 * How it does it: sends `threadId` only when one was supplied, since Gmail
 * treats a draft with a threadId as living inside that conversation and one
 * without as starting a new one — the single API-level difference between
 * this module's reply and fresh-compose modes.
 */
async function createGmailDraft(raw, threadId) {
  const message = threadId ? { raw, threadId } : { raw };
  const auth = await getAuthorizedClient();
  const result = await auth.request({
    url: 'https://gmail.googleapis.com/gmail/v1/users/me/drafts',
    method: 'POST',
    data: { message },
  });
  return result.data.id;
}

/**
 * Inputs: email (Object) — a cached email record (from emailLookup.js) with
 * `from`, `subject`, and `body`; instructions (string) — free-text
 * instructions for what the reply should say; recentConversation
 * (string|null, optional) — a rendered transcript of recent Discord channel
 * messages, supplied only when messageRouter.js judged the request to depend
 * on them (e.g. "no, make that shorter").
 * Output: Promise<string> — the generated reply body text only (no subject,
 * no greeting).
 * What it does: asks an LLM to write a short, professional reply to the given
 * email following the user's instructions.
 * How it does it: caps the quoted original body at 3000 characters to bound
 * prompt size, and explicitly instructs the model to return only the message
 * content (no subject line or "Dear ..." greeting) since those are handled
 * separately by the caller. jsonMode: false because this one wants prose —
 * the harness defaults to JSON. The transcript is clearly fenced off as
 * Discord chatter rather than email content, since everything else in this
 * prompt is material the model may legitimately quote back into the reply and
 * this is the one part that must not be.
 */
async function generateReplyBody(email, instructions, recentConversation) {
  const conversationSection = recentConversation
    ? `\nFor context only, the recent Discord conversation with the user, oldest first. It explains what they're asking for; it is NOT part of the email and must not be quoted or referred to in the reply:\n${recentConversation}\n`
    : '';

  const prompt = `Write a short, professional email reply based on these instructions: "${instructions}"

The original email being replied to:
From: ${email.from.name} <${email.from.email}>
Subject: ${email.subject}
Body: ${email.body.slice(0, 3000)}
${conversationSection}
Respond with ONLY the reply body text, no subject line, no greeting like "Dear", just the message content. Sign off naturally but briefly.`;

  const replyText = await callLLM('', prompt, {
    jsonMode: false,
    logLabel: '[draftReply]',
  });
  return replyText.trim();
}

/**
 * Inputs: instructions (string) — free-text instructions describing the
 * email to write, expected to name the recipient's address somewhere in it;
 * hint (string, optional) — whatever search term the router extracted as
 * draft_target that then failed to match a cached email, passed along as weak
 * extra context rather than discarded; recentConversation (string|null,
 * optional) — a rendered transcript of recent Discord channel messages,
 * supplied only when the router judged the request to depend on them.
 * Output: Promise<{to: string|null, subject: string, body: string}> — the
 * recipient address the model found (null when the instructions contain
 * none), plus the subject and body it wrote.
 * What it does: turns a bare instruction like "email jdoe@company.com about
 * rescheduling" into the three fields needed to build a standalone email.
 * How it does it: passes FRESH_EMAIL_SCHEMA to callLLM, which routes this
 * down the strict forced tool-use path on providers that support it — the
 * same mechanism emailPriority.js relies on, and for the same reason. This
 * is the one /draft call whose output is consumed field-by-field rather than
 * pasted through as prose, so a wrong shape here is a wrong draft, not just
 * ugly text. The parsed result is then hard-validated anyway, because
 * 'best-effort' providers (openrouter) ignore the schema entirely and
 * because strict mode enforces structure, never meaning. A missing recipient
 * is a normal, expected outcome (returned as `to: null` for the caller to
 * reject with a useful message), whereas a malformed response is a real
 * failure and throws — discordBot.js already reports a thrown /draft error.
 */
async function generateFreshEmail(instructions, hint, recentConversation) {
  let userContent = `Instructions: ${instructions}`;
  if (hint) {
    userContent +=
      `\n\nThis search term was pulled from the user's message but matched no cached email. ` +
      `It may name the intended recipient, or it may be irrelevant — use it only if it helps: ${hint}`;
  }
  if (recentConversation) {
    userContent +=
      `\n\nFor context only, the recent Discord conversation with the user, oldest first. It explains what they're ` +
      `asking for; it is NOT part of the email and must not be quoted in it. An email address appearing ONLY here and ` +
      `not in the instructions above is still a literal address the user wrote, so it may be used as the recipient — ` +
      `but the no-guessing rule is unchanged: never infer an address from a name mentioned in this transcript.\n${recentConversation}`;
  }

  const rawText = await callLLM(FRESH_EMAIL_SYSTEM_PROMPT, userContent, {
    jsonSchema: FRESH_EMAIL_SCHEMA,
    logLabel: '[draftReply]',
  });

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseErr) {
    throw new Error(
      `[draftReply] Model response wasn't valid JSON. Raw content was:\n${rawText}\n\nParse error: ${parseErr.message}`
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `[draftReply] Model response shape invalid: expected an object, got ${JSON.stringify(parsed)}.`
    );
  }
  if (parsed.to !== null && parsed.to !== undefined && typeof parsed.to !== 'string') {
    throw new Error(
      `[draftReply] Model response shape invalid: "to" must be a string or null, got ${typeof parsed.to}.`
    );
  }
  if (typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') {
    throw new Error(
      `[draftReply] Model response shape invalid: "subject" and "body" must both be strings, got ${typeof parsed.subject} and ${typeof parsed.body}.`
    );
  }

  return {
    to: typeof parsed.to === 'string' ? parsed.to.trim() : null,
    // Flattened here rather than inside buildRawMimeMessage, which is shared
    // with the reply path and left untouched. This value is model output
    // derived from free-text instructions and is about to become a MIME
    // header, so a CR/LF in it would inject arbitrary extra headers (Bcc:,
    // etc.) into the message. `to` needs no equivalent treatment —
    // EMAIL_ADDRESS_PATTERN already rejects any whitespace.
    subject: parsed.subject.replace(/[\r\n]+/g, ' ').trim(),
    body: parsed.body.trim(),
  };
}

/**
 * Inputs: query (string|null) — sender name/email or subject keyword
 * identifying which cached email to reply to, or null/empty when the router
 * found no reply target in the user's message; instructions (string) —
 * free-text instructions for the email content; recentConversation
 * (string|null, optional) — a rendered transcript of recent Discord channel
 * messages, passed straight through to whichever generator runs.
 * Output: Promise<{success: true, draftId: string, subject: string, to:
 * string, body: string} | {success: false, error: string}> — either the
 * created draft's details, or an error message explaining why no draft was
 * created.
 * What it does: the main export of this module — turns reply instructions
 * (plus optionally a search query) into an actual Gmail draft, replying
 * in-thread when there's something to reply to and composing a fresh
 * standalone email when there isn't.
 * How it does it: looks up the target email only if a query was actually
 * given. On a hit, behaves exactly as before — generates the reply body,
 * prefixes the subject with "Re:" (unless it already has one), and creates
 * the draft tagged with the original's threadId so it appears in-thread. With
 * no query, or a query matching nothing cached, falls through to
 * fresh-compose instead of erroring out: the model extracts recipient,
 * subject, and body from the instructions, and the draft is created with no
 * threadId and no In-Reply-To. A recipient the model couldn't find, or found
 * but which isn't address-shaped, is refused outright rather than sent to a
 * blank or malformed address — that check is the one thing standing between a
 * vague instruction and a draft addressed to nobody.
 */
export async function draftReplyTo(query, instructions, recentConversation) {
  const email = query ? findEmail(query) : null;

  if (email) {
    const replyBody = await generateReplyBody(email, instructions, recentConversation);
    const subject = email.subject.toLowerCase().startsWith('re:') ? email.subject : `Re: ${email.subject}`;

    const raw = buildRawMimeMessage({
      to: email.from.email,
      subject,
      body: replyBody,
      inReplyTo: email.messageIdHeader,
    });

    const draftId = await createGmailDraft(raw, email.threadId);

    return { success: true, draftId, subject, to: email.from.email, body: replyBody };
  }

  const fresh = await generateFreshEmail(instructions, query, recentConversation);

  if (!fresh.to || !EMAIL_ADDRESS_PATTERN.test(fresh.to)) {
    return {
      success: false,
      error:
        `Couldn't work out who to send this to${fresh.to ? ` — "${fresh.to}" isn't a valid email address` : ''}. ` +
        `Mention the recipient's email address directly in your instructions, ` +
        `e.g. "email jdoe@company.com about rescheduling Thursday's review". ` +
        `(No draft was created.)`,
    };
  }

  const raw = buildRawMimeMessage({ to: fresh.to, subject: fresh.subject, body: fresh.body });
  const draftId = await createGmailDraft(raw);

  return { success: true, draftId, subject: fresh.subject, to: fresh.to, body: fresh.body };
}
