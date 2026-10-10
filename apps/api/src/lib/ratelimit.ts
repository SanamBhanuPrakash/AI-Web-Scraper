export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSec: number;
}

export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
}

/**
 * Sliding-window-log limiter held in memory. On serverless this is BEST-EFFORT (each instance keeps
 * its own counters), which is documented in the plan; a shared Upstash-backed limiter implements the
 * same interface for strict global limits.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 5_000,
  ) {}

  async check(key: string): Promise<RateLimitResult> {
    const t = this.now();
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      const retryAfterSec = Math.max(1, Math.ceil((recent[0]! + this.windowMs - t) / 1000));
      return { allowed: false, limit: this.limit, remaining: 0, retryAfterSec };
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(t);
    return { allowed: true, limit: this.limit, remaining: this.limit - recent.length, retryAfterSec: 0 };
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) {
      if (v.length === 0 || t - v[v.length - 1]! >= this.windowMs) this.hits.delete(k);
    }
    // Still too big (many active keys): drop the oldest entries so memory stays bounded.
    while (this.hits.size > this.maxKeys) {
      const first = this.hits.keys().next().value as string | undefined;
      if (first === undefined) break;
      this.hits.delete(first);
    }
  }
}
