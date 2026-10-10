import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/lib/env.js';
import { AppError } from '../src/lib/errors.js';
import { createLogger } from '../src/lib/logger.js';
import { MemoryRateLimiter } from '../src/lib/ratelimit.js';
import { createMockProvider } from '../src/llm/mock.js';
import { LlmRouter } from '../src/llm/router.js';
import { filterThinking } from '../src/llm/think-filter.js';
import {
  assertReadableSite,
  classifyThinPage,
  findMetaRefresh,
} from '../src/pipeline/page-quality.js';
import { createSafeFetcher } from '../src/pipeline/safe-fetch.js';
import { scrapePage } from '../src/pipeline/scrape.js';
import { parseTargetUrl, STRICT_POLICY } from '../src/pipeline/validate-url.js';
import { html, PROSE, startServer, TEST_POLICY, type TestServer } from './helpers.js';

const BS = String.fromCharCode(92); // a backslash, without relying on escape handling
const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const serve = async (handler: Parameters<typeof startServer>[0]) => {
  const s = await startServer(handler);
  servers.push(s);
  return s;
};
const send =
  (
    body: string,
    type = 'text/html; charset=utf-8',
    status = 200,
  ): Parameters<typeof startServer>[0] =>
  (_req, res) =>
    void res.writeHead(status, { 'content-type': type }).end(body);
const deps = { fetcher: createSafeFetcher({ policy: TEST_POLICY }) };
const opts = { maxInputChars: 50_000 };
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof AppError ? e.code : `non-app:${(e as Error).message}`;
  }
};

const article = (title: string, paras = PROSE) =>
  html(`<article><h1>${title}</h1>${paras.map((p) => `<p>${p}</p>`).join('')}</article>`, title);

describe('pages that return 200 but are not the page you asked for', () => {
  it('bot challenge (Cloudflare style)', async () => {
    const s = await serve(
      send(
        html(
          '<h1>Checking your browser</h1><p>Enable JavaScript and cookies to continue</p>',
          'Just a moment...',
        ),
      ),
    );
    expect(await codeOf(scrapePage(s.url, deps, opts))).toBe('blocked_by_site');
  });

  it('cookie / consent wall', async () => {
    const s = await serve(
      send(
        html(
          '<div><h1>Before you continue</h1><p>We value your privacy. We and our partners use cookies to store and access information on your device. Accept all cookies or manage preferences to decide what happens next before you can continue to the site and read anything at all.</p><button>Accept all cookies</button></div>',
          'Privacy settings',
        ),
      ),
    );
    expect(await codeOf(scrapePage(s.url, deps, opts))).toBe('access_wall');
  });

  it('sign-in wall', async () => {
    const s = await serve(
      send(
        html(
          '<article><h1>Premium analysis</h1><p>Sign in to continue reading this article. Already a subscriber? Log in to view the full story and the rest of this analysis, then come back to continue where you stopped reading before.</p></article>',
          'Premium analysis',
        ),
      ),
    );
    expect(await codeOf(scrapePage(s.url, deps, opts))).toBe('access_wall');
  });

  it('soft 404 (a "not found" page served with status 200)', async () => {
    const s = await serve(
      send(
        html(
          '<main><h1>Page not found</h1><p>Sorry, we could not find the page you were looking for. It may have been moved or deleted, so try the search box, the home page, or the site map to locate what you wanted instead of this missing page.</p></main>',
          '404 - Page not found',
        ),
      ),
    );
    expect(await codeOf(scrapePage(s.url, deps, opts))).toBe('not_found');
  });

  it('does not flag a long real article that merely mentions cookies or sign-in', () => {
    const long = Array.from({ length: 60 }, () => PROSE[0]).join(' ');
    expect(
      classifyThinPage(
        'How we use cookies in our app',
        `We use cookies. Sign in to continue. ${long}`,
        700,
      ),
    ).toBeUndefined();
    expect(
      classifyThinPage(
        'Guide',
        `Enable JavaScript and cookies to continue is a message you may see. ${long}`,
        700,
      ),
    ).toBeUndefined();
  });

  it('classifier unit cases', () => {
    expect(classifyThinPage('Attention Required! | Cloudflare', 'x', 5)).toBe('blocked_by_site');
    expect(classifyThinPage('Attention Required! | Cloudflare', 'x', 5000)).toBe('blocked_by_site'); // title alone is decisive
    expect(
      classifyThinPage('Recipes', 'Delicious pasta for everyone to cook at home tonight.', 9),
    ).toBeUndefined();
    expect(classifyThinPage('Oops', '404. That page cannot be found.', 6)).toBe('not_found');
  });
});

describe('meta refresh interstitials', () => {
  it('follows ONE meta refresh from a near-empty page and summarizes the real page', async () => {
    const real = await serve(send(article('The real destination')));
    const hop = await serve(
      send(
        `<html><head><meta http-equiv="refresh" content="0; url=${real.url}/done"></head><body>Redirecting</body></html>`,
      ),
    );
    const r = await scrapePage(hop.url, deps, opts);
    expect(r.page.title).toBe('The real destination');
  });

  it('accepts the quoted and un-prefixed variants, and ignores long delays', () => {
    const base = new URL('https://example.com/a/b');
    const h = (c: string) => `<html><head><meta http-equiv="refresh" content="${c}"></head></html>`;
    expect(findMetaRefresh(h('0;url=/x'), base)?.toString()).toBe('https://example.com/x');
    expect(findMetaRefresh(h("2; URL='https://other.test/p'"), base)?.toString()).toBe(
      'https://other.test/p',
    );
    expect(findMetaRefresh(h('30; url=/slow'), base)).toBeUndefined();
    expect(findMetaRefresh('<html><head></head></html>', base)).toBeUndefined();
  });

  it('cannot be abused to reach private addresses (the target goes through the same validation)', async () => {
    const hop = await serve(
      send(
        '<html><head><meta http-equiv="refresh" content="0; url=http://169.254.169.254/latest/meta-data/"></head><body>Redirecting</body></html>',
      ),
    );
    expect(await codeOf(scrapePage(hop.url, deps, opts))).toBe('blocked_url');
  });

  it('does not chase refresh on a normal page, and follows at most one hop', async () => {
    let hits = 0;
    const loop = await serve((req, res) => {
      hits++;
      res
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          `<html><head><meta http-equiv="refresh" content="0; url=http://127.0.0.1:${req.socket.localPort}/again"></head><body>hop</body></html>`,
        );
    });
    await codeOf(scrapePage(loop.url, deps, opts));
    expect(hits).toBe(2); // the original request and exactly one refresh, never a loop
  });
});

describe('sites that cannot be read are refused before any request', () => {
  it.each([
    'https://www.youtube.com/watch?v=abc',
    'https://youtu.be/abc',
    'https://x.com/someone/status/1',
    'https://twitter.com/a',
    'https://www.instagram.com/p/x/',
    'https://m.youtube.com/',
  ])('%s', async (u) => {
    const fetcher = vi.fn();
    expect(await codeOf(scrapePage(u, { fetcher } as never, opts))).toBe('access_wall');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('matches subdomains but not look-alike hosts', () => {
    expect(() => assertReadableSite(new URL('https://music.youtube.com/'))).toThrow(AppError);
    expect(() => assertReadableSite(new URL('https://notyoutube.com/'))).not.toThrow();
    expect(() => assertReadableSite(new URL('https://youtube.com.example.org/'))).not.toThrow();
  });

  it('returns a specific, safe message through the API', async () => {
    const env = loadEnv({ DIGEST_MOCK_LLM: '1' } as NodeJS.ProcessEnv);
    const app = createApp({
      env,
      logger: createLogger('error', {}, () => undefined),
      router: new LlmRouter({ providers: [createMockProvider()] }),
      rateLimiter: new MemoryRateLimiter(100),
      getClientIp: () => 'x',
    });
    const res = await app.request('/api/summarize', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=abc' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('access_wall');
    expect(body.error.message).toMatch(/Video pages have no article text/);
  });
});

describe('think-block filtering for reasoning models', () => {
  const run = async (chunks: string[]) => {
    async function* src() {
      for (const c of chunks) yield c;
    }
    let out = '';
    for await (const c of filterThinking(src())) out += c;
    return out;
  };
  it('passes normal text through untouched', async () => {
    expect(await run(['TLDR: hello\n', 'POINT: world'])).toBe('TLDR: hello\nPOINT: world');
  });
  it('removes a think block, including when tags are split across chunks', async () => {
    const full = '<think>secret reasoning with page text</think>TLDR: ok\n';
    expect(await run([full])).toBe('TLDR: ok\n');
    for (let cut = 1; cut < full.length; cut++)
      expect(await run([full.slice(0, cut), full.slice(cut)])).toBe('TLDR: ok\n');
    expect(await run(full.split(''))).toBe('TLDR: ok\n');
  });
  it('drops an unterminated think block and keeps look-alike tags', async () => {
    expect(await run(['TLDR: a\n<think>never closed'])).toBe('TLDR: a\n');
    expect(await run(['a <thinking about it> b <thin'])).toBe('a <thinking about it> b <thin');
  });
  it('handles multiple blocks', async () => {
    expect(await run(['<think>a</think>X<think>b</think>Y'])).toBe('XY');
  });
});

describe('SSRF: URL parser differentials (validator and fetcher must agree on the host)', () => {
  const host = (s: string) => parseTargetUrl(s, STRICT_POLICY).hostname;
  const blocks = (s: string) => {
    try {
      parseTargetUrl(s, STRICT_POLICY);
      return false;
    } catch (e) {
      return e instanceof AppError;
    }
  };

  it('backslash tricks resolve to ONE host, the one we validate and the one we connect to', () => {
    // WHATWG treats a backslash like a slash in http URLs, so these have host example.com, not 127.0.0.1.
    expect(host(`http://example.com${BS}@127.0.0.1/`)).toBe('example.com');
    expect(host(`http://example.com${BS}.127.0.0.1/`)).toBe('example.com');
    // And when the real host is private, they are blocked.
    expect(blocks(`http://127.0.0.1${BS}@example.com/`)).toBe(true);
    expect(blocks(`http://localhost${BS}.example.com/`)).toBe(true);
  });

  it('userinfo and fragment tricks cannot smuggle a second host', () => {
    expect(blocks('http://example.com@127.0.0.1/')).toBe(true); // credentials rejected outright
    expect(host('http://example.com#@127.0.0.1/')).toBe('example.com');
    expect(host('http://example.com?@127.0.0.1/')).toBe('example.com');
  });

  it('Unicode look-alike digits and dots are normalized to the real IP, then blocked', () => {
    expect(blocks('http://１２７.0.0.1/')).toBe(true); // fullwidth 127
    expect(blocks('http://127。0。0。1/')).toBe(true); // ideographic full stops
    expect(blocks('http://①②⑦.0.0.1/')).toBe(true); // circled digits (may be invalid, never allowed)
  });

  it('IPv4 shorthand, octal, hex and mixed forms', () => {
    for (const u of [
      'http://127.1/',
      'http://0x7f.1/',
      'http://0177.1/',
      'http://2130706433/',
      'http://0x7f000001/',
      'http://017700000001/',
      'http://127.0.1/',
      'http://[::ffff:7f00:1]/',
      'http://[0:0:0:0:0:ffff:127.0.0.1]/',
    ]) {
      expect(blocks(u), u).toBe(true);
    }
  });

  it('percent-encoded and control-character hosts are rejected', () => {
    for (const u of [
      'http://127.0.0.1%00.example.com/',
      'http://exam%0aple.com/',
      'http://example.com%2f@127.0.0.1/',
      'http://%31%32%37.0.0.1/',
    ]) {
      expect(blocks(u), u).toBe(true);
    }
  });

  it('trailing-dot and case variants of private names are blocked', () => {
    for (const u of [
      'http://LOCALHOST./',
      'http://localhost.localdomain/',
      'http://LocalHost/',
      'http://foo.local./',
    ])
      expect(blocks(u), u).toBe(true);
  });

  it('property: whatever is accepted never has a blocked-IP host', async () => {
    const fc = await import('fast-check');
    const { isBlockedIp } = await import('../src/pipeline/ip-policy.js');
    const { isIP } = await import('node:net');
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        try {
          const u = parseTargetUrl(`http://${s}`, STRICT_POLICY);
          const h = u.hostname.replace(/^\[|\]$/g, '');
          if (isIP(h) !== 0) expect(isBlockedIp(h)).toBe(false);
        } catch (e) {
          expect(e).toBeInstanceOf(AppError);
        }
      }),
      { numRuns: 5000 },
    );
  });
});
