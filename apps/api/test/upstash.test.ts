import { afterEach, describe, expect, it } from 'vitest';
import { canonicalCacheUrl, cacheKey } from '../src/lib/cache.js';
import { MemoryRateLimiter } from '../src/lib/ratelimit.js';
import {
  FallbackRateLimiter,
  UpstashClient,
  UpstashRateLimiter,
  UpstashSummaryCache,
} from '../src/lib/upstash.js';
import { startServer, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** In-memory fake of the Upstash REST pipeline endpoint (GET/SET/INCR/EXPIRE only). */
async function fakeUpstash(opts: { fail?: boolean; token?: string } = {}) {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const calls: unknown[][] = [];
  const s = await startServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (opts.fail) return void res.writeHead(500).end('boom');
      if (req.headers.authorization !== `Bearer ${opts.token ?? 'tok'}`)
        return void res.writeHead(401).end('{"error":"unauthorized"}');
      const cmds = JSON.parse(body) as Array<Array<string | number>>;
      const out = cmds.map((cmd) => {
        calls.push(cmd);
        const [name, key, ...rest] = cmd as [string, string, ...Array<string | number>];
        if (name === 'GET') return { result: store.get(key)?.value ?? null };
        if (name === 'SET') {
          store.set(key, { value: String(rest[0]) });
          return { result: 'OK' };
        }
        if (name === 'INCR') {
          const next = Number(store.get(key)?.value ?? 0) + 1;
          store.set(key, { value: String(next) });
          return { result: next };
        }
        if (name === 'EXPIRE') return { result: 1 };
        return { error: 'unknown command' };
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  servers.push(s);
  return { server: s, store, calls, client: new UpstashClient(s.url, opts.token ?? 'tok', 500) };
}

describe('UpstashSummaryCache', () => {
  it('round-trips events through gzip+base64 and survives large source text', async () => {
    const { client, store } = await fakeUpstash();
    const cache = new UpstashSummaryCache(client);
    const big = 'lorem ipsum dolor sit amet '.repeat(5000);
    await cache.set('k1', {
      events: [
        { type: 'meta', page: { title: 't' } as never, sourceText: big },
        { type: 'tldr', text: 'hi' },
      ],
    });
    expect(store.get('digest:sum:k1')!.value.length).toBeLessThan(big.length / 4); // compressed
    const got = await cache.get('k1');
    expect(got?.events[0]).toMatchObject({ type: 'meta', sourceText: big });
    expect(await cache.get('missing')).toBeUndefined();
  });

  it('treats any Redis failure as a miss / ignored write (never throws)', async () => {
    const { client } = await fakeUpstash({ fail: true });
    const cache = new UpstashSummaryCache(client);
    await expect(cache.get('x')).resolves.toBeUndefined();
    await expect(cache.set('x', { events: [] })).resolves.toBeUndefined();
  });

  it('treats corrupt cached data as a miss', async () => {
    const { client, store } = await fakeUpstash();
    store.set('digest:sum:bad', { value: 'not-base64-gzip!!' });
    await expect(new UpstashSummaryCache(client).get('bad')).resolves.toBeUndefined();
  });
});

describe('UpstashRateLimiter', () => {
  it('counts per client per window and reports Retry-After to the window end', async () => {
    const { client } = await fakeUpstash();
    const now = Date.UTC(2026, 9, 10, 12, 0, 20); // 20s into a 60s window
    const rl = new UpstashRateLimiter(client, 2, 60, () => now);
    expect(await rl.check('ip-a')).toMatchObject({ allowed: true, remaining: 1 });
    expect(await rl.check('ip-a')).toMatchObject({ allowed: true, remaining: 0 });
    expect(await rl.check('ip-a')).toMatchObject({
      allowed: false,
      remaining: 0,
      retryAfterSec: 40,
    });
    expect((await rl.check('ip-b')).allowed).toBe(true);
  });

  it('starts a fresh count in the next window', async () => {
    const { client } = await fakeUpstash();
    let now = Date.UTC(2026, 9, 10, 12, 0, 59);
    const rl = new UpstashRateLimiter(client, 1, 60, () => now);
    expect((await rl.check('k')).allowed).toBe(true);
    expect((await rl.check('k')).allowed).toBe(false);
    now += 2000;
    expect((await rl.check('k')).allowed).toBe(true);
  });

  it('FallbackRateLimiter uses the local limiter when Redis is down, and still enforces limits', async () => {
    const { client } = await fakeUpstash({ fail: true });
    const rl = new FallbackRateLimiter(new UpstashRateLimiter(client, 5), new MemoryRateLimiter(1));
    expect((await rl.check('k')).allowed).toBe(true);
    expect((await rl.check('k')).allowed).toBe(false); // not fail-open
  });

  it('rejects wrong credentials as an error (which the fallback absorbs)', async () => {
    const { server } = await fakeUpstash({ token: 'right' });
    await expect(new UpstashClient(server.url, 'wrong').command('GET', 'x')).rejects.toThrow(/401/);
  });
});

describe('canonicalCacheUrl / cacheKey', () => {
  const c = (u: string) => canonicalCacheUrl(new URL(u));
  it('drops tracking parameters, fragments, and sorts the rest', () => {
    expect(c('https://example.com/a?utm_source=x&b=2&fbclid=zz&a=1#top')).toBe(
      'https://example.com/a?a=1&b=2',
    );
    expect(c('https://example.com/a?gclid=1')).toBe('https://example.com/a');
  });
  it('keeps meaningful parameters', () => {
    expect(c('https://example.com/watch?v=abc123')).toBe('https://example.com/watch?v=abc123');
    expect(c('https://example.com/?page=2&ref=nav')).toBe('https://example.com/?page=2&ref=nav');
  });
  it('makes tracked and clean links share a cache key, but separates options', () => {
    const a = cacheKey(c('https://example.com/p?utm_campaign=z'), 'medium', 'bullets', undefined);
    const b = cacheKey(c('https://example.com/p'), 'medium', 'bullets', undefined);
    expect(a).toBe(b);
    expect(cacheKey(c('https://example.com/p'), 'short', 'bullets', undefined)).not.toBe(b);
    expect(cacheKey(c('https://example.com/p'), 'medium', 'bullets', 'es')).not.toBe(b);
  });
});
