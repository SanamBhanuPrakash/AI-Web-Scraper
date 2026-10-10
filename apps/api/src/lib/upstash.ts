import { gunzipSync, gzipSync } from 'node:zlib';
import type { Logger } from './logger.js';
import type { CachedSummary, SummaryCache } from './cache.js';
import type { RateLimiter, RateLimitResult } from './ratelimit.js';

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/** Minimal Upstash Redis REST client. Every call has a short deadline: Redis is an optimisation, never a dependency. */
export class UpstashClient {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly timeoutMs = 600,
    private readonly fetchFn: FetchFn = (i, init) => fetch(i, init),
  ) {}

  async pipeline(commands: Array<Array<string | number>>): Promise<unknown[]> {
    const res = await this.fetchFn(`${this.url.replace(/\/$/, '')}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`upstash http ${res.status}`);
    const rows = (await res.json()) as Array<{ result?: unknown; error?: string }>;
    return rows.map((r) => {
      if (r.error) throw new Error('upstash command error');
      return r.result;
    });
  }

  async command(...args: Array<string | number>): Promise<unknown> {
    return (await this.pipeline([args]))[0];
  }
}

/** Shared summary cache. Values are gzip+base64 so a long source text still fits comfortably in one request. */
export class UpstashSummaryCache implements SummaryCache {
  constructor(
    private readonly client: UpstashClient,
    private readonly logger?: Logger,
    private readonly ttlSec = 3600,
    private readonly prefix = 'digest:sum:',
  ) {}

  async get(key: string): Promise<CachedSummary | undefined> {
    try {
      const raw = await this.client.command('GET', this.prefix + key);
      if (typeof raw !== 'string') return undefined;
      return JSON.parse(gunzipSync(Buffer.from(raw, 'base64')).toString('utf8')) as CachedSummary;
    } catch (err) {
      this.logger?.warn('shared cache read failed (treated as miss)', {
        err: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async set(key: string, value: CachedSummary): Promise<void> {
    try {
      const packed = gzipSync(Buffer.from(JSON.stringify(value))).toString('base64');
      await this.client.command('SET', this.prefix + key, packed, 'EX', this.ttlSec);
    } catch (err) {
      this.logger?.warn('shared cache write failed (ignored)', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Fixed-window counter in Redis (INCR + EXPIRE NX). Cheap, atomic, and shared by every serverless
 * instance, which the in-memory limiter cannot be.
 */
export class UpstashRateLimiter implements RateLimiter {
  constructor(
    private readonly client: UpstashClient,
    private readonly limit: number,
    private readonly windowSec = 60,
    private readonly now: () => number = Date.now,
    private readonly prefix = 'digest:rl:',
  ) {}

  async check(key: string): Promise<RateLimitResult> {
    const nowSec = Math.floor(this.now() / 1000);
    const window = Math.floor(nowSec / this.windowSec);
    const redisKey = `${this.prefix}${key}:${window}`;
    const [count] = (await this.client.pipeline([
      ['INCR', redisKey],
      ['EXPIRE', redisKey, this.windowSec * 2, 'NX'],
    ])) as [number, unknown];
    const used = Number(count);
    const retryAfterSec = Math.max(1, (window + 1) * this.windowSec - nowSec);
    return used <= this.limit
      ? {
          allowed: true,
          limit: this.limit,
          remaining: Math.max(0, this.limit - used),
          retryAfterSec: 0,
        }
      : { allowed: false, limit: this.limit, remaining: 0, retryAfterSec };
  }
}

/** Try the primary limiter; if it errors (Redis down/slow) fall back to the per-instance one. Never fail open. */
export class FallbackRateLimiter implements RateLimiter {
  constructor(
    private readonly primary: RateLimiter,
    private readonly fallback: RateLimiter,
    private readonly logger?: Logger,
  ) {}

  async check(key: string): Promise<RateLimitResult> {
    try {
      return await this.primary.check(key);
    } catch (err) {
      this.logger?.warn('shared rate limiter unavailable, using local fallback', {
        err: err instanceof Error ? err.message : String(err),
      });
      return this.fallback.check(key);
    }
  }
}
