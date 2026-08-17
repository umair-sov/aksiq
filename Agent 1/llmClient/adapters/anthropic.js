/**
 * llmClient/adapters/anthropic.js
 *
 * Real strict-JSON enforcement here is forced tool-use, not the old
 * prefill trick (content: '{') emailPriority.js originally used.
 * Prefill is rejected outright on Claude 4.6-and-later models, so it's
 * a dead end regardless of provider-agnosticism goals. Forcing a
 * single tool call via tool_choice gets a real shape guarantee — the
 * model can only emit arguments matching that tool's input_schema —
 * which is why anthropic is registered as jsonMode: 'strict', not
 * 'best-effort'. Requires the caller to actually pass options.jsonSchema;
 * without one, this falls through to a plain text call.
 *
 * VALIDATED 2026-08-12 (registry.js: validated: true). Live-tested
 * against the real API, not assumed correct: forced tool-use returned a
 * shape-exact object with correct types for a supplied jsonSchema, text
 * mode returned prose, and a nonexistent model failed fast (362ms, one
 * attempt) with Anthropic's real not_found_error envelope. Quality pass
 * on the project's 25-email cache: 25/25 coverage, 5/5 chunks 1:1, zero
 * invalid enum values, 5 deadlines extracted.
 *
 * Two bugs were found and fixed during that validation — see the
 * isRetryable comments below: 529 (overloaded_error) was missing from
 * the retryable set, and the 200-with-error-body guard every sibling
 * adapter carries was absent here.
 */
import { withRetry } from '../retry.js';

const ANTHROPIC_VERSION = '2023-06-01';
const ENDPOINT = 'https://api.anthropic.com/v1/messages';

// A generic single-purpose tool whose input_schema IS whatever shape
// the caller wants — this is how "force valid JSON matching a schema"
// gets done on Anthropic's API, since there's no direct response_format
// equivalent the way OpenAI/DeepSeek/OpenRouter have.
function buildForcedJsonTool(schema) {
  return {
    name: 'emit_structured_response',
    description: 'Emit the response in the required structured shape.',
    input_schema: schema,
    // Without this, input_schema is ADVISORY — Anthropic does not validate
    // the tool input against it, and forcing the tool call only guarantees
    // that a tool call happens, not that its arguments match the schema.
    // Measured 2026-08-12: claude-sonnet-5 intermittently double-encoded
    // the response, returning `classifications` as a STRING containing the
    // whole JSON object instead of an array — 3 of 15 chunks across three
    // runs, which in production silently loses 5 emails per occurrence.
    // Sonnet 4.6 and Haiku 4.5 happened to comply anyway; compliance by
    // luck is not a guarantee.
    //
    // strict: true makes the schema enforced rather than advisory. Callers
    // must supply a schema that meets its preconditions: additionalProperties
    // false and a complete `required` array on every object.
    //
    // Nullable fields: BOTH `type: ['string','null']` and
    // anyOf: [{type:'string'},{type:'null'}] were accepted when tested
    // against the live API on 2026-08-12 — the union-type form is not
    // rejected, contrary to what the absence of union types from the
    // documented "supported" list might suggest.
    strict: true,
  };
}

/**
 * Inputs: systemPrompt, userContent (strings), options — { model,
 * maxTokens, jsonMode, jsonSchema, logLabel }. jsonMode !== false AND
 * a jsonSchema supplied together trigger forced tool-use; otherwise
 * this is a plain text call.
 * Output: Promise<string> — either the JSON.stringify'd tool input
 * (forced-JSON mode) or the plain response text (text mode) — every
 * adapter in this project returns the same shape regardless of provider,
 * so callers never need to know which one answered.
 */
export async function callAnthropic(systemPrompt, userContent, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('[anthropic] ANTHROPIC_API_KEY is not set.');
  }

  const model = options.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  const wantsJson = options.jsonMode !== false;
  const useForcedTool = wantsJson && Boolean(options.jsonSchema);

  const requestBody = {
    model,
    max_tokens: options.maxTokens ?? 8000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  };

  if (useForcedTool) {
    const tool = buildForcedJsonTool(options.jsonSchema);
    requestBody.tools = [tool];
    requestBody.tool_choice = { type: 'tool', name: tool.name };
  }

  const attemptFn = async () => {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(requestBody),
    });
    const parsedBody = await response.json().catch(() => null);
    return { response, parsedBody };
  };

  const isRetryable = (response, parsedBody, err) => {
    if (err) return true;
    if (parsedBody === null) return true;
    // Anthropic's transient set: rate limit + server-side failures.
    // 400/401/403/404-class errors are permanent — retrying them just
    // wastes the attempt budget on something that will never succeed.
    //
    // 529 (overloaded_error) is Anthropic-specific and documented as
    // retryable. It was absent from this list, which meant a transient
    // overload failed outright on the first attempt instead of backing
    // off — the one status most likely to appear under real load.
    if ([429, 500, 502, 503, 504, 529].includes(response.status)) return true;
    // The 200-with-error-body guard every sibling adapter carries
    // (openAICompatible.js, openai.js, gemini.js) but this one did not.
    // Anthropic's error envelope is {type:'error', error:{...}}, so the
    // check is on `type`, not `error`.
    //
    // Scoped to 2xx ON PURPOSE. The siblings apply their guard at any
    // status, which silently makes permanent 4xx errors retryable —
    // a 400 bad-request there burns all three attempts. Restricting it
    // to a success status keeps the original intent (catch an error
    // smuggled inside a 200) without breaking fail-fast on 4xx.
    if (response.ok && parsedBody?.type === 'error') return true;
    return false;
  };

  const { parsedBody } = await withRetry(attemptFn, isRetryable, options.logLabel ?? '[anthropic]');

  if (parsedBody?.type === 'error') {
    throw new Error(`[anthropic] API error after retries: ${JSON.stringify(parsedBody.error)}`);
  }

  if (useForcedTool) {
    const toolUseBlock = parsedBody?.content?.find((block) => block.type === 'tool_use');
    if (!toolUseBlock) {
      throw new Error(
        `[anthropic] Expected a forced tool_use block, got none. stop_reason: ${parsedBody?.stop_reason}.`
      );
    }
    // input is already a parsed object (Anthropic parses tool arguments
    // for you) — stringify it so this adapter's return type matches
    // every other adapter's (a raw string the caller JSON.parses).
    return JSON.stringify(toolUseBlock.input);
  }

  const textBlock = parsedBody?.content?.find((block) => block.type === 'text');
  if (!textBlock?.text) {
    throw new Error(`[anthropic] Empty text content. stop_reason: ${parsedBody?.stop_reason}.`);
  }
  return textBlock.text;
}
