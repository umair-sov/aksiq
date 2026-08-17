/**
 * emailPriority.js
 *
 * Second step of the `npm run triage` pipeline. Reads the emails cached by
 * fetchEmails.js, classifies them in batches of CHUNK_SIZE via OpenRouter
 * (rather than one call per email), and writes the results to
 * task_list.json.
 *
 * Ported from the Anthropic-native version to OpenRouter's free tier,
 * following the same pattern established in Agent 2's dedup.js/
 * synthesize.js: system prompt + user content split, JSON forced via
 * `response_format: json_object` (handled inside callOpenRouter) rather
 * than an assistant-turn prefill, and hard shape validation on the
 * response before trusting it.
 *
 * PROVIDER ROUTING (2026-08-13): this no longer calls openRouterClient.js
 * directly. Every LLM call in Agent 1 goes through llmClient/index.js's
 * callLLM(), which dispatches on LLM_PROVIDER (default 'anthropic').
 * CLASSIFICATION_SCHEMA below is passed on every call so that providers
 * registered jsonMode: 'strict' enforce the response SHAPE rather than
 * merely returning parseable JSON. The 1:1 validation further down is NOT
 * redundant with it: strict enforces structure, never semantic
 * completeness — a schema-perfect array of 1 classification for 5 input
 * emails is valid and has been observed. Structure is the schema's job;
 * "every email came back" is this file's.
 *
 * ASSUMPTIONS — verify these against your actual files before running:
 * - The API key for whichever provider LLM_PROVIDER names is set (the
 *   dotenv path below is unchanged from the rest of Agent 1 — '.env'
 *   then '../.env' — rather than adopting Agent 2's separate
 *   config/env.js module, to stay consistent with every other file in
 *   this folder).
 *
 * Depends on:
 * - emails.json, produced by fetchEmails.js.
 * - llmClient/index.js (callLLM) for provider dispatch, request/retry/
 *   parsing — which in turn wraps openRouterClient.js when
 *   LLM_PROVIDER=openrouter.
 * - Writes: task_list.json (consumed by syncToGoogle.js, applyLabels.js,
 *   formatDigest.js, askInbox.js).
 */
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config({ path: ['.env', '../.env'] });

import { callLLM } from './llmClient/index.js';

/**
 * Inputs: none.
 * Output: Array<Object> — the parsed contents of emails.json.
 */
function loadEmails() {
  if (!fs.existsSync('emails.json')) return [];
  const raw = fs.readFileSync('emails.json', 'utf-8');
  return JSON.parse(raw);
}

// Maps priority strings to a sortable numeric rank for the final sort.
const rank = { high: 1, medium: 2, low: 3 };
// Caps how much of a single email body is sent, same as before.
const BODY_CAP = 20000;
// How many emails go into one OpenRouter call. Chosen over a single
// call for the whole inbox: keeps prompt size bounded against a free
// model's (likely smaller) context window, and bounds the blast radius
// of a bad response to one chunk instead of the entire run. Cuts a
// full 25-email run to 5 calls, well under OpenRouter's free daily cap.
const CHUNK_SIZE = 5;
const VALID_CATEGORIES = ['action_required', 'fyi', 'newsletter', 'meeting', 'personal', 'unknown'];
const VALID_PRIORITIES = ['high', 'medium', 'low'];

// Passed to callLLM on every classification call. Providers registered
// jsonMode: 'strict' (anthropic) turn this into real enforcement via
// forced tool-use; 'best-effort' providers (openrouter) ignore it and fall
// back to response_format: json_object, which is why the hand validation
// below stays regardless of provider.
//
// additionalProperties: false and a complete `required` array on every
// object are PRECONDITIONS of Anthropic's strict mode, not stylistic
// choices — omit either and the schema is rejected.
//
// Verified live 2026-08-13 against claude-sonnet-4-6: enum membership and
// the nullable `type: ['string','null']` unions are both enforced, extra
// properties are suppressed, and absent values come back as real null
// rather than the string "null". 12/12 assertions.
const CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: {
    classifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source_email_id: { type: 'string' },
          category: { type: 'string', enum: VALID_CATEGORIES },
          priority: { type: 'string', enum: VALID_PRIORITIES },
          suggested_task: { type: ['string', 'null'] },
          event_datetime: { type: ['string', 'null'] },
        },
        required: ['source_email_id', 'category', 'priority', 'suggested_task', 'event_datetime'],
        additionalProperties: false,
      },
    },
  },
  required: ['classifications'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You are an email triage classifier. You will be given a JSON array of emails. For EVERY email in the array, return exactly one classification — you must not omit any email, and you must not invent an email that wasn't given to you.

For each email, classify:
- category: exactly one of action_required, fyi, newsletter, meeting, personal, unknown. Prefer unknown over a poor fit. Do not force an email into a category it does not clearly belong to.
- priority: exactly one of high, medium, low.
- suggested_task: a short action string, or null if none is needed.
- event_datetime: if the email states a specific date and time for a meeting or deadline, resolve it to an ISO 8601 datetime that includes an explicit Asia/Karachi timezone offset (e.g. "2026-07-28T15:00:00+05:00") — assume Asia/Karachi is the relevant timezone unless the email itself states a different one — using that email's own "sent" field to resolve relative references like "Tuesday" or "tomorrow". If no specific time is stated, use null.
  IMPORTANT — do NOT extract event_datetime from quoted reply-chain metadata. Reply threads carry the headers of earlier messages inline, and those timestamps are a record of when something was already sent, not a future commitment. Ignore, as a source of event_datetime, any of:
  - "Sent: <date>" / "Date: <date>" lines
  - "On <date> at <time>, <person> wrote:" lines
  - "From:" / "To:" / "Subject:" blocks belonging to an earlier message
  - any other quoted header from a previous message in the thread
  Extract a date/time ONLY when the current message's own content states an actual future meeting, appointment, or deadline. If the only date-like text in an email is quoted reply-chain metadata, event_datetime is null. A timestamp equal or near-equal to the email's own "sent" value is a strong signal you have picked up thread metadata rather than a real event — return null instead.

Respond with ONLY a JSON object, no other text, in this exact shape:
{
  "classifications": [
    {
      "source_email_id": "<the email's source_email_id, copied exactly>",
      "category": "<category>",
      "priority": "<priority>",
      "suggested_task": "<string or null>",
      "event_datetime": "<ISO 8601 string or null>"
    }
  ]
}`;

/** Splits an array into chunks of at most `size`. */
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Inputs: chunk (Array<Object>) — up to CHUNK_SIZE emails from emails.json.
 * Output: Promise<Array<Object>> — one task_list.json-shaped entry per
 * input email, in the same order as returned by the model.
 * What it does: classifies one chunk via a single OpenRouter call.
 * How it does it: truncates each body independently (same BODY_CAP logic
 * as the original per-email version), sends the compact batch, parses and
 * validates the response shape, then — unlike dedup.js, where an
 * un-clustered record is a safe expected default — verifies every input
 * email is accounted for exactly once, since a missing entry here means a
 * dropped email, not a null result. Throws on any structural problem
 * (bad JSON, wrong shape, missing/duplicated/hallucinated ids), which the
 * caller catches and treats as "skip this whole chunk" — the tradeoff of
 * batching versus the original one-call-per-email design. Unexpected but
 * present category/priority values are coerced and logged rather than
 * treated as a chunk failure, same tolerant handling as the original.
 */
async function classifyChunk(chunk) {
  const truncatedById = new Map();
  const compactEmails = chunk.map((email) => {
    const wasTruncated = email.body.length > BODY_CAP;
    truncatedById.set(email.id, wasTruncated);
    const body = wasTruncated ? email.body.slice(0, BODY_CAP) + '\n\n...[truncated]' : email.body;
    return {
      source_email_id: email.id,
      sent: email.timestamp,
      from: `${email.from.name} <${email.from.email}>`,
      to: email.to.join(', '),
      cc: email.cc.join(', '),
      subject: email.subject,
      body,
    };
  });

  const rawText = await callLLM(
    SYSTEM_PROMPT,
    JSON.stringify(compactEmails, null, 2),
    { jsonSchema: CLASSIFICATION_SCHEMA, logLabel: '[triage]' }
  );

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseErr) {
    throw new Error(
      `[triage] Model response wasn't valid JSON. Raw content was:\n${rawText}\n\nParse error: ${parseErr.message}`
    );
  }

  if (parsed.classifications !== undefined && !Array.isArray(parsed.classifications)) {
    throw new Error(
      `[triage] Model response shape invalid: expected "classifications" to be an array, got ${typeof parsed.classifications} (${JSON.stringify(parsed.classifications)}).`
    );
  }
  const classifications = parsed.classifications ?? [];

  classifications.forEach((c, index) => {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      throw new Error(
        `[triage] Model response shape invalid: classifications[${index}] must be an object, got ${JSON.stringify(c)}.`
      );
    }
    if (typeof c.source_email_id !== 'string') {
      throw new Error(
        `[triage] Model response shape invalid: classifications[${index}].source_email_id must be a string, got ${typeof c.source_email_id} (${JSON.stringify(c.source_email_id)}).`
      );
    }
  });

  // Every email in this chunk must come back exactly once. This is the
  // one check that has no equivalent in dedup.js — a record dedup.js
  // fails to cluster just falls through to `standalone`, which is a
  // normal, expected outcome. A missing classification here is not a
  // safe default; it's a dropped email nobody triaged.
  const inputIds = chunk.map((e) => e.id);
  const outputIds = classifications.map((c) => c.source_email_id);
  const missingIds = inputIds.filter((id) => !outputIds.includes(id));
  const idCounts = new Map();
  outputIds.forEach((id) => idCounts.set(id, (idCounts.get(id) ?? 0) + 1));
  const duplicatedIds = [...idCounts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const hallucinatedIds = outputIds.filter((id) => !inputIds.includes(id));

  if (missingIds.length > 0 || duplicatedIds.length > 0 || hallucinatedIds.length > 0) {
    const problems = [];
    if (missingIds.length > 0) problems.push(`missing: ${missingIds.join(', ')}`);
    if (duplicatedIds.length > 0) problems.push(`duplicated: ${duplicatedIds.join(', ')}`);
    if (hallucinatedIds.length > 0) problems.push(`hallucinated (not in this chunk): ${hallucinatedIds.join(', ')}`);
    throw new Error(
      `[triage] Model response didn't classify this chunk 1:1 with the input emails (${problems.join('; ')}).`
    );
  }

  return classifications.map((c) => {
    let category = c.category;
    if (!VALID_CATEGORIES.includes(category)) {
      console.log(`[triage] Email ${c.source_email_id}: unexpected category "${category}", coercing to 'unknown'.`);
      category = 'unknown';
    }
    let priority = c.priority;
    if (!VALID_PRIORITIES.includes(priority)) {
      console.log(`[triage] Email ${c.source_email_id}: unexpected priority "${priority}", coercing to 'low'.`);
      priority = 'low';
    }
    return {
      source_email_id: c.source_email_id,
      category,
      priority,
      suggested_task: c.suggested_task ?? null,
      event_datetime: c.event_datetime ?? null,
      truncated: truncatedById.get(c.source_email_id) ?? false,
    };
  });
}

/**
 * Inputs: none.
 * Output: Promise<void> — writes task_list.json as a side effect.
 * What it does: the main entry point — splits the cached inbox into
 * CHUNK_SIZE-sized batches, classifies each via classifyChunk, and writes
 * the combined, priority-sorted result. A chunk that fails (bad JSON,
 * invalid shape, or a 1:1 mismatch) is logged with exactly which email
 * ids were skipped and the run continues with the remaining chunks,
 * rather than aborting the whole triage over one bad batch.
 */
async function main() {
  const emails = loadEmails();
  if (emails.length === 0) {
    console.log('Inbox is empty - nothing to sort.');
    fs.writeFileSync('task_list.json', JSON.stringify([], null, 2));
    return;
  }

  const chunks = chunkArray(emails, CHUNK_SIZE);
  const taskList = [];

  for (const [index, chunk] of chunks.entries()) {
    try {
      const results = await classifyChunk(chunk);
      taskList.push(...results);
    } catch (err) {
      const skippedIds = chunk.map((e) => e.id).join(', ');
      console.log(
        `[triage] Chunk ${index + 1}/${chunks.length} failed — skipping ${chunk.length} email(s): ${skippedIds}`
      );
      console.log(err.message);
    }
  }

  taskList.sort((a, b) => rank[a.priority] - rank[b.priority]);

  console.log(JSON.stringify(taskList, null, 2));
  fs.writeFileSync('task_list.json', JSON.stringify(taskList, null, 2));
}

main();
