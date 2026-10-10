/**
 * Captures a REAL result for the web app's first-screen sample (apps/web/src/sample.json).
 * The page text is trimmed to the lead paragraphs plus every paragraph that contains a verified quote,
 * so the sample stays small but every highlight is real. Run with live keys:
 *   npm run capture-sample -w @digest/api -- https://en.wikipedia.org/wiki/Web_scraping
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SummarizeResponse, SummaryPoint } from '@digest/shared';
import { loadEnv } from '../src/lib/env.js';
import { createLogger } from '../src/lib/logger.js';
import { indexSource, isQuoteGrounded } from '../src/llm/grounding.js';
import { buildRouter } from '../src/llm/providers.js';
import { summarizeScraped, type DoneEvent } from '../src/llm/summarize.js';
import { createSafeFetcher } from '../src/pipeline/safe-fetch.js';
import { scrapePage } from '../src/pipeline/scrape.js';

const url = process.argv[2] ?? 'https://en.wikipedia.org/wiki/Web_scraping';
const out = fileURLToPath(new URL('../../web/src/sample.json', import.meta.url));

const env = loadEnv();
const logger = createLogger('warn');
const router = buildRouter(env, logger);
const scraped = await scrapePage(
  url,
  { fetcher: createSafeFetcher({ timeoutMs: env.FETCH_TIMEOUT_MS, maxBytes: env.MAX_HTML_BYTES }) },
  { maxInputChars: env.GEMINI_MAX_INPUT_CHARS },
);

let tldr: string | undefined;
let analysis: SummarizeResponse['analysis'];
const points: SummaryPoint[] = [];
let done: DoneEvent | undefined;
for await (const ev of summarizeScraped({ router, logger }, scraped, {
  length: 'detailed',
  format: 'bullets',
})) {
  if (ev.type === 'tldr') tldr = ev.text;
  else if (ev.type === 'analysis')
    analysis = {
      pageType: ev.pageType,
      ...(ev.audience ? { audience: ev.audience } : {}),
      sections: ev.sections,
      findings: ev.findings,
    };
  else if (ev.type === 'point')
    points.push({
      kind: ev.kind,
      ...(ev.section ? { section: ev.section } : {}),
      ...(ev.heading ? { heading: ev.heading } : {}),
      text: ev.text,
      grounded: ev.grounded,
      ...(ev.quote ? { quote: ev.quote } : {}),
    });
  else if (ev.type === 'done') done = ev;
}
if (!done) throw new Error('no done event');

const paragraphs = scraped.fullText.split('\n');
const keep = paragraphs.filter(
  (p, i) =>
    i < 3 ||
    points.some((pt) => pt.grounded && pt.quote && isQuoteGrounded(pt.quote, indexSource(p))),
);
const sourceText = keep.map((p) => (p.length > 900 ? `${p.slice(0, 900)}...` : p)).join('\n');

const sample: SummarizeResponse & { capturedAt: string; note: string } = {
  requestId: 'sample',
  page: { ...scraped.page, usedWords: done.page.usedWords, truncated: done.page.truncated },
  sourceText,
  sourceTextTruncated: true,
  ...(analysis ? { analysis } : {}),
  summary: { ...(tldr ? { tldr } : {}), points },
  stats: done.stats,
  meta: { ...done.meta, cached: false },
  capturedAt: new Date().toISOString(),
  note: 'Real output captured from the live pipeline. Page text trimmed to the passages that matter.',
};
writeFileSync(out, JSON.stringify(sample, null, 2) + '\n');
console.log(
  `wrote ${out}: ${points.length} points, ${points.filter((p) => p.grounded).length} grounded, ${sourceText.length} chars of page text`,
);
