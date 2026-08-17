/**
 * llmClient/registry.js
 *
 * Single source of truth for every supported provider: which adapter
 * handles it, what JSON-enforcement guarantee it actually offers, its
 * default model, and whether it's been validated yet.
 *
 * "validated: false" is a hard gate, not a note — index.js refuses to
 * route a real call to an unvalidated provider (see getProviderConfig
 * below). A provider only flips to true once it's been through the
 * same rigor openRouterClient.js already got: live retry/error testing
 * against real failure responses (not just the happy path), and a
 * quality pass against a real email batch.
 *
 * jsonMode:
 *   'strict'      — the provider enforces response SHAPE, not just
 *                    valid-JSON-ness (Anthropic forced tool-use with
 *                    strict: true, OpenAI json_schema strict mode,
 *                    Gemini responseSchema — all conditional on the
 *                    caller actually supplying a schema; see each
 *                    adapter).
 *
 *                    WHAT 'strict' DOES AND DOES NOT BUY YOU — this was
 *                    overstated here until 2026-08-12. It guarantees the
 *                    STRUCTURE of the response: field names, types,
 *                    enum membership, no extra properties. It does NOT
 *                    guarantee SEMANTIC completeness. Measured on
 *                    claude-sonnet-5: enabling strict eliminated shape
 *                    violations entirely (3 of 15 chunks -> 0 of 15,
 *                    where the model had been returning the whole JSON
 *                    object double-encoded as a string), but one chunk
 *                    still came back a well-formed array containing 1
 *                    classification for 5 input emails. Perfectly valid
 *                    against the schema; four emails silently dropped.
 *
 *                    So a 'strict' provider still needs the caller's own
 *                    1:1 / completeness validation — exactly what
 *                    emailPriority.js's classifyChunk already does.
 *                    Treat 'strict' as "the shape is trustworthy", never
 *                    as "the content is complete".
 *   'best-effort' — valid JSON is guaranteed, but shape is enforced by
 *                    prompt wording alone (DeepSeek, OpenRouter's
 *                    response_format: json_object).
 *
 * This distinction is load-bearing, not decorative: emailPriority.js
 * (or whatever eventually replaces its OpenRouter-only wiring) should
 * be able to refuse a 'best-effort' provider for anything where a wrong
 * shape means a silently dropped or corrupted classification — the
 * exact failure category already hit once with the Nemotron quality
 * regression.
 */

export const PROVIDERS = {
  anthropic: {
    adapter: 'anthropic',
    jsonMode: 'strict',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-sonnet-4-6',
    // VALIDATED 2026-08-12 against live Anthropic. The old prefill trick
    // emailPriority.js used is gone (rejected on 4.6-and-later models),
    // replaced with forced tool-use, and that path is now proven rather
    // than assumed: a real jsonSchema came back shape-exact with correct
    // TYPES (number/boolean, not stringified); text mode returns prose;
    // a nonexistent model fails fast in 362ms with Anthropic's real
    // not_found_error envelope and burns no retry budget. Quality pass on
    // the same 25-email cache as the four free-tier models: 25/25
    // coverage, 5/5 chunks 1:1, 0 invalid enums, 5 deadlines extracted
    // (best of any model tested), 22/25 category and 21/25 priority
    // agreement with the claude-sonnet-4-5 baseline.
    validated: true,
  },
  openai: {
    adapter: 'openai',
    jsonMode: 'strict',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4.1-mini',
    validated: false,
  },
  gemini: {
    adapter: 'gemini',
    jsonMode: 'strict',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    defaultModel: 'gemini-2.5-flash',
    validated: false,
  },
  deepseek: {
    adapter: 'deepseek',
    jsonMode: 'best-effort',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    validated: false,
  },
  openrouter: {
    adapter: 'openrouter',
    jsonMode: 'best-effort',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    // Deliberately NOT hardcoding a specific free-tier model as the
    // "safe default" here — the Nemotron default already caused one
    // silent quality regression once. OPENROUTER_MODEL must be set
    // explicitly in .env; there's no fallback baked in at this layer.
    defaultModel: null,
    // openRouterClient.js has real testing behind it: the lazy-model-
    // resolution fix (red/green), the 200-with-error-body fix (also
    // red/green, applied and proven 2026-08-12), a per-attempt request
    // timeout, and 27/27 stub assertions plus live JSON- and text-mode
    // calls. Nothing from the audit is outstanding against it.
    validated: true,
  },
};

/**
 * Inputs: name (string) — a key from PROVIDERS.
 * Output: Object — that provider's registry entry.
 * Throws if the name isn't registered, or if it's registered but not
 * yet validated — the hard gate described above. This is the one place
 * in the whole harness that decides whether a provider is real enough
 * to use; every caller goes through this rather than reading PROVIDERS
 * directly.
 */
export function getProviderConfig(name) {
  const config = PROVIDERS[name];
  if (!config) {
    throw new Error(
      `[llmClient] Unknown provider "${name}". Known providers: ${Object.keys(PROVIDERS).join(', ')}.`
    );
  }
  if (!config.validated) {
    throw new Error(
      `[llmClient] Provider "${name}" is registered but not yet validated (see registry.js). ` +
      `Refusing to route a real call to it — flip validated: true only after it has been through ` +
      `live retry/error testing and a real quality pass, the same way openrouter got.`
    );
  }
  return config;
}
