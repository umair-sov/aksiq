/**
 * llmClient/retry.js
 *
 * The one piece of retry behavior that's genuinely shared across every
 * provider: attempt counting and exponential backoff timing. What is
 * NOT shared, and must not be — what actually counts as retryable.
 * That's provider-specific: status codes mean different things per
 * provider, and OpenRouter's 200-with-error-body bug is a live example
 * of why a naive "just check the status code" rule is wrong. Each
 * adapter supplies its own isRetryable(response, parsedBody, error)
 * predicate; this module only owns the loop shape.
 */

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inputs:
 *   attemptFn — async () => { response, parsedBody }. Should perform
 *     exactly one HTTP attempt and return the fetch Response plus its
 *     already-parsed JSON body (null if parsing failed), or throw on a
 *     network-level failure.
 *   isRetryable — (response, parsedBody, error) => boolean. Called with
 *     (response, parsedBody, undefined) on a completed request, or
 *     (undefined, undefined, error) when attemptFn threw. Provider-
 *     specific — see each adapter for its own definition.
 *   logLabel — string, prefixed to retry/backoff log lines.
 * Output: Promise<{ response, parsedBody }> — the first outcome that
 * either succeeds (isRetryable returns false) or exhausts MAX_ATTEMPTS.
 * Throws the last error, or a synthesized error describing the last
 * response, if every attempt is exhausted.
 */
export async function withRetry(attemptFn, isRetryable, logLabel = '[llmClient]') {
  let lastOutcome;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const outcome = await attemptFn();
      if (!isRetryable(outcome.response, outcome.parsedBody, undefined)) {
        return outcome;
      }
      lastOutcome = outcome;
    } catch (err) {
      if (!isRetryable(undefined, undefined, err)) {
        throw err;
      }
      lastOutcome = { error: err };
    }

    if (attempt < MAX_ATTEMPTS) {
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      console.warn(`${logLabel} Attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying in ${backoff}ms...`);
      await sleep(backoff);
    }
  }

  if (lastOutcome?.error) throw lastOutcome.error;
  throw new Error(
    `${logLabel} Exhausted ${MAX_ATTEMPTS} attempts. Last response status: ` +
    `${lastOutcome?.response?.status}, body: ${JSON.stringify(lastOutcome?.parsedBody)}`
  );
}
