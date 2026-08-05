// pipeline/openRouterClient.js
//
// Shared OpenRouter-calling boilerplate for dedup.js and synthesize.js.
// Both pipeline stages make a single bounded LLM call routed through
// OpenRouter's OpenAI-compatible chat completions API (not Anthropic's
// native Messages API) — see README for why that distinction matters.
//
// This module owns:
//   - building the request body (model, max_tokens, response_format,
//     system + user messages)
//   - the fetch call itself, wrapped in narrow retry-with-backoff
//   - checking response.ok, parsing the HTTP response body as JSON,
//     extracting choices[0].message.content, and checking it's non-empty
//   - the MODEL default fallback, in exactly ONE place — this is what
//     let dedup.js and synthesize.js drift out of sync on the default
//     model string earlier this session; now there's only one place to
//     get it right.
//
// What this module deliberately does NOT own: JSON.parse-ing the
// returned content string into the caller's expected answer shape, or
// validating that shape (dedup.js expects {clusters: [...]},
// synthesize.js expects {highlights: [...]} — different shapes, and
// that validation is caller-specific). Callers get back the raw
// `content` string and take it from there.

require("../config/env");

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_MODEL =
  process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";

// Bumped up from 2000: reasoning-tier models (like Nemotron 3 Ultra) can
// spend a chunk of the token budget on internal reasoning before writing
// the actual answer. If max_tokens runs out mid-reasoning, `content`
// comes back empty even though the call itself succeeded.
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_RESPONSE_FORMAT = { type: "json_object" };

// DEBUG_OPENROUTER=true (exact string match) turns on the full raw
// response dump on every genuinely successful call — see the strict
// "true" check where it's read, near the empty-content check below.
// Off by default. Only gates the success-path dump: error paths
// (non-2xx, network errors, unparseable JSON body, retry warnings, and
// the empty-content failure case) always log regardless of this flag.

// Retry policy for TRANSIENT failures only:
//   - non-2xx HTTP responses, but ONLY for statuses that are actually
//     transient — see isRetryableStatus() below. Permanent client errors
//     (bad request, auth, not found, etc.) are NOT retried: replaying the
//     exact same request body/headers can't produce a different outcome,
//     so those fail immediately on the first attempt instead of entering
//     this retry loop.
//   - network-level errors (fetch() itself throwing/rejecting)
//   - JSON parse failures on the raw HTTP response body
// This is a confirmed real failure mode: during testing, a truncated/bad
// JSON body on an otherwise-200 response happened once and resolved on a
// manual retry. Short backoff since this is an interactive CLI tool, not
// a background job.
//
// NOT retried here (by design):
//   - permanent client errors — 400, 401, 403, 404, 422, and (by default)
//     any other unlisted 4xx status. See isRetryableStatus() below; same
//     request, same failure, every time, so retrying is pointless.
//   - a missing OPENROUTER_API_KEY — a config error, fails before any
//     request is made, and retrying it can't help.
//   - empty `content` in an otherwise-successful response — a distinct
//     failure mode (e.g. ran out of max_tokens mid-reasoning), raised
//     immediately rather than burning attempts on it.
//   - response-shape validation failures ({clusters}/{highlights} not
//     matching what's expected) — that happens in the caller, after
//     this function has already returned successfully, so it's
//     naturally outside this retry loop.
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500; // 500ms, 1000ms, ... (doubling)

// Statuses that ARE retried (transient): rate limiting and server-side
// errors. This includes the 502 "ResourceExhausted" OpenRouter rate-limit
// case documented in the README — in practice retrying it won't help,
// since it's a sustained capacity issue rather than a one-off blip — but
// it's still a genuine 5xx-class transient failure, so it deliberately
// stays in the general retryable set rather than being special-cased out.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// Statuses that are NOT retried (permanent client errors): the request
// itself is wrong, so retrying with the same body/headers will always
// fail the exact same way.
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 422]);

// Any status not explicitly listed in either set above falls back to a
// default consistent with general HTTP/REST semantics: unlisted 4xx is
// treated as a permanent client error (don't retry), unlisted 5xx is
// treated as a transient server error (retry). This default is a
// deliberate choice, not an oversight.
function isRetryableStatus(status) {
  if (RETRYABLE_STATUSES.has(status)) return true;
  if (NON_RETRYABLE_STATUSES.has(status)) return false;
  return status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call OpenRouter's chat completions endpoint with narrow retry-with-
 * backoff around transient failures, and return the raw `content`
 * string from the model's response. The caller is responsible for
 * JSON.parse-ing that string and validating its shape.
 *
 * @param {string} systemPrompt
 * @param {string} userContent
 * @param {object} [options]
 * @param {string} [options.model] - overrides OPENROUTER_MODEL / the built-in default
 * @param {number} [options.maxTokens] - overrides the 8000-token default
 * @param {object} [options.responseFormat] - overrides the json_object default
 * @param {string} [options.logLabel] - prefix for console/error output, e.g. "[dedup]"
 * @returns {Promise<string>} the raw `choices[0].message.content` string
 */
async function callOpenRouter(systemPrompt, userContent, options = {}) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Set it in your environment before calling callOpenRouter()."
    );
  }

  const model = options.model || DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const responseFormat = options.responseFormat ?? DEFAULT_RESPONSE_FORMAT;
  const logLabel = options.logLabel ?? "[openRouterClient]";

  const requestBody = JSON.stringify({
    model,
    max_tokens: maxTokens,
    response_format: responseFormat,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  });

  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(OPENROUTER_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        },
        body: requestBody,
      });
    } catch (networkErr) {
      lastError = new Error(
        `${logLabel} Network error calling OpenRouter: ${networkErr.message}`
      );
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `${lastError.message} (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying...`
        );
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      break;
    }

    if (!response.ok) {
      const errBody = await response.text();

      if (!isRetryableStatus(response.status)) {
        // Permanent client error — the request itself is wrong, so a
        // retry can never produce a different result. Fail immediately
        // on this first attempt rather than burning backoff/requests on
        // it, and don't phrase this as a "failed after N attempts"
        // error since it was never actually retried.
        throw new Error(
          `${logLabel} OpenRouter API error ${response.status}: ${errBody}`
        );
      }

      lastError = new Error(
        `${logLabel} OpenRouter API error ${response.status}: ${errBody}`
      );
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `${lastError.message} (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying...`
        );
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      break;
    }

    let data;
    try {
      data = await response.json();
    } catch (parseErr) {
      // Confirmed real failure mode: a bad/truncated JSON body on an
      // otherwise-200 response. Transient — retry it.
      lastError = new Error(
        `${logLabel} OpenRouter returned a ${response.status} response with a body that wasn't valid JSON: ${parseErr.message}`
      );
      if (attempt < MAX_ATTEMPTS) {
        console.warn(
          `${lastError.message} (attempt ${attempt}/${MAX_ATTEMPTS}) — retrying...`
        );
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      break;
    }

    // Past this point the HTTP call itself succeeded — not retried
    // further.
    const rawText = data.choices?.[0]?.message?.content ?? "";

    if (!rawText || rawText.trim() === "") {
      // Empty-content FAILURE path (e.g. ran out of max_tokens
      // mid-reasoning). This is error-diagnostic info, not a success
      // dump, so it stays UNCONDITIONAL regardless of DEBUG_OPENROUTER —
      // the thrown error message below literally says "logged above"
      // and depends on this having printed.
      console.log(`${logLabel} Raw model response:`, JSON.stringify(data, null, 2));
      throw new Error(
        `${logLabel} Model returned empty content. Full response logged above — ` +
        `check finish_reason (e.g. 'length' means it ran out of tokens ` +
        `before writing an answer).`
      );
    }

    // Genuine success — dump the full raw response only when explicitly
    // opted into via DEBUG_OPENROUTER=true (default off; the full body
    // is large and noisy on every call). Strict "true" check, not
    // truthiness, so DEBUG_OPENROUTER=false doesn't accidentally enable it.
    if (process.env.DEBUG_OPENROUTER === "true") {
      console.log(`${logLabel} Raw model response:`, JSON.stringify(data, null, 2));
    }

    return rawText;
  }

  throw new Error(
    `${logLabel} OpenRouter call failed after ${MAX_ATTEMPTS} attempts. Last error: ${lastError.message}`
  );
}

module.exports = { callOpenRouter };
