import { MemoryCache, type SummaryCache } from './cache.js';
import type { Env } from './env.js';
import type { Logger } from './logger.js';
import { MemoryRateLimiter, type RateLimiter } from './ratelimit.js';
import {
  FallbackRateLimiter,
  UpstashClient,
  UpstashRateLimiter,
  UpstashSummaryCache,
} from './upstash.js';

/**
 * Cache + rate limiter for this deployment. With Upstash credentials they are shared across all
 * serverless instances; without, they are per-instance (best effort) and everything still works.
 */
export function buildInfra(
  env: Env,
  logger: Logger,
): { cache: SummaryCache; rateLimiter: RateLimiter; shared: boolean } {
  const local = new MemoryRateLimiter(env.RATE_LIMIT_PER_MIN);
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    const client = new UpstashClient(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
    return {
      shared: true,
      cache: new UpstashSummaryCache(client, logger),
      rateLimiter: new FallbackRateLimiter(
        new UpstashRateLimiter(client, env.RATE_LIMIT_PER_MIN),
        local,
        logger,
      ),
    };
  }
  return { shared: false, cache: new MemoryCache(), rateLimiter: local };
}
