/**
 * llmClient/index.js
 *
 * The one interface every caller (emailPriority.js, askInbox.js,
 * draftReply.js, formatDigest.js, and any future one) should import
 * from — nothing outside this file should import a specific adapter
 * directly. Provider selection is STATIC per deployment: LLM_PROVIDER
 * is set once in .env; this does not auto-switch or auto-failover
 * mid-run. That's a deliberate project decision, not an oversight —
 * live/automatic routing was explicitly ruled out in favor of a config
 * value that's set and updated by hand.
 *
 * DEFAULT PROVIDER: LLM_PROVIDER unset resolves to 'anthropic'. This
 * used to throw instead, which was correct while nothing imported this
 * file — an unset value meant "nobody has chosen yet". Now that all four
 * pipeline callers route through here, a throw would mean an unset var
 * takes the whole pipeline down, so it defaults instead. Be aware of what
 * the default costs: 'anthropic' is a paid API, and a deployment that
 * never sets LLM_PROVIDER will bill Anthropic on every run. Set
 * LLM_PROVIDER=openrouter to route to the free tier instead.
 *
 * ENV READ TIMING: LLM_PROVIDER is read lazily, inside callLLM(), not
 * at module load. Every entry point in this codebase is ESM, where
 * import statements are hoisted above dotenv.config() regardless of
 * textual order — a module-load-time env read here would silently
 * ignore .env on every single run. This exact bug already happened
 * once, in openRouterClient.js's original model-resolution logic, and
 * was fixed there. Do not reintroduce the same class of bug here.
 */
import { getProviderConfig } from './registry.js';
import { callAnthropic } from './adapters/anthropic.js';
import { callOpenAI } from './adapters/openai.js';
import { callGemini } from './adapters/gemini.js';
import { callDeepSeek } from './adapters/deepseek.js';
import { callOpenRouter } from './adapters/openrouter.js';

const ADAPTERS = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  gemini: callGemini,
  deepseek: callDeepSeek,
  openrouter: callOpenRouter,
};

// Used when LLM_PROVIDER is unset. Deliberately a paid provider — see the
// DEFAULT PROVIDER note in the header for why, and for what it costs.
const DEFAULT_PROVIDER = 'anthropic';

/**
 * Inputs:
 *   systemPrompt (string), userContent (string).
 *   options (Object, optional):
 *     jsonMode   — false requests plain prose instead of JSON (used by
 *                  askInbox/draftReply/formatDigest-style callers).
 *                  Omitted or anything else means "I want JSON."
 *     jsonSchema — a JSON Schema object. Providers registered as
 *                  jsonMode: 'strict' (anthropic, openai, gemini) use
 *                  this for real shape enforcement when supplied.
 *                  Providers registered as 'best-effort' (deepseek,
 *                  openrouter) ignore it — they have no mechanism to
 *                  honor it, and pretending otherwise would misstate
 *                  what they can actually guarantee.
 *     model, maxTokens, logLabel — passed through to whichever adapter
 *                  is selected.
 * Output: Promise<string> — the raw text response, uniformly across
 * every provider. Never a parsed object — callers that expect JSON
 * still JSON.parse() it themselves, exactly as before this harness
 * existed.
 * What it does: resolves the configured provider from LLM_PROVIDER
 * (falling back to DEFAULT_PROVIDER when unset), refuses to proceed if
 * that provider isn't marked validated in the registry, and dispatches to
 * its adapter.
 */
export async function callLLM(systemPrompt, userContent, options = {}) {
  const providerName = process.env.LLM_PROVIDER || DEFAULT_PROVIDER;

  // Throws if unknown OR not yet validated — see registry.js. A
  // provider only becomes selectable once it's earned it, not just
  // because it's wired up here.
  const config = getProviderConfig(providerName);

  const adapterFn = ADAPTERS[config.adapter];
  return adapterFn(systemPrompt, userContent, options);
}
