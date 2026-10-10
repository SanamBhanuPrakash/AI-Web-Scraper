import zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { createSafeFetcher, decompressCapped } from '../src/pipeline/safe-fetch.js';
import { html, startServer, TEST_POLICY, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
const serve = async (...args: Parameters<typeof startServer>) => {
  const s = await startServer(...args);
  servers.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const fetcher = (cfg: Parameters<typeof createSafeFetcher>[0] = {}) =>
  createSafeFetcher({ policy: TEST_POLICY, ...cfg });
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
};

describe('safeFetch: happy paths', () => {
  it('fetches an HTML page', async () => {
    const s = await serve((_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html('<p>Hello</p>'));
    });
    const page = await fetcher()(s.url + '/a');
    expect(page.status).toBe(200);
    expect(page.mime).toBe('text/html');
    expect(page.body.toString()).toContain('<p>Hello</p>');
    expect(page.redirects).toBe(0);
  });

  it('follows relative and absolute redirects and reports the final URL', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/a') return void res.writeHead(302, { location: '/b' }).end();
      if (req.url === '/b')
        return void res
          .writeHead(301, { location: `http://127.0.0.1:${req.socket.localPort}/c` })
          .end();
      res.setHeader('content-type', 'text/html').end(html('<p>done</p>'));
    });
    const page = await fetcher()(s.url + '/a');
    expect(page.finalUrl.pathname).toBe('/c');
    expect(page.redirects).toBe(2);
  });

  it('transparently decodes gzip and brotli', async () => {
    const body = html('<p>compressed</p>');
    const s = await serve((req, res) => {
      const enc = req.url === '/br' ? 'br' : 'gzip';
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': enc });
      res.end(enc === 'br' ? zlib.brotliCompressSync(body) : zlib.gzipSync(body));
    });
    expect((await fetcher()(s.url + '/gz')).body.toString()).toContain('compressed');
    expect((await fetcher()(s.url + '/br')).body.toString()).toContain('compressed');
  });

  it('accepts text/plain and sniffs HTML when content-type is missing', async () => {
    const s = await serve((req, res) => {
      if (req.url === '/txt')
        return void res.setHeader('content-type', 'text/plain').end('just text');
      res.removeHeader('content-type');
      res.end(html('<p>sniffed</p>'));
    });
    expect((await fetcher()(s.url + '/txt')).mime).toBe('text/plain');
    expect((await fetcher()(s.url + '/x')).mime).toBe('text/html');
  });

  it('connects through the guarded resolver to the pinned address', async () => {
    const s = await serve((_req, res) =>
      res.setHeader('content-type', 'text/html').end(html('<p>pinned</p>')),
    );
    const f = fetcher({ resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
    expect((await f(`http://app.test:${s.port}/`)).body.toString()).toContain('pinned');
  });
});

describe('safeFetch: SSRF attacks', () => {
  it('blocks a redirect to the cloud metadata address', async () => {
    const s = await serve(
      (_req, res) =>
        void res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end(),
    );
    expect(await codeOf(fetcher()(s.url))).toBe('blocked_url');
  });

  it.each(
    [
      'http://10.0.0.5/',
      'http://[::1]/',
      'http://192.168.1.1:80/',
      'ftp://example.com/',
      'file:///etc/passwd',
      'http://167772165/',
    ] /* decimal form of 10.0.0.5 */,
  )('blocks a redirect to %s', async (target) => {
    const s = await serve((_req, res) => void res.writeHead(302, { location: target }).end());
    expect(['blocked_url']).toContain(await codeOf(fetcher()(s.url)));
  });

  it('blocks a hostname that resolves to a private address (and never connects)', async () => {
    let connections = 0;
    const s = await serve((_req, res) => {
      connections++;
      res.end('secret');
    });
    const f = fetcher({ resolver: async () => [{ address: '10.0.0.5', family: 4 }] });
    expect(await codeOf(f(`http://internal-looking.test:${s.port}/`))).toBe('blocked_url');
    expect(connections).toBe(0);
  });

  it('blocks DNS rebinding: first answer public-looking, later answer private', async () => {
    const s = await serve((_req, res) =>
      res.setHeader('content-type', 'text/html').end(html('<p>x</p>')),
    );
    let n = 0;
    // Hop 1 resolves to loopback (allowed in TEST_POLICY); the redirect target then resolves to private space.
    const f = fetcher({
      resolver: async () => [{ address: n++ === 0 ? '127.0.0.1' : '10.9.9.9', family: 4 }],
    });
    const redirector = await serve(
      (_req, res) => void res.writeHead(302, { location: `http://second.test:${s.port}/` }).end(),
    );
    expect(await codeOf(f(`http://first.test:${redirector.port}/`))).toBe('blocked_url');
  });

  it('refuses unbounded redirect chains', async () => {
    const s = await serve(
      (req, res) =>
        void res.writeHead(302, { location: `/${Number(req.url!.slice(1)) + 1}` }).end(),
    );
    expect(await codeOf(fetcher({ maxRedirects: 3 })(s.url + '/0'))).toBe('too_many_redirects');
  });

  it('treats a redirect without Location as a site error', async () => {
    const s = await serve((_req, res) => void res.writeHead(302).end());
    expect(await codeOf(fetcher()(s.url))).toBe('site_error');
  });
});

describe('safeFetch: resource-exhaustion defences', () => {
  it('rejects oversized declared Content-Length without downloading', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': '50000000' });
      res.write('x');
    });
    expect(await codeOf(fetcher({ maxBytes: 1_000_000 })(s.url))).toBe('too_large');
  });

  it('stops an endless chunked stream at the byte cap', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const t = setInterval(() => res.write('a'.repeat(50_000)), 1);
      res.on('close', () => clearInterval(t));
    });
    expect(await codeOf(fetcher({ maxBytes: 300_000 })(s.url))).toBe('too_large');
  });

  it('defuses a gzip bomb (tiny on the wire, huge when expanded)', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(60_000_000, 'a'));
    expect(bomb.length).toBeLessThan(200_000);
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(bomb);
    });
    expect(await codeOf(fetcher({ maxBytes: 1_000_000 })(s.url))).toBe('too_large');
  });

  it('defuses a brotli bomb', async () => {
    const bomb = zlib.brotliCompressSync(Buffer.alloc(60_000_000, 'a'));
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'br' });
      res.end(bomb);
    });
    expect(await codeOf(fetcher({ maxBytes: 1_000_000 })(s.url))).toBe('too_large');
  });

  it('times out a tarpit that drips one byte at a time', async () => {
    const s = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const t = setInterval(() => res.write('a'), 50);
      res.on('close', () => clearInterval(t));
    });
    const started = Date.now();
    expect(await codeOf(fetcher({ timeoutMs: 800 })(s.url))).toBe('fetch_timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('times out a server that never answers', async () => {
    const s = await serve(() => undefined);
    expect(await codeOf(fetcher({ timeoutMs: 600 })(s.url))).toBe('fetch_timeout');
  });

  it('honours a caller abort signal promptly', async () => {
    const s = await serve(() => undefined);
    const ac = new AbortController();
    const p = fetcher({ timeoutMs: 10_000 })(s.url, ac.signal);
    setTimeout(() => ac.abort(), 100);
    const started = Date.now();
    await expect(p).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('decompressCapped rejects corrupt and unsupported encodings with safe errors', () => {
    expect(() => decompressCapped(Buffer.from('not gzip'), 'gzip', 1000)).toThrow(AppError);
    expect(() => decompressCapped(Buffer.from('x'), 'zstd', 1000)).toThrow(AppError);
    expect(decompressCapped(Buffer.from('plain'), undefined, 1000).toString()).toBe('plain');
  });
});

describe('safeFetch: response handling', () => {
  const status = async (code: number, headers: Record<string, string> = {}) => {
    const s = await serve(
      (_req, res) => void res.writeHead(code, { 'content-type': 'text/html', ...headers }).end('x'),
    );
    return codeOf(fetcher()(s.url));
  };
  it('maps HTTP statuses to typed errors', async () => {
    expect(await status(404)).toBe('not_found');
    expect(await status(410)).toBe('not_found');
    expect(await status(401)).toBe('blocked_by_site');
    expect(await status(403)).toBe('blocked_by_site');
    expect(await status(451)).toBe('blocked_by_site');
    expect(await status(418)).toBe('blocked_by_site');
    expect(await status(429)).toBe('site_rate_limited');
    expect(await status(500)).toBe('site_error');
    expect(await status(503)).toBe('site_error');
  });

  it('carries Retry-After from a 429', async () => {
    const s = await serve((_req, res) => void res.writeHead(429, { 'retry-after': '42' }).end());
    try {
      await fetcher()(s.url);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).retryAfterSec).toBe(42);
    }
  });

  it.each([
    'application/pdf',
    'application/json',
    'image/png',
    'application/octet-stream',
    'video/mp4',
  ])('rejects %s as unsupported_content_type', async (type) => {
    const s = await serve(
      (_req, res) => void res.writeHead(200, { 'content-type': type }).end('binary'),
    );
    expect(await codeOf(fetcher()(s.url))).toBe('unsupported_content_type');
  });

  it('rejects binary with no content-type', async () => {
    const s = await serve((_req, res) => {
      res.removeHeader('content-type');
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    });
    expect(await codeOf(fetcher()(s.url))).toBe('unsupported_content_type');
  });

  it('reports connection refused as a retryable site error', async () => {
    const s = await startServer(() => undefined);
    const dead = s.url;
    await s.close();
    expect(await codeOf(fetcher()(dead))).toBe('site_error');
  });

  it('reports DNS failure as host_not_found', async () => {
    const f = fetcher({
      resolver: async () => {
        throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
      },
    });
    expect(await codeOf(f('http://definitely-not-real.test/'))).toBe('host_not_found');
  });
});
