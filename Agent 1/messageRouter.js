/**
 * messageRouter.js
 *
 * Decides what a plain-English Discord message actually wants, so the bot can
 * act on it without slash commands. Replaces the /triage, /ask and /draft
 * command surface entirely: the user types normally, this classifies the
 * message into one of four intents, and discordBot.js dispatches on the
 * result.
 *
 * TWO CALLS, NOT ONE. Classification and execution are deliberately separate
 * requests: this file's classifyMessage() answers "what does the user want?"
 * and nothing else, then the caller makes a second call (askInbox,
 * draftReplyTo, chatReply) that does the actual work. Merging them would mean
 * every message paid for the full inbox context just to discover it was
 * small talk, and would leave the intent decision entangled with a much
 * longer, more distractible prompt.
 *
 * CONTEXT IS THE MODEL'S CALL, NOT A RULE. There is no session store, no
 * "conversation" object, no timeout window. Every message is classified
 * fresh against the recent channel transcript, and the model itself reports
 * whether that transcript is needed (use_context) — a follow-up like "what
 * about the second one?" is only a follow-up because the model says it reads
 * like one, not because it arrived within N seconds of the previous message.
 *
 * Depends on:
 * - llmClient/index.js (callLLM) for both the classification call and the
 *   chat reply, dispatching on LLM_PROVIDER exactly like every other caller
 *   in this project. Nothing here talks to a provider SDK directly.
 *
 * Where it fits in the pipeline: not part of `npm run triage`; sits between
 * discordBot.js's messageCreate handler and the three things it can call.
 */
import { callLLM } from './llmClient/index.js';

// Passed to callLLM on every classification call, so providers registered
// jsonMode: 'strict' enforce this shape via forced tool-use rather than
// merely returning parseable JSON. Same reasoning as emailPriority.js's
// CLASSIFICATION_SCHEMA and draftReply.js's FRESH_EMAIL_SCHEMA, and the same
// preconditions apply — Anthropic's strict mode REQUIRES
// additionalProperties: false plus a complete `required` array on every
// object, and rejects the schema without them. That is why the two draft_*
// fields are listed in `required` and typed as nullable unions rather than
// simply being left out on non-draft intents: strict mode has no notion of
// "optional", so "not applicable" has to be representable as a value.
const ROUTER_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['triage', 'ask', 'draft', 'chat'] },
    use_context: { type: 'boolean' },
    draft_target: { type: ['string', 'null'] },
    draft_instructions: { type: ['string', 'null'] },
  },
  required: ['intent', 'use_context', 'draft_target', 'draft_instructions'],
  additionalProperties: false,
};

const VALID_INTENTS = ['triage', 'ask', 'draft', 'chat'];

// Deliberately small. The router emits four short fields and nothing else, so
// a large budget here buys nothing and costs on every single message the user
// sends — this is the one call in the project that runs on EVERY message
// rather than once per triage run.
const ROUTER_MAX_TOKENS = 300;

const ROUTER_SYSTEM_PROMPT = `You are the intent router for a personal email assistant that lives in a single Discord channel. You are given the user's newest message plus a transcript of recent channel history. You decide what the assistant should do with that message. You never answer the user yourself, and you never write email content.

Pick exactly one intent:

- "triage": the user wants the email pipeline to RUN — fetch new mail, classify it, create Google Calendar events and Google Tasks, apply Gmail labels, and post a digest. Examples: "run triage", "check my email", "any new mail?", "sync my inbox", "go", "refresh". Choose this ONLY when the user is asking for new mail to be fetched and processed right now. It performs real writes to Calendar, Tasks and Gmail and runs immediately with no confirmation step, so never choose it for something that can be answered from mail that has already been triaged, and never choose it merely because a message mentions email.

- "ask": a question answerable from mail that has ALREADY been fetched and classified. Examples: "what's urgent?", "did anyone email about the invoice?", "how many newsletters today?", "who was that from?", "summarize the important ones".

- "draft": the user wants an email written and saved to Gmail as a draft. Examples: "reply to Sarah saying I'll be there", "draft a note to jdoe@company.com about Thursday", "tell them I'm running late".

- "chat": anything else — greetings, thanks, small talk, questions about the assistant itself, or a message too vague to act on. When you genuinely cannot tell what the user wants, choose "chat". Never guess "triage" as a fallback: chat costs nothing and a wrong triage silently writes to the user's calendar and inbox.

Also decide:

- "use_context": true if the newest message only makes sense in light of the transcript — pronouns with no antecedent ("that one", "them", "the second"), bare follow-ups ("and the other?"), or a correction to a previous request ("no, make it shorter"). false if the message stands entirely on its own, even when earlier messages happen to be related.

- "draft_target": ONLY when intent is "draft" AND the user is replying to a specific existing email. Give a short search term identifying it — a sender name, sender address, or distinctive subject word, copied from the user's message. It is matched against cached mail as a plain case-insensitive substring, so keep it short and literal; do not write a sentence. Set it to null when the user is composing a brand-new email rather than replying, and null for every non-draft intent.

- "draft_instructions": ONLY when intent is "draft". A self-contained instruction describing what the email should say, including the recipient's email address verbatim if the user gave one. Never invent an address. Set it to null for every other intent.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "intent": "triage" | "ask" | "draft" | "chat",
  "use_context": true | false,
  "draft_target": "<short search term, or null>",
  "draft_instructions": "<what the email should say, or null>"
}`;

const CHAT_SYSTEM_PROMPT = `You are a personal email assistant in a private Discord channel, talking to the one person who owns the inbox. This particular message isn't a request to run triage, answer a question about their mail, or draft an email — it's ordinary conversation, so just reply naturally.

Be brief and plain-spoken; this is a chat message, not a document. You have no access to the user's inbox in this reply, so never describe, summarize, or invent anything about their email — if they want that, say what they can ask for instead. You can explain what you're able to do: run a triage pass over new mail, answer questions about mail already triaged, and draft replies or new emails into Gmail.`;

/**
 * Inputs: transcript (string|null) — a rendered recent-channel transcript, or
 * null/empty when there is no history to consider.
 * Output: string — the transcript wrapped in a labeled section, or a short
 * explicit statement that no history exists.
 * What it does: makes the "no history" case visible to the model instead of
 * silently absent.
 * How it does it: an empty section would leave the model inferring from a
 * gap, which is exactly the situation where it invents an antecedent for a
 * pronoun and returns use_context: true against nothing. Saying so outright
 * costs a few tokens and removes the ambiguity.
 */
function renderTranscriptSection(transcript) {
  if (!transcript) {
    return 'Recent channel history: (none — this is the first message in the channel, or history could not be read.)';
  }
  return `Recent channel history, oldest first:\n${transcript}`;
}

/**
 * Inputs: content (string) — the user's newest message text; transcript
 * (string|null) — recent channel history, oldest first, with each line
 * labeled by speaker.
 * Output: Promise<{intent: 'triage'|'ask'|'draft'|'chat', use_context:
 * boolean, draft_target: string|null, draft_instructions: string|null}>.
 * What it does: classifies one message into an actionable intent — the first
 * of this module's two calls.
 * How it does it: passes ROUTER_SCHEMA to callLLM, routing the request down
 * the strict forced tool-use path on providers that support it, the same
 * mechanism emailPriority.js relies on. The result is then hard-validated
 * anyway, for two independent reasons: 'best-effort' providers (openrouter)
 * ignore the schema entirely, and strict mode enforces structure but never
 * meaning. Throws on anything malformed rather than falling back to a default
 * intent — a silent fallback here would mean acting on a request nobody made,
 * and the one direction that failure could go wrong (triage) writes to the
 * user's calendar, tasks, and inbox. The caller reports the throw to the user.
 */
export async function classifyMessage(content, transcript) {
  // Read lazily, inside the function, NOT at module scope. Every entry point
  // in this codebase is ESM, where import statements are hoisted above
  // dotenv.config() regardless of textual order — a module-load-time env read
  // here would silently ignore .env on every run. See the ENV READ TIMING
  // note in llmClient/index.js; this exact bug has already happened once in
  // this project.
  //
  // Unset means "use whatever model the configured provider defaults to",
  // which keeps this provider-agnostic. Set ROUTER_MODEL to a cheaper model
  // than the pipeline's if you want classification billed at a lower rate —
  // it runs on every message, unlike the triage calls. The value must be a
  // model ID valid for the CURRENT LLM_PROVIDER, since it is passed straight
  // through to that provider's adapter.
  const routerModel = process.env.ROUTER_MODEL || undefined;

  const userContent = `${renderTranscriptSection(transcript)}

The user's newest message:
${content}`;

  const rawText = await callLLM(ROUTER_SYSTEM_PROMPT, userContent, {
    jsonSchema: ROUTER_SCHEMA,
    model: routerModel,
    maxTokens: ROUTER_MAX_TOKENS,
    logLabel: '[router]',
  });

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseErr) {
    throw new Error(
      `[router] Model response wasn't valid JSON. Raw content was:\n${rawText}\n\nParse error: ${parseErr.message}`
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `[router] Model response shape invalid: expected an object, got ${JSON.stringify(parsed)}.`
    );
  }
  if (!VALID_INTENTS.includes(parsed.intent)) {
    throw new Error(
      `[router] Model returned an unknown intent ${JSON.stringify(parsed.intent)}. Expected one of: ${VALID_INTENTS.join(', ')}.`
    );
  }
  if (typeof parsed.use_context !== 'boolean') {
    throw new Error(
      `[router] Model response shape invalid: "use_context" must be a boolean, got ${typeof parsed.use_context}.`
    );
  }

  return {
    intent: parsed.intent,
    use_context: parsed.use_context,
    // Coerced rather than validated strictly: unlike intent, a wrong-typed
    // draft field can't misroute anything — the worst case is a lost search
    // term, which degrades a reply into a fresh compose and is caught
    // downstream by draftReply.js's own recipient check.
    draft_target: typeof parsed.draft_target === 'string' && parsed.draft_target.trim() ? parsed.draft_target.trim() : null,
    draft_instructions:
      typeof parsed.draft_instructions === 'string' && parsed.draft_instructions.trim()
        ? parsed.draft_instructions.trim()
        : null,
  };
}

/**
 * Inputs: content (string) — the user's message; transcript (string|null) —
 * recent channel history, or null when it shouldn't be used.
 * Output: Promise<string> — the reply text.
 * What it does: answers an ordinary conversational message — the "chat"
 * branch of the router's four intents.
 * How it does it: a plain prose call (jsonMode: false, since the harness
 * defaults to JSON) with no inbox data in the prompt at all. That omission is
 * the point: this path deliberately has nothing to hallucinate from, so a
 * casual message can never produce a confident-sounding claim about the
 * user's actual email. Questions about the inbox route to "ask" instead,
 * which does load the real data.
 */
export async function chatReply(content, transcript) {
  const userContent = `${renderTranscriptSection(transcript)}

The user's newest message:
${content}`;

  const reply = await callLLM(CHAT_SYSTEM_PROMPT, userContent, {
    jsonMode: false,
    logLabel: '[router]',
  });
  return reply.trim();
}
