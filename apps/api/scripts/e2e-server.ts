/**
 * Server for browser end-to-end tests: the REAL API (mock summarizer, no keys, no internet) plus a small fixture
 * website to summarize. The permissive URL policy is passed as a constructor argument here, never via env,
 * so production configuration can't weaken the SSRF defence (ADR-015).
 *
 *   npm run e2e-server -w @digest/api        API on :8790, fixture site on :8791
 */
import http from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { loadEnv } from '../src/lib/env.js';
import { createLogger } from '../src/lib/logger.js';
import { MemoryRateLimiter } from '../src/lib/ratelimit.js';
import { buildRouter } from '../src/llm/providers.js';
import { TEST_POLICY } from '../test/helpers.js';

const SITE_PORT = 8791;
const API_PORT = 8790;

const PROSE = [
  'Web scraping is the automated extraction of data from websites. A scraper requests a page over HTTP, receives markup, and then pulls out the pieces of text or structured data that matter to the caller.',
  'Modern sites complicate that picture. Some deliver finished HTML from the server, while others ship an almost empty document and assemble the page in the browser with JavaScript, which a simple HTTP client cannot execute.',
  'Responsible scrapers identify themselves honestly, limit how often they connect, cap how much they download, and refuse to follow links into private networks, because a server that fetches arbitrary addresses on behalf of strangers can be abused to reach internal services.',
  'Extraction itself is a ranking problem. Navigation menus, cookie banners, advertisements and footers surround the article, and the extractor must decide which block of the document is the main content by scoring paragraphs, link density and text length.',
  'Once the main text has been isolated it can be passed to a language model. Because the page is untrusted input, the prompt must treat it strictly as data and never as instructions, and the output must be rendered as plain text.',
  'Finally, results should be honest about their limits. When a page is truncated for length, or when the extractor is unsure it found the real article, the interface should say so instead of presenting a confident summary of the wrong text.',
];

const page = (title: string, body: string, extraHead = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${extraHead}</head><body><nav><a href="/">Home</a></nav><article><h1>${title}</h1>${body}</article><footer>Footer</footer></body></html>`;
const paras = (n: number) =>
  Array.from({ length: n }, (_, i) => `<p>${PROSE[i % PROSE.length]} (${i})</p>`).join('');

const routes: Record<string, (res: http.ServerResponse) => void> = {
  '/article': (res) =>
    html(
      res,
      page(
        'How Responsible Scrapers Work',
        paras(6),
        '<meta name="author" content="Ada Lovelace"><meta property="og:site_name" content="Example Engineering Blog">',
      ),
    ),
  // Worst-case data: a very long unbroken title, a huge page (truncation), odd characters.
  '/long-title': (res) =>
    html(
      res,
      page(
        `Supercalifragilistic${'x'.repeat(180)} and a title that keeps going well past any sensible length for a heading`,
        paras(6),
      ),
    ),
  '/huge': (res) => html(res, page('A Very Long Page', paras(1800))),
  '/spa': (res) =>
    html(
      res,
      '<!doctype html><html><head><title>App</title><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></head><body><div id="root"></div></body></html>',
    ),
  '/tiny': (res) => html(res, '<html><body><p>Hi.</p></body></html>'),
  '/pdf': (res) => void res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF-1.4'),
  '/missing': (res) => void res.writeHead(404, { 'content-type': 'text/html' }).end('nope'),
  '/slow': () => undefined, // never answers: lets tests exercise the working state and cancelling
};
function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
}

http
  .createServer((req, res) => {
    const handler = routes[(req.url ?? '/').split('?')[0] ?? '/'];
    if (handler) handler(res);
    else res.writeHead(404).end();
  })
  .listen(SITE_PORT, '127.0.0.1');

const env = loadEnv({
  DIGEST_MOCK_LLM: '1',
  RATE_LIMIT_PER_MIN: '600',
  LOG_LEVEL: 'warn',
} as NodeJS.ProcessEnv);
const logger = createLogger('warn');
const app = createApp({
  env,
  logger,
  router: buildRouter(env, logger),
  policy: TEST_POLICY,
  rateLimiter: new MemoryRateLimiter(600),
  deadlineMs: 20_000,
});
serve({ fetch: app.fetch, port: API_PORT }, () =>
  logger.warn('e2e server ready', { api: API_PORT, site: SITE_PORT }),
);
