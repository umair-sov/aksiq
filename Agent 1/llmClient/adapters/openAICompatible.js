/**
 * llmClient/adapters/openAICompatible.js
 *
 * Factory for providers speaking the OpenAI chat-completions shape.
 * DeepSeek uses this directly (deepseek.js is a thin config on top of
 * it). OpenRouter does NOT use this — its existing, already-tested
 * openRouterClient.js is kept as-is rather than being rebuilt on this
 * factory, so real validated behavior isn't silently swapped for new,
 * unvalidated code (see adapters/openrouter.js). OpenAI does NOT use
 * this either — its real json_schema strict mode is different enough
 * from best-effort json_object that it gets its own explicit adapter
 * rather than being bolted onto a factory built for the weaker mode.
 *
 * This factory only ever produces 'best-effort' JSON behavior
 * (response_format: json_object) — matching what DeepSeek and
 * OpenRouter can actually guarantee. Do not extend it to claim strict
 * schema support; that would misrepresent what these providers do.
 *
 * ENV READ TIMING: every env read in the returned call function is
 * inside the function body, not at factory-call time or module load
 * time. This is deliberate — see openRouterClient.js's port history:
 * ESM import hoisting means a module-load-time env read can silently
 * run before dotenv.config() in the caller's entry point. Do not
 * "simplify" this by hoisting a resolved config object to module scope.
 *
 * The 200-with-error-body guard (checking parsedBody.error even on an
 * HTTP 200) is baked in here from the start, proactively, rather than
 * being a fix applied after the fact the way it was for OpenRouter —
 * every provider built on this factory inherits it for free.
 */
import { withRetry } from '../retry.js';

/**
 * Inputs: config (Object) — { baseURL, apiKeyEnvVar, defaultModelEnvVar,
 * fallbackModel, retryableStatuses: Set<number>, logLabel }.
 * Output: (systemPrompt, userContent, options) => Promise<string> — an
 * adapter function matching every other adapter's contract in this
 * project: takes the same three arguments, returns the same shape.
 */
export function createOpenAICompatibleAdapter(config) {
  return async function callProvider(systemPrompt, userContent, options = {}) {
    const apiKey = process.env[config.apiKeyEnvVar];
    if (!apiKey) {
      throw new Error(`${config.logLabel} ${config.apiKeyEnvVar} is not set.`);
    }

    const model = options.model ?? process.env[config.defaultModelEnvVar] ?? config.fallbackModel;
    if (!model) {
      throw new Error(
        `${config.logLabel} No model resolved — set ${config.defaultModelEnvVar} in .env or pass ` +
        `options.model explicitly.`
      );
    }

    const wantsJson = options.jsonMode !== false;
    const responseFormat = wantsJson ? { type: 'json_object' } : { type: 'text' };

    const requestBody = JSON.stringify({
      model,
      max_tokens: options.maxTokens ?? 8000,
      response_format: responseFormat,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    });

    const attemptFn = async () => {
      const response = await fetch(config.baseURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: requestBody,
      });
      const parsedBody = await response.json().catch(() => null);
      return { response, parsedBody };
    };

    const isRetryable = (response, parsedBody, err) => {
      if (err) return true; // network / fetch-level failure
      if (parsedBody === null) return true; // 2xx with an unparseable body
      if (config.retryableStatuses.has(response.status)) return true;
      // The class of bug found in OpenRouter: some providers return
      // HTTP 200 with an error object in the body instead of a real
      // error status.
      //
      // Scoped to response.ok DELIBERATELY. Unscoped, this fired on any
      // error body at all — so a permanent 400 (bad request, bad schema)
      // was retried all three attempts before failing, burning the whole
      // retry budget on something that can never succeed and directly
      // contradicting the fail-fast intent of retryableStatuses above.
      // A genuine 4xx/5xx is already classified correctly by that set;
      // this guard exists ONLY for the "looks like success, actually
      // failed" shape. Same scoping anthropic.js uses.
      if (response.ok && parsedBody?.error) return true;
      return false;
    };

    const { parsedBody } = await withRetry(attemptFn, isRetryable, config.logLabel);

    if (parsedBody?.error) {
      throw new Error(`${config.logLabel} Provider returned an error after retries: ${JSON.stringify(parsedBody.error)}`);
    }

    const content = parsedBody?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(
        `${config.logLabel} Empty content on an otherwise-successful response. ` +
        `finish_reason: ${parsedBody?.choices?.[0]?.finish_reason}. This usually means max_tokens was too low.`
      );
    }

    return content;
  };
}
