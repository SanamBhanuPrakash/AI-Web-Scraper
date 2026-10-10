import zlib from 'node:zlib';
import { ERROR_CODES, type SummarizeResponse } from '@digest/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, defaultClientIp, type AppDeps } from '../src/app.js';
import { MemoryCache } from '../src/lib/cache.js';
import { loadEnv } from '../src/lib/env.js';
import { AppError } from '../src/lib/errors.js';
import { createLogger } from '../src/lib/logger.js';
import { MemoryRateLimiter } from '../src/lib/ratelimit.js';
import { createMockProvider } from '../src/llm/mock.js';
import type { LlmProvider } from '../src/llm/provider.js';
import { LlmRouter } from '../src/llm/router.js';
import { html, PROSE, startServer, TEST_POLICY, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const site = async (body: string, type = 'text/html; charset=utf-8', status = 200) => {
  const s = await startServer((_r, res) => void res.writeHead(status, { 'content-type': type }).end(body));
  servers.push(s);
  return s;
};
const article = html(`<article><h1>Test article</h1>${PROSE.map((p) => `<p>${p}</p>`).join('')}</article>`, 'Test article');

const logs: string[] = [];
const logger = createLogger('debug', {}, (l) => logs.push(l));
const env = loadEnv({ DIGEST_MOCK_LLM: '1' } as NodeJS.ProcessEnv);

function makeApp(over: Partial<AppDeps> = {}, providers: LlmProvider[] = [createMockProvider()]) {
  return createApp({
    env,
    logger,
    router: new LlmRouter({ providers }),
    policy: TEST_POLICY,
    getClientIp: (c) => c.req.header('x-test-ip') ?? 'ip-1',
    ...over,
  });
}
const post = (app: ReturnType<typeof makeApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/api/summarize', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const parseSse = (text: string) =>
  text
    .split('\n\n')
    .map((b) => b.trim())
    .filter((b) => b && !b.startsWith(':'))
    .map((b) => {
      const lines = b.split('\n');
      return { event: lines.find((l) => l.startsWith('event:'))?.slice(6).trim() ?? '', data: JSON.parse(lines.find((l) => l.startsWith('data:'))!.slice(5)) };
    });

describe('GET endpoints', () => {
  it('health reports configured providers without exposing secrets', async () => {
    const res = await makeApp().request('/api/health');
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, providers: { mock: true, active: ['mock'] } });
    expect(JSON.stringify(j)).not.toMatch(/key|token|secret/i);
  });
  it('openapi documents the endpoint and every error code', async () => {
    const j = (await (await makeApp().request('/api/openapi.json')).json()) as any;
    expect(j.openapi).toMatch(/^3\.1/);
    expect(j.paths['/api/summarize'].post).toBeTruthy();
    expect(j.paths['/api/summarize'].post.responses.default.content['application/json'].schema.properties.error.properties.code.enum.sort()).toEqual(Object.keys(ERROR_CODES).sort());
  });
  it('sets security headers and disables caching on every response', async () => {
    const res = await makeApp().request('/api/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('returns typed 404 and 405', async () => {
    const app = makeApp();
    const nf = await app.request('/nope');
    expect(nf.status).toBe(404);
    expect(((await nf.json()) as any).error.code).toBe('invalid_request');
    const m = await app.request('/api/summarize');
    expect(m.status).toBe(405);
    expect(m.headers.get('allow')).toBe('POST');
  });
});

describe('POST /api/summarize (JSON mode)', () => {
  it('summarizes a page and returns the documented shape', async () => {
    const s = await site(article);
    const res = await post(makeApp(), { url: s.url, length: 'medium', format: 'bullets' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SummarizeResponse;
    expect(body.requestId).toBe(res.headers.get('x-request-id'));
    expect(body.page.title).toBe('Test article');
    expect(body.summary.tldr).toBeTruthy();
    expect(body.summary.points).toHaveLength(5);
    expect(body.summary.points.every((p) => p.grounded && p.quote)).toBe(true);
    expect(body.stats).toMatchObject({ totalPoints: 5, groundedPoints: 5 });
    expect(body.meta).toMatchObject({ provider: 'mock', cached: false, promptVersion: 'v2' });
    expect(body.page.truncated).toBe(false);
  });

  it('applies defaults and honours length/format options', async () => {
    const s = await site(article);
    const short = (await (await post(makeApp(), { url: s.url, length: 'short', format: 'paragraph' })).json()) as SummarizeResponse;
    expect(short.summary.points).toHaveLength(1);
    expect(short.summary.points[0]!.kind).toBe('paragraph');
    const dflt = (await (await post(makeApp(), { url: s.url })).json()) as SummarizeResponse;
    expect(dflt.summary.points).toHaveLength(5);
  });

  it('upgrades a scheme-less URL to https (so an http-only server fails TLS, not validation)', async () => {
    const s = await site(article);
    const res = await post(makeApp(), { url: s.url.replace('http://', '') });
    expect(((await res.json()) as any).error.code).not.toBe('invalid_request');
  });

  it('serves the second identical request from cache', async () => {
    const s = await site(article);
    const app = makeApp({ cache: new MemoryCache() });
    const a = (await (await post(app, { url: s.url })).json()) as SummarizeResponse;
    await s.close(); // site is gone: only the cache can answer now
    const b = (await (await post(app, { url: s.url })).json()) as SummarizeResponse;
    expect(a.meta.cached).toBe(false);
    expect(b.meta.cached).toBe(true);
    expect(b.summary).toEqual(a.summary);
  });

  it('keeps cache entries separate per option', async () => {
    const s = await site(article);
    const app = makeApp({ cache: new MemoryCache() });
    await post(app, { url: s.url, length: 'short' });
    const other = (await (await post(app, { url: s.url, length: 'long' })).json()) as SummarizeResponse;
    expect(other.meta.cached).toBe(false);
    expect(other.summary.points).toHaveLength(8);
  });
});

describe('POST /api/summarize (SSE mode)', () => {
  it('streams phase -> meta -> tldr -> points -> done', async () => {
    const s = await site(article);
    const res = await post(makeApp(), { url: s.url, length: 'short' }, { accept: 'text/event-stream' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(['phase', 'meta', 'tldr', 'point', 'point', 'point', 'done']);
    expect(events[0]!.data).toEqual({ type: 'phase', phase: 'fetching' });
    expect(events[1]!.data.page.title).toBe('Test article');
    expect(events.at(-1)!.data.stats.groundedPoints).toBe(3);
  });

  it('replays cached results as a stream', async () => {
    const s = await site(article);
    const app = makeApp({ cache: new MemoryCache() });
    await (await post(app, { url: s.url }, { accept: 'text/event-stream' })).text();
    const events = parseSse(await (await post(app, { url: s.url }, { accept: 'text/event-stream' })).text());
    expect(events.at(-1)!.data.meta.cached).toBe(true);
    expect(events.map((e) => e.event)).not.toContain('phase');
  });

  it('delivers a mid-flight failure as an error event (HTTP 200 already sent)', async () => {
    const s = await site('<html><body><div id="root"></div><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></body></html>');
    const res = await post(makeApp(), { url: s.url }, { accept: 'text/event-stream' });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.at(-1)).toMatchObject({ event: 'error', data: { type: 'error', error: { code: 'js_rendered', retryable: false } } });
    expect(events.map((e) => e.event)).not.toContain('done');
  });

  it('still returns proper HTTP errors for problems found before streaming starts', async () => {
    const res = await post(makeApp(), { url: 'not a url at all' }, { accept: 'text/event-stream' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('input validation', () => {
  const app = () => makeApp();
  it('rejects wrong content type, malformed JSON and bad schema', async () => {
    const wrongType = await app().request('/api/summarize', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'url=x' });
    expect(wrongType.status).toBe(400);
    expect((await post(app(), '{not json')).status).toBe(400);
    expect((await post(app(), {})).status).toBe(400);
    expect((await post(app(), { url: 123 })).status).toBe(400);
    expect((await post(app(), { url: 'https://example.com', length: 'huge' })).status).toBe(400);
    expect((await post(app(), { url: 'https://example.com', language: 'not a tag!' })).status).toBe(400);
  });
  it('rejects oversized bodies', async () => {
    const res = await post(app(), { url: 'https://example.com/' + 'a'.repeat(6000) });
    expect([400, 413]).toContain(res.status);
  });
  it('never leaks internals in error bodies', async () => {
    const res = await post(app(), { url: 'http://[::1' });
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/stack|at S+:d+|node_modules|ECONN|TypeError/);
  });
  it('blocks private/internal targets in production (strict) mode', async () => {
    const strict = createApp({ env, logger, router: new LlmRouter({ providers: [createMockProvider()] }), getClientIp: () => 'x', rateLimiter: new MemoryRateLimiter(1000) });
    for (const url of ['http://localhost/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.1/', 'file:///etc/passwd', 'http://example.com:22/']) {
      const res = await post(strict, { url });
      expect([400], url).toContain(res.status);
      expect(['blocked_url', 'invalid_request'], url).toContain(((await res.json()) as any).error.code);
    }
  });
  it('refuses to fetch itself (own-host recursion guard)', async () => {
    const res = await post(makeApp(), { url: 'http://digest.example.app/api/summarize' }, { host: 'digest.example.app' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe('blocked_url');
  });
});

describe('error mapping end to end', () => {
  const code = async (res: Response) => ((await res.json()) as any).error;
  it('maps target-site problems', async () => {
    expect(await code(await post(makeApp(), { url: (await site('x', 'text/html', 404)).url }))).toMatchObject({ code: 'not_found' });
    expect(await code(await post(makeApp(), { url: (await site('x', 'text/html', 403)).url }))).toMatchObject({ code: 'blocked_by_site' });
    expect((await post(makeApp(), { url: (await site('%PDF-1.4', 'application/pdf')).url })).status).toBe(415);
    expect(await code(await post(makeApp(), { url: (await site('<html><body><p>tiny</p></body></html>')).url }))).toMatchObject({ code: 'insufficient_content' });
  });
  it('maps oversized and bomb responses', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(40_000_000, 'a'));
    const s = await startServer((_r, res) => void res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(bomb));
    servers.push(s);
    const res = await post(makeApp(), { url: s.url });
    expect(res.status).toBe(413);
    expect((await code(res)).code).toBe('too_large');
  });
  it('maps AI quota exhaustion to 503 with Retry-After', async () => {
    const down: LlmProvider = { ...createMockProvider(), stream: async function* () { throw new AppError('ai_quota_exhausted', { retryAfterSec: 42 }); } };
    const res = await post(makeApp({}, [down]), { url: (await site(article)).url });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('42');
    expect(await code(res)).toMatchObject({ code: 'ai_quota_exhausted', retryable: true, retryAfterSec: 42 });
  });
  it('maps AI outage to 502 and refusal to 422', async () => {
    const mk = (c: 'ai_unavailable' | 'ai_refused'): LlmProvider => ({ ...createMockProvider(), stream: async function* () { throw new AppError(c); } });
    const s = await site(article);
    expect((await post(makeApp({}, [mk('ai_unavailable')]), { url: s.url })).status).toBe(502);
    expect((await post(makeApp({}, [mk('ai_refused')]), { url: s.url })).status).toBe(422);
  });
  it('turns an unexpected crash into a generic 500 without leaking details', async () => {
    const crashing = { providerNames: [], start: async () => { throw new Error('SECRET internal path /srv/app/key=abc'); } } as unknown as LlmRouter;
    const res = await post(createApp({ env, logger, router: crashing, policy: TEST_POLICY, getClientIp: () => 'x' }), { url: (await site(article)).url });
    expect(res.status).toBe(500);
    expect(((await res.clone().json()) as any).error.code).toBe('internal_error');
    expect(JSON.stringify(await res.json())).not.toMatch(/SECRET|srv\/app/);
  });
  it('enforces the whole-request deadline', async () => {
    const hang = await startServer(() => undefined);
    servers.push(hang);
    const res = await post(makeApp({ deadlineMs: 200 }), { url: hang.url });
    expect(res.status).toBe(504);
    expect(((await res.json()) as any).error.code).toBe('request_timeout');
  });
});

describe('rate limiting', () => {
  it('limits per client with Retry-After and rate-limit headers, isolating clients', async () => {
    const s = await site(article);
    const app = makeApp({ rateLimiter: new MemoryRateLimiter(2, 60_000) });
    const r1 = await post(app, { url: s.url }, { 'x-test-ip': 'a' });
    expect(r1.headers.get('x-ratelimit-limit')).toBe('2');
    expect(r1.headers.get('x-ratelimit-remaining')).toBe('1');
    await post(app, { url: s.url }, { 'x-test-ip': 'a' });
    const blocked = await post(app, { url: s.url }, { 'x-test-ip': 'a' });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await blocked.json()) as any).error).toMatchObject({ code: 'rate_limited', retryable: true });
    expect((await post(app, { url: s.url }, { 'x-test-ip': 'b' })).status).toBe(200);
  });
  it('counts invalid requests too (cheap abuse protection runs first)', async () => {
    const app = makeApp({ rateLimiter: new MemoryRateLimiter(1, 60_000) });
    await post(app, {});
    expect((await post(app, {})).status).toBe(429);
  });
  it('MemoryRateLimiter slides, recovers and stays bounded', async () => {
    let now = 0;
    const rl = new MemoryRateLimiter(2, 1000, () => now, 3);
    expect((await rl.check('k')).allowed).toBe(true);
    expect((await rl.check('k')).allowed).toBe(true);
    const denied = await rl.check('k');
    expect(denied).toMatchObject({ allowed: false, retryAfterSec: 1 });
    now = 1001;
    expect((await rl.check('k')).allowed).toBe(true);
    for (let i = 0; i < 50; i++) await rl.check(`spray-${i}`);
    expect((rl as any).hits.size).toBeLessThanOrEqual(3);
  });
  it('defaultClientIp only trusts proxy headers when told to', () => {
    const fake = (h: Record<string, string>) => ({ req: { header: (n: string) => h[n] }, env: {} }) as any;
    expect(defaultClientIp(true)(fake({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
    expect(defaultClientIp(false)(fake({ 'x-forwarded-for': '203.0.113.9' }))).toBe('unknown');
  });
});

describe('cache', () => {
  it('MemoryCache evicts least-recently-used entries and expires by TTL', async () => {
    let now = 0;
    const c = new MemoryCache(2, 1000, () => now);
    await c.set('a', { events: [] });
    await c.set('b', { events: [] });
    await c.get('a'); // a is now most recent
    await c.set('c', { events: [] });
    expect(await c.get('b')).toBeUndefined();
    expect(await c.get('a')).toBeDefined();
    now = 2000;
    expect(await c.get('a')).toBeUndefined();
  });
});

describe('observability', () => {
  it('logs one structured line per request with host only, timings and no content or secrets', async () => {
    logs.length = 0;
    const s = await site(article);
    await post(makeApp(), { url: `${s.url}/some/path?token=SUPERSECRET123` });
    const line = JSON.parse(logs.find((l) => l.includes('"msg":"request"'))!);
    expect(line).toMatchObject({ route: 'summarize', status: 200, host: '127.0.0.1', provider: 'mock', cached: false });
    expect(line.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(line.timingsMs).toHaveProperty('llm');
    const all = logs.join('\n');
    expect(all).not.toContain('SUPERSECRET123');
    expect(all).not.toContain('some/path');
    expect(all).not.toContain('Web scraping is the automated');
  });
  it('logs the error code for failures', async () => {
    logs.length = 0;
    await post(makeApp(), { url: (await site('x', 'text/html', 404)).url });
    expect(JSON.parse(logs.find((l) => l.includes('"msg":"request"'))!)).toMatchObject({ status: 404, errorCode: 'not_found' });
  });
});
