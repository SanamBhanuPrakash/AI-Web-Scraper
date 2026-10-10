import { z } from 'zod';

const bool = z
  .enum(['0', '1', 'true', 'false', ''])
  .default('0')
  .transform((v) => v === '1' || v === 'true');
const intFrom = (def: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min).max(max));
const optionalStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const EnvSchema = z.object({
  GEMINI_API_KEY: optionalStr,
  GROQ_API_KEY: optionalStr,
  // Defaults verified against the live APIs on 2026-10-10 (gemini-2.5-* is closed to new users;
  // gpt-oss models burn their token budget on hidden reasoning). Override via env as models change.
  GEMINI_MODEL: optionalStr.transform((v) => v ?? 'gemini-3.5-flash-lite'),
  GROQ_MODEL: optionalStr.transform((v) => v ?? 'qwen/qwen3.8-27b'),
  GEMINI_MAX_INPUT_CHARS: intFrom(150_000, 2_000, 400_000),
  // Groq free tier allows ~8k tokens/minute, so keep its prompt small.
  GROQ_MAX_INPUT_CHARS: intFrom(14_000, 2_000, 400_000),
  FIRST_TOKEN_TIMEOUT_MS: intFrom(5_000, 1_000, 60_000),
  LLM_TOTAL_TIMEOUT_MS: intFrom(30_000, 5_000, 120_000),
  LLM_PROVIDER_ORDER: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? 'gemini,groq')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  LLM_ROUTING: z.enum(['size-aware', 'ordered']).default('size-aware'),
  DIGEST_MOCK_LLM: bool,
  UPSTASH_REDIS_REST_URL: optionalStr,
  UPSTASH_REDIS_REST_TOKEN: optionalStr,
  RATE_LIMIT_PER_MIN: intFrom(6, 1, 600),
  FETCH_TIMEOUT_MS: intFrom(10_000, 1_000, 60_000),
  MAX_HTML_BYTES: intFrom(2_000_000, 50_000, 10_000_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: intFrom(8787, 1, 65535),
  // Trust X-Forwarded-For only behind a known proxy. Vercel sets VERCEL=1 automatically.
  TRUST_PROXY: z
    .string()
    .optional()
    .transform((v, ctx) =>
      v === undefined || v === ''
        ? undefined
        : v === '1' || v === 'true'
          ? true
          : v === '0' || v === 'false'
            ? false
            : (ctx.addIssue({ code: 'custom', message: 'expected 0/1' }), z.NEVER),
    ),
});

export type Env = Omit<z.infer<typeof EnvSchema>, 'TRUST_PROXY'> & { TRUST_PROXY: boolean };

/** Parse and validate process env once at boot. Fails fast with a readable message. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return { ...parsed.data, TRUST_PROXY: parsed.data.TRUST_PROXY ?? Boolean(source['VERCEL']) };
}

/** At least one LLM path must be usable, otherwise the service cannot do its job. */
export function assertLlmConfigured(env: Env): void {
  if (env.DIGEST_MOCK_LLM) return;
  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) {
    throw new Error(
      'No AI provider configured. Set GEMINI_API_KEY and/or GROQ_API_KEY in .env (see .env.example), or set DIGEST_MOCK_LLM=1 for offline demo mode.',
    );
  }
}
