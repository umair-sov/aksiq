/**
 * llmClient/adapters/deepseek.js
 *
 * DeepSeek speaks the OpenAI-compatible chat-completions shape, so this
 * is a thin config on the shared factory rather than a near-duplicate
 * of openai.js/gemini.js. Registered as jsonMode: 'best-effort' —
 * DeepSeek's json_object mode guarantees valid JSON, not a specific
 * shape; there's no schema-strict mode to opt into here.
 *
 * NOT YET VALIDATED (registry.js: validated: false).
 */
import { createOpenAICompatibleAdapter } from './openAICompatible.js';

export const callDeepSeek = createOpenAICompatibleAdapter({
  baseURL: 'https://api.deepseek.com/chat/completions',
  apiKeyEnvVar: 'DEEPSEEK_API_KEY',
  defaultModelEnvVar: 'DEEPSEEK_MODEL',
  fallbackModel: 'deepseek-chat',
  retryableStatuses: new Set([429, 500, 502, 503, 504]),
  logLabel: '[deepseek]',
});
