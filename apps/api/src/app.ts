import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { SummaryCache } from './lib/cache.js';
import type { Env } from './lib/env.js';
import { AppError, toApiError } from './lib/errors.js';
import type { Logger } from './lib/logger.js';
import { buildInfra } from './lib/infra.js';
import type { RateLimiter } from './lib/ratelimit.js';
import type { LlmRouter } from './llm/router.js';
import { buildOpenApi } from './openapi.js';
import { expandIPv6 } from './pipeline/ip-policy.js';
import { createSafeFetcher, type SafeFetcher } from './pipeline/safe-fetch.js';
import { STRICT_POLICY, type UrlPolicy } from './pipeline/validate-url.js';
import { createSummarizeHandler, type AppVars } from './routes/summarize.js';

export const API_VERSION = '0.1.0';

export interface AppDeps {
  env: Env;
  logger: Logger;
  router: LlmRouter;
  cache?: SummaryCache;
  rateLimiter?: RateLimiter;
  /** Defaults to the strict production policy. Tests may pass a permissive one (ADR-015). */
  policy?: UrlPolicy;
  makeFetcher?: (policy: UrlPolicy) => SafeFetcher;
  getClientIp?: (c: Context<AppVars>) => string;
  deadlineMs?: number;
}

/**
 * Proxy headers are only trustworthy when a known proxy (Vercel's edge) sets them. Elsewhere a client
 * could forge X-Forwarded-For to dodge the rate limiter, so we use the socket address instead.
 */
export function defaultClientIp(trustProxy: boolean) {
  return (c: Context<AppVars>): string => {
    if (trustProxy) {
      const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      const real = c.req.header('x-real-ip')?.trim();
      // Capped: this string becomes a Redis key and a log field, so it must not be attacker-sized.
      if (xff || real) return limiterKey((xff || real)!.slice(0, 64));
    }
    try {
      return limiterKey(getConnInfo(c).remote.address ?? 'unknown');
    } catch {
      return 'unknown'; // non-Node runtime without conn info
    }
  };
}

/**
 * One home or office gets a whole IPv6 /64, so keying on the full address would let a single client mint
 * unlimited fresh limiter buckets. IPv6 clients are therefore keyed on their /64 prefix; IPv4 is unchanged.
 */
export function limiterKey(ip: string): string {
  if (!ip.includes(':')) return ip;
  const groups = expandIPv6(ip);
  if (!groups) return ip;
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`; // IPv4-mapped
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`;
}

/** Web-standard Hono app: runs unchanged on Vercel, Node, or any fetch-compatible runtime. */
export function createApp(deps: AppDeps) {
  const { env, logger } = deps;
  const app = new Hono<AppVars>();
  const infra = buildInfra(env, logger);

  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.use(
    '/api/summarize',
    bodyLimit({
      maxSize: 4096,
      onError: (c) =>
        c.json(
          {
            requestId: c.get('requestId'),
            error: {
              code: 'invalid_request' as const,
              message: "That doesn't look like a valid web address.",
              retryable: false,
            },
          },
          413,
        ),
    }),
  );

  app.post(
    '/api/summarize',
    createSummarizeHandler({
      env,
      logger,
      router: deps.router,
      cache: deps.cache ?? infra.cache,
      rateLimiter: deps.rateLimiter ?? infra.rateLimiter,
      policy: deps.policy ?? STRICT_POLICY,
      makeFetcher:
        deps.makeFetcher ??
        ((policy) =>
          createSafeFetcher({
            timeoutMs: env.FETCH_TIMEOUT_MS,
            maxBytes: env.MAX_HTML_BYTES,
            policy,
          })),
      getClientIp: deps.getClientIp ?? defaultClientIp(env.TRUST_PROXY),
      ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    }),
  );

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      version: API_VERSION,
      providers: {
        gemini: Boolean(env.GEMINI_API_KEY),
        groq: Boolean(env.GROQ_API_KEY),
        mock: env.DIGEST_MOCK_LLM,
        active: deps.router.providerNames,
      },
      sharedStore: infra.shared,
    }),
  );

  app.get('/api/openapi.json', (c) => c.json(buildOpenApi(API_VERSION)));

  app.all('/api/summarize', (c) => {
    const { body } = toApiError(new AppError('invalid_request'), c.get('requestId'));
    c.header('Allow', 'POST');
    return c.json(body, 405);
  });

  app.notFound((c) =>
    c.json(
      {
        requestId: c.get('requestId'),
        error: { code: 'invalid_request' as const, message: 'Not found.', retryable: false },
      },
      404,
    ),
  );

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? 'unknown';
    const { status, body } = toApiError(err, requestId);
    logger.error('unhandled', {
      requestId,
      errorCode: body.error.code,
      err: err instanceof Error ? err.message : String(err),
    });
    return c.json(body, status as 500);
  });

  return app;
}
