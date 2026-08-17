/**
 * openRouterClient.js
 *
 * Shared OpenRouter-calling boilerplate for every LLM call in Agent 1
 * (emailPriority.js, askInbox.js, draftReply.js, formatDigest.js).
 * Ported from Agent 2/pipeline/openRouterClient.js and converted from
 * CommonJS to ESM. All calls go through OpenRouter's OpenAI-compatible
 * chat completions API, not Anthropic's native Messages API — so there
 * is no `response.content[0].text` block array here, and no assistant-turn
 * prefill: callers get back the raw `choices[0].message.content` string.
 *
 * This module owns:
 *   - building the request body (model, max_tokens, response_format,
 *     system + user messages)
 *   - the fetch call itself, wrapped in narrow retry-with-backoff
 *   - checking response.ok, parsing the HTTP response body as JSON,
 *     extracting choices[0].message.content, and checking it's non-empty
 *   - the model default fallback, in exactly ONE place — this is what
 *     let Agent 2's dedup.js and synthesize.js drift out of sync on the
 *     default model string, and what let Agent 1's four call sites each
 *     hardcode their own model string.
 *
 * What this module deliberately does NOT own:
 *
 *   - Loading .env. Agent 1's entry points (emailPriority.js,
 *     postDigest.js, previewDigest.js, discordBot.js, registerCommand.js)
 *     each already call dotenv.config({ path: ['.env', '../.env'] })
 *     themselves. This module assumes process.env is already populated by
 *     the time callOpenRouter() is invoked — see the note on lazy env
 *     reads below, which is what makes that assumption safe.
 *
 *   - JSON.parse-ing the returned content string into the caller's
 *     expected answer shape, or validating that shape. emailPriority.js
 *     expects a {classifications: [...]} object; askInbox.js,
 *     draftReply.js, and formatDigest.js expect plain prose. That
 *     validation is caller-specific.
 */

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Hardcoded last-resort model, used only when OPENROUTER_MODEL is unset.
//
// IMPORTANT: this is a bare constant, NOT `process.env.OPENROUTER_MODEL || ...`
// evaluated here at module scope. Agent 1 is an ESM project ("type": "module"),
// and ESM hoists every `import` statement above all other code in the importing
// module — including that module's own dotenv.config() call, regardless of
// textual order. So a module-load-time read of process.env.OPENROUTER_MODEL
// would run BEFORE .env was loaded on every single entry point, silently and
// permanently locking in this fallback and ignoring the configured value.
// The actual resolution therefore happens per-call inside callOpenRouter(),
// by which point the caller's dotenv.config() has definitely run.
const FALLBACK_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

// Bumped up from 2000: reasoning-tier models (like Nemotron 3 Ultra) can
// spend a chunk of the token budget on internal reasoning before writing
// the actual answer. If max_tokens runs out mid-reasoning, `content`
// comes back empty even though the call itself succeeded.
const DEFAULT_MAX_TOKENS = 8000;
const DEFAULT_RESPONSE_FORMAT = { type: "json_object" };

// Per-attempt wall-clock ceiling. Without this, fetch() has NO timeout and a
// stalled upstream blocks forever with zero signal — observed live on
// 2026-08-11, where the configured model returned HTTP 200 headers in ~10.6s
// and then held the response body open indefinitely on a max_tokens=300
// request. Under cron that wedges the whole triage run silently.
//
// This bounds ONE attempt, not the whole call: a timeout is a transient
// network-level failure and flows through the normal retry path below, so the
// worst case is MAX_ATTEMPTS * DEFAULT_TIMEOUT_MS plus backoff (~6 minutes at
// these defaults). That is deliberately kept under Discord's 15-minute
// interaction expiry so /ask and /draft can still report a real failure.
const DEFAULT_TIMEOUT_MS = 120000;

// AbortSignal.timeout() rejects with a DOMException named "TimeoutError".
// It can surface in EITHER of two places — while awaiting fetch() (no headers
// yet) or while awaiting response.json() (headers arrived, body stalled) — so
// both catch blocks below check for it. Without this check the second case
// reports the misleading "body wasn't valid JSON", which is exactly what the
// pre-fix client printed when this was first observed.
function isTimeoutError(err) {
  return err?.name === "TimeoutError";
}

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
//   - an `error` object in an otherwise-2xx response body (see the
//     data.error guard below) — OpenRouter signals upstream provider
//     failures this way instead of with an HTTP status, so these never
//     reach isRetryableStatus() at all.
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
//   - response-shape validation failures (the caller's expected JSON
//     shape not matching) — that happens in the caller, after this
//     function has already returned successfully, so it's naturally
//     outside this retry loop.
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500; // 500ms, 1000ms, ... (doubling)

// Statuses that ARE retried (transient): rate limiting and server-side
// errors. This includes the 502 "ResourceExhausted" OpenRouter rate-limit
// case documented in Agent 2's README — in practice retrying it won't help,
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
 * JSON.parse-ing that string (when it asked for JSON) and validating
 * its shape.
 *
 * @param {string} systemPrompt
 * @param {string} userContent
 * @param {object} [options]
 * @param {string} [options.model] - overrides OPENROUTER_MODEL / the built-in fallback
 * @param {number} [options.maxTokens] - overrides the 8000-token default
 * @param {object} [options.responseFormat] - overrides the json_object default;
 *   pass { type: 'text' } for prose responses
 * @param {string} [options.logLabel] - prefix for console/error output, e.g. "[askInbox]"
 * @param {number} [options.timeoutMs] - per-attempt wall-clock ceiling; overrides
 *   the 120s default. Applies to headers AND body; a timeout is retried like any
 *   other transient network failure.
 * @returns {Promise<string>} the raw `choices[0].message.content` string
 */
export async function callOpenRouter(systemPrompt, userContent, options = {}) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Set it in your environment before calling callOpenRouter()."
    );
  }

  // Resolved per-call, not at module load — see the FALLBACK_MODEL comment
  // above for why this ordering is load-bearing under ESM import hoisting.
  const model = options.model || process.env.OPENROUTER_MODEL || FALLBACK_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const responseFormat = options.responseFormat ?? DEFAULT_RESPONSE_FORMAT;
  const logLabel = options.logLabel ?? "[openRouterClient]";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

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
        // Bounds this attempt. Covers both waiting for headers and reading
        // the body — see DEFAULT_TIMEOUT_MS above.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (networkErr) {
      lastError = new Error(
        isTimeoutError(networkErr)
          ? `${logLabel} OpenRouter request timed out after ${timeoutMs}ms (no response headers).`
          : `${logLabel} Network error calling OpenRouter: ${networkErr.message}`
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
      // Two distinct causes land here, and conflating them is actively
      // misleading:
      //   1. A bad/truncated JSON body on an otherwise-200 response — a
      //      confirmed real failure mode, transient, retry it.
      //   2. The per-attempt timeout firing DURING the body read, after
      //      headers already arrived. Reporting that as "wasn't valid JSON"
      //      is what the pre-fix client did, and it sent debugging in
      //      entirely the wrong direction.
      lastError = new Error(
        isTimeoutError(parseErr)
          ? `${logLabel} OpenRouter sent ${response.status} headers but the response body stalled; timed out after ${timeoutMs}ms.`
          : `${logLabel} OpenRouter returned a ${response.status} response with a body that wasn't valid JSON: ${parseErr.message}`
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

    // OpenRouter reports upstream provider failures as an `error` object
    // inside an HTTP 200 body rather than as an HTTP status, e.g.
    //   {"error":{"message":"Upstream error from Nvidia: ResourceExhausted:
    //             Worker local total request limit reached (93/32)","code":502}}
    // Because the status is 200, isRetryableStatus() never sees it. Before
    // this guard existed the response fell through to the empty-content
    // check below and threw immediately WITHOUT retrying — which is a
    // confirmed production failure, not a hypothetical: it silently dropped
    // a whole 5-email chunk during the emailPriority.js migration run, and
    // the identical call succeeded on a plain re-run moments later. Treated
    // as transient and routed through the same retry/backoff as the other
    // transient cases.
    if (data.error) {
      lastError = new Error(
        `${logLabel} OpenRouter returned an error object in a ${response.status} body: ${JSON.stringify(data.error)}`
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

    // Past this point the HTTP call itself succeeded and carried no error
    // object — not retried further.
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
