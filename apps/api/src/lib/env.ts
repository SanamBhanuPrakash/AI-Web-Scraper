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
  GEMINI_MODEL: optionalStr,
  GROQ_MODEL: optionalStr,
  LLM_PROVIDER_ORDER: z
    .string()
    .optional()
    .transform((v) => (v ?? 'gemini,groq').split(',').map((s) => s.trim()).filter(Boolean)),
  DIGEST_MOCK_LLM: bool,
  UPSTASH_REDIS_REST_URL: optionalStr,
  UPSTASH_REDIS_REST_TOKEN: optionalStr,
  RATE_LIMIT_PER_MIN: intFrom(6, 1, 600),
  FETCH_TIMEOUT_MS: intFrom(10_000, 1_000, 60_000),
  MAX_HTML_BYTES: intFrom(2_000_000, 50_000, 10_000_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  PORT: intFrom(8787, 1, 65535),
});

export type Env = z.infer<typeof EnvSchema>;

/** Parse and validate process env once at boot. Fails fast with a readable message. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
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
