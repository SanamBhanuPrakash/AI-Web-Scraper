/**
 * Live end-to-end check against the real internet and real AI providers (no HTTP server involved).
 * Usage (repo root):  npm run smoke -w @digest/api -- https://en.wikipedia.org/wiki/Web_scraping [short|medium|long|detailed] [bullets|paragraph]
 * Reads keys from .env. Never prints secrets.
 */
import { loadEnv } from '../src/lib/env.js';
import { createLogger } from '../src/lib/logger.js';
import { summarizeScraped } from '../src/llm/summarize.js';
import { buildRouter } from '../src/llm/providers.js';
import { createSafeFetcher } from '../src/pipeline/safe-fetch.js';
import { scrapePage } from '../src/pipeline/scrape.js';

type Length = 'short' | 'medium' | 'long' | 'detailed';
const [url, length = 'medium', format = 'bullets'] = process.argv.slice(2);
if (!url) {
  console.error('usage: smoke <url> [short|medium|long|detailed] [bullets|paragraph]');
  process.exit(2);
}

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL === 'info' ? 'warn' : env.LOG_LEVEL);
const router = buildRouter(env, logger);
const fetcher = createSafeFetcher({
  timeoutMs: env.FETCH_TIMEOUT_MS,
  maxBytes: env.MAX_HTML_BYTES,
});

const t0 = performance.now();
const ms = () => `${Math.round(performance.now() - t0)}ms`.padStart(7);
try {
  const scraped = await scrapePage(url, { fetcher }, { maxInputChars: env.GEMINI_MAX_INPUT_CHARS });
  console.log(
    `${ms()}  scraped  "${scraped.page.title}" | ${scraped.page.wordCount} words | ${scraped.page.confidence} confidence via ${scraped.page.extractionMethod} | fetch ${scraped.timingsMs.fetch}ms extract ${scraped.timingsMs.extract}ms`,
  );
  let first = true;
  for await (const ev of summarizeScraped({ router, logger }, scraped, {
    length: length as Length,
    format: format as 'bullets',
  })) {
    if (ev.type === 'meta') continue;
    if (ev.type === 'phase') {
      console.log(`${ms()}  phase ${ev.phase}`);
      continue;
    }
    if (ev.type === 'analysis') {
      console.log(
        `${ms()}  understood: ${ev.pageType}${ev.audience ? ` for ${ev.audience}` : ''}, ${ev.sections} sections, ${ev.findings} verified findings`,
      );
      continue;
    }
    if (first && ev.type !== 'done') {
      console.log(`${ms()}  first summary item`);
      first = false;
    }
    if (ev.type === 'tldr') console.log(`\nTLDR: ${ev.text}`);
    else if (ev.type === 'point') {
      const tag = ev.section ? `[${ev.section}] ` : '';
      const head = ev.heading ? `${ev.heading}: ` : '';
      const warn = ev.unverifiedFigures
        ? `  !! figures not in page: ${ev.unverifiedFigures.join(', ')}`
        : '';
      console.log(`  ${ev.grounded ? '✓' : '·'} ${tag}${head}${ev.text}${warn}`);
      if (ev.quote) console.log(`      “${ev.quote}”`);
    } else console.log(`\n${ms()}  done ${JSON.stringify({ ...ev.stats, ...ev.meta })}`);
  }
} catch (err) {
  const e = err as { code?: string; message?: string; detail?: string };
  console.error(
    `${ms()}  FAILED ${e.code ?? 'unknown'}: ${e.message}${e.detail ? ` [${e.detail}]` : ''}`,
  );
  process.exitCode = 1;
}
