/**
 * llmClient/adapters/openai.js
 *
 * Real strict-JSON via response_format: { type: 'json_schema', strict:
 * true, json_schema: {...} } when options.jsonSchema is supplied — a
 * genuine shape guarantee, not prompt coercion, which is why openai is
 * registered as jsonMode: 'strict'. Without a schema, falls back to
 * response_format: { type: 'json_object' } (valid JSON, shape not
 * enforced) — functionally best-effort in that case. Kept as its own
 * file rather than built on the shared openAICompatible factory,
 * specifically because that factory only ever produces best-effort
 * behavior; folding OpenAI's real capability into it would blur a
 * distinction worth keeping explicit in the code, not just in comments.
 *
 * NOT YET VALIDATED (registry.js: validated: false).
 */
import { withRetry } from '../retry.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

export async function callOpenAI(systemPrompt, userContent, options = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('[openai] OPENAI_API_KEY is not set.');
  }

  const model = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
  const wantsJson = options.jsonMode !== false;

  let responseFormat = { type: 'text' };
  if (wantsJson) {
    responseFormat = options.jsonSchema
      ? { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: options.jsonSchema } }
      : { type: 'json_object' };
  }

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
    const response = await fetch(ENDPOINT, {
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
    if (err) return true;
    if (parsedBody === null) return true;
    if ([429, 500, 502, 503, 504].includes(response.status)) return true;
    // Same guard as the OpenRouter bug, but scoped to a SUCCESS status.
    // Unscoped it fired on any error body, so a permanent 400 (bad
    // request, bad json_schema) burned all three attempts instead of
    // failing fast. OpenAI's real envelope is {error:{message,type,code,
    // param}} — confirmed live against the API with an invalid key.
    // Genuine 4xx/5xx is already handled by the status branch above.
    if (response.ok && parsedBody?.error) return true;
    return false;
  };

  const { parsedBody } = await withRetry(attemptFn, isRetryable, options.logLabel ?? '[openai]');

  if (parsedBody?.error) {
    throw new Error(`[openai] API error after retries: ${JSON.stringify(parsedBody.error)}`);
  }

  const content = parsedBody?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(`[openai] Empty content. finish_reason: ${parsedBody?.choices?.[0]?.finish_reason}.`);
  }
  return content;
}
