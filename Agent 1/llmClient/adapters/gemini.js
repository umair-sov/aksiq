/**
 * llmClient/adapters/gemini.js
 *
 * Raw REST, not the Google SDK — keeps the same "native fetch only,
 * zero dependencies" house style openRouterClient.js already
 * established, rather than pulling in @google/genai's dependency tree.
 *
 * Real strict-JSON via generationConfig.responseSchema when
 * options.jsonSchema is supplied. Without one, falls back to
 * responseMimeType: 'application/json' alone — guarantees syntactically
 * valid JSON but not a specific shape, functionally close to
 * best-effort in that case. The 'strict' registration in registry.js
 * assumes callers actually pass a schema when shape matters.
 *
 * Auth via the x-goog-api-key header rather than a ?key= query
 * parameter — avoids putting the key anywhere it could end up logged
 * in a URL (proxy logs, browser history if ever hit manually, etc.).
 *
 * NOT YET VALIDATED (registry.js: validated: false).
 */
import { withRetry } from '../retry.js';

export async function callGemini(systemPrompt, userContent, options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('[gemini] GEMINI_API_KEY is not set.');
  }

  const model = options.model ?? process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
  const wantsJson = options.jsonMode !== false;

  const generationConfig = { maxOutputTokens: options.maxTokens ?? 8000 };
  if (wantsJson) {
    generationConfig.responseMimeType = 'application/json';
    if (options.jsonSchema) {
      generationConfig.responseSchema = options.jsonSchema;
    }
  }

  const requestBody = JSON.stringify({
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: 'user', parts: [{ text: userContent }] }],
    generationConfig,
  });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const attemptFn = async () => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
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
    // Scoped to a SUCCESS status, same as anthropic.js and the other
    // adapters. Unscoped this fired on any error body, so a permanent
    // 400 (invalid request, bad responseSchema) burned all three
    // attempts instead of failing fast.
    //
    // Gemini's envelope is {error:{code,message,status,details}} —
    // confirmed live against the real endpoint with an invalid key. Note
    // the INNER shape differs from the OpenAI-compatible providers
    // ({message,type,code,param}); only the top-level `error` key is
    // common, which is all this predicate tests for.
    if (response.ok && parsedBody?.error) return true;
    return false;
  };

  const { parsedBody } = await withRetry(attemptFn, isRetryable, options.logLabel ?? '[gemini]');

  if (parsedBody?.error) {
    throw new Error(`[gemini] API error after retries: ${JSON.stringify(parsedBody.error)}`);
  }

  const text = parsedBody?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error(
      `[gemini] Empty text content. finishReason: ${parsedBody?.candidates?.[0]?.finishReason}.`
    );
  }
  return text;
}
