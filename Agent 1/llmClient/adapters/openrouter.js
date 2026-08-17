/**
 * llmClient/adapters/openrouter.js
 *
 * Thin re-export, not a rebuild. openRouterClient.js already has real
 * validation behind it — 23/23 behavior tests, the lazy-model-resolution
 * fix (verified red/green), and live testing against real capacity-
 * exhaustion responses. It is NOT rewritten on top of the shared
 * openAICompatible.js factory here, specifically so that already-
 * validated behavior isn't silently swapped for new, unvalidated code
 * just for the sake of architectural tidiness.
 *
 * RESOLVED (2026-08-12): the 200-with-error-body fix HAS now been
 * applied directly in openRouterClient.js and proven red/green — the
 * pre-fix control gave up after 1 attempt and misreported the failure
 * as "empty content", while the fixed client retries all 3 attempts and
 * names the real cause; a transient-then-success sequence now recovers
 * on attempt 2 where it previously lost the call. 27/27 stub assertions
 * plus live calls in both JSON and text mode. This adapter therefore
 * inherits the guard through the wrapped client, and openrouter is
 * hardened in the same sense as the rest of the harness, not merely
 * "already validated" in a narrower one.
 *
 * WHY THIS IS NO LONGER A BARE RE-EXPORT (2026-08-13): it used to be
 * `export { callOpenRouter } from '../../openRouterClient.js'`, which
 * silently dropped every option the harness speaks. callLLM's vocabulary
 * is { jsonMode, jsonSchema }; openRouterClient.js's is
 * { responseFormat }. A bare re-export means callLLM(..., { jsonMode:
 * false }) hands openRouterClient an option it has never heard of, which
 * then applies its own default — json_object. Prose callers (askInbox,
 * formatDigest, draftReply's generateReplyBody) would have got JSON-mode
 * output while explicitly asking for text. That was latent rather than
 * broken only because nothing imported callLLM until now; re-pointing the
 * four call sites is exactly what would have activated it.
 *
 * jsonSchema is accepted and deliberately DISCARDED. OpenRouter is
 * registered jsonMode: 'best-effort' (registry.js) — response_format:
 * json_object guarantees the response parses, never that it matches a
 * shape. Silently ignoring the schema is the honest behavior; pretending
 * to honor it would misreport the guarantee. Callers that need real shape
 * enforcement (emailPriority.js, draftReply.js's generateFreshEmail) must
 * still validate what comes back, which both do.
 *
 * Path below assumes openRouterClient.js sits at the Agent 1 root,
 * one level up from llmClient/adapters/ — adjust if it lives elsewhere.
 */
import { callOpenRouter as callOpenRouterClient } from '../../openRouterClient.js';

/**
 * Inputs: systemPrompt, userContent (strings); options — the harness's
 * shared option vocabulary { jsonMode, jsonSchema, model, maxTokens,
 * logLabel, timeoutMs }.
 * Output: Promise<string> — the raw content string, same as every other
 * adapter returns.
 * What it does: translates harness options into openRouterClient.js's
 * option names and calls it.
 * How it does it: maps jsonMode === false to responseFormat { type:
 * 'text' } and anything else to json_object, drops jsonSchema (see
 * above), and passes everything else through untouched. responseFormat is
 * set AFTER the passthrough spread on purpose — a caller reaching past
 * the harness vocabulary to set it directly is not the interface this
 * adapter presents, so jsonMode always wins.
 */
export async function callOpenRouter(systemPrompt, userContent, options = {}) {
  const { jsonMode, jsonSchema, ...passthrough } = options;
  return callOpenRouterClient(systemPrompt, userContent, {
    ...passthrough,
    responseFormat: jsonMode === false ? { type: 'text' } : { type: 'json_object' },
  });
}
