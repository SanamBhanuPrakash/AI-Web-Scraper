import type { Env } from '../lib/env.js';
import type { Logger } from '../lib/logger.js';
import { createGeminiProvider } from './gemini.js';
import { createGroqProvider } from './groq.js';
import { createMockProvider } from './mock.js';
import type { LlmProvider } from './provider.js';
import { LlmRouter } from './router.js';

/** Providers in configured fallback order. Providers without a key are skipped, so one key is enough. */
export function buildProviders(env: Env): LlmProvider[] {
  if (env.DIGEST_MOCK_LLM) return [createMockProvider({ delayMs: 15 })];
  const providers: LlmProvider[] = [];
  for (const name of env.LLM_PROVIDER_ORDER) {
    if (name === 'gemini' && env.GEMINI_API_KEY) {
      providers.push(
        createGeminiProvider({
          apiKey: env.GEMINI_API_KEY,
          model: env.GEMINI_MODEL,
          maxInputChars: env.GEMINI_MAX_INPUT_CHARS,
        }),
      );
    } else if (name === 'groq' && env.GROQ_API_KEY) {
      providers.push(
        createGroqProvider({
          apiKey: env.GROQ_API_KEY,
          model: env.GROQ_MODEL,
          maxInputChars: env.GROQ_MAX_INPUT_CHARS,
        }),
      );
    }
  }
  return providers;
}

export function buildRouter(env: Env, logger: Logger): LlmRouter {
  return new LlmRouter({
    providers: buildProviders(env),
    firstTokenTimeoutMs: env.FIRST_TOKEN_TIMEOUT_MS,
    totalTimeoutMs: env.LLM_TOTAL_TIMEOUT_MS,
    routing: env.LLM_ROUTING,
    logger,
  });
}
