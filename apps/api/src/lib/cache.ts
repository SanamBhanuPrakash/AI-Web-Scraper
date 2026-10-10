import { createHash } from 'node:crypto';
import type { SummaryStreamEvent } from '../shared.js';
import { PROMPT_VERSION } from '../llm/prompt.js';

/** A finished, successful summarization stored as the exact event sequence to replay. */
export interface CachedSummary {
  events: SummaryStreamEvent[];
}

export interface SummaryCache {
  get(key: string): Promise<CachedSummary | undefined>;
  set(key: string, value: CachedSummary): Promise<void>;
}

const TRACKING_PARAM =
  /^(utm_[a-z0-9_]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|twclid|ttclid|_hsenc|_hsmi|mkt_tok|ref_src|vero_id)$/i;

/**
 * Canonical form of a URL for CACHE KEYS ONLY (the fetched URL is left untouched): drops well-known
 * tracking parameters and sorts the rest, so `?utm_source=x` and the clean link share one entry.
 */
export function canonicalCacheUrl(url: URL): string {
  const u = new URL(url.toString());
  u.hash = '';
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAM.test(k));
  kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  return u.toString();
}

/** Key excludes anything user-specific, so one user's request can warm the cache for everyone. */
export function cacheKey(
  url: string,
  length: string,
  format: string,
  language: string | undefined,
): string {
  return createHash('sha256')
    .update([url, length, format, language ?? '', PROMPT_VERSION].join('\u0000'))
    .digest('hex');
}

/** Per-instance LRU with TTL. On serverless each instance has its own; Upstash can replace it (plan §8). */
export class MemoryCache implements SummaryCache {
  private readonly map = new Map<string, { value: CachedSummary; expires: number }>();
  constructor(
    private readonly maxEntries = 100,
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<CachedSummary | undefined> {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key); // refresh recency
    this.map.set(key, hit);
    return hit.value;
  }

  async set(key: string, value: CachedSummary): Promise<void> {
    this.map.delete(key);
    this.map.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
