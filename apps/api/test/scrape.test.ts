import { afterEach, describe, expect, it } from 'vitest';
import { createSafeFetcher } from '../src/pipeline/safe-fetch.js';
import { scrapePage } from '../src/pipeline/scrape.js';
import { PROSE, startServer, TEST_POLICY, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const serve = async (body: string, type = 'text/html; charset=utf-8') => {
  const s = await startServer((_req, res) => void res.writeHead(200, { 'content-type': type }).end(body));
  servers.push(s);
  return s;
};
const deps = { fetcher: createSafeFetcher({ policy: TEST_POLICY }) };

const article = (paras: string[]) =>
  `<!doctype html><html lang="en"><head><title>Pipeline test</title></head><body><nav><a href="/">Home</a></nav><article><h1>Pipeline test</h1>${paras.map((p) => `<p>${p}</p>`).join('')}</article><footer>footer</footer></body></html>`;

describe('scrapePage (fetch -> decode -> extract -> budget)', () => {
  it('returns page info, full text and prompt text for a normal article', async () => {
    const s = await serve(article(PROSE));
    const r = await scrapePage(s.url, deps, { maxInputChars: 50_000 });
    expect(r.page.title).toBe('Pipeline test');
    expect(r.page.truncated).toBe(false);
    expect(r.page.wordCount).toBeGreaterThan(150);
    expect(r.page.readingMinutes).toBe(1);
    expect(r.page.confidence).toBe('high');
    expect(r.promptText).toBe(r.fullText);
    expect(r.timingsMs.fetch).toBeGreaterThanOrEqual(0);
  });

  it('truncates to the model budget and says so', async () => {
    const many = Array.from({ length: 300 }, (_, i) => `${PROSE[i % PROSE.length]} (${i})`);
    const s = await serve(article(many));
    const r = await scrapePage(s.url, deps, { maxInputChars: 8_000 });
    expect(r.page.truncated).toBe(true);
    expect(r.promptText.length).toBeLessThanOrEqual(8_000);
    expect(r.page.usedWords).toBeLessThan(r.page.wordCount);
    expect(r.fullText.length).toBeGreaterThan(r.promptText.length);
  });

  it('handles plain text responses', async () => {
    const s = await serve(PROSE.join('\n\n'), 'text/plain');
    const r = await scrapePage(s.url, deps, { maxInputChars: 50_000 });
    expect(r.page.wordCount).toBeGreaterThan(150);
  });

  it('propagates typed errors (js-only page)', async () => {
    const s = await serve('<html><body><div id="root"></div><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></body></html>');
    await expect(scrapePage(s.url, deps, { maxInputChars: 50_000 })).rejects.toMatchObject({ code: 'js_rendered' });
  });

  it('parses a ~2 MB page well inside the latency budget', async () => {
    const big = Array.from({ length: 8000 }, (_, i) => `${PROSE[i % PROSE.length]} #${i}`);
    const html = article(big);
    expect(html.length).toBeGreaterThan(1_900_000);
    const s = await serve(html);
    const t = performance.now();
    const r = await scrapePage(s.url, { fetcher: createSafeFetcher({ policy: TEST_POLICY, maxBytes: 2_500_000 }) }, { maxInputChars: 60_000 });
    const elapsed = performance.now() - t;
    expect(r.page.truncated).toBe(true);
    expect(elapsed).toBeLessThan(2500); // plan §12 budget: extract < 0.5 s typical, 2 s hard
  });
});
