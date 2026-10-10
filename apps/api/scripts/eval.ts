/**
 * Summary quality harness. Runs a fixed set of real pages through the live pipeline and prints measurable
 * quality signals, so a prompt change can be judged by numbers and by reading the saved output, not by feel.
 *
 *   npm run eval -w @digest/api                       # all cases, writes eval-out.json next to the repo root
 *   npm run eval -w @digest/api -- --out v3.json      # choose the output file
 *   npm run eval -w @digest/api -- --only dev.to      # only cases whose URL contains the text
 *
 * Signals (all deterministic, no second model call):
 *   grounded    share of cited passages found verbatim in the page
 *   badFigures  numbers written in the summary that are not in the page (likely invented)
 *   generic     points that open with filler such as "The article discusses"
 *   specific    share of points that carry a concrete detail (a figure or a proper name)
 *   overlap     highest word overlap between two points (high = repetitive)
 *   words       average words per point and in the TL;DR
 *   ms          total time
 */
import { writeFileSync } from 'node:fs';
import { loadEnv } from '../src/lib/env.js';
import { createLogger } from '../src/lib/logger.js';
import { figureSet, unverifiedFigures } from '../src/llm/figures.js';
import { normalizeForMatch } from '../src/llm/grounding.js';
import { buildRouter } from '../src/llm/providers.js';
import { summarizeScraped } from '../src/llm/summarize.js';
import { countWords } from '../src/pipeline/clean.js';
import { createSafeFetcher } from '../src/pipeline/safe-fetch.js';
import { scrapePage } from '../src/pipeline/scrape.js';

type Length = 'short' | 'medium' | 'long' | 'detailed';
type Format = 'bullets' | 'paragraph';
interface Case {
  url: string;
  length: Length;
  format: Format;
  kind: string;
}

const CASES: Case[] = [
  {
    url: 'https://en.wikipedia.org/wiki/Web_scraping',
    length: 'medium',
    format: 'bullets',
    kind: 'encyclopedia',
  },
  {
    url: 'https://www.paulgraham.com/greatwork.html',
    length: 'medium',
    format: 'bullets',
    kind: 'long essay',
  },
  {
    url: 'https://www.paulgraham.com/ds.html',
    length: 'medium',
    format: 'bullets',
    kind: 'short essay',
  },
  {
    url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview',
    length: 'medium',
    format: 'bullets',
    kind: 'docs',
  },
  {
    url: 'https://react.dev/learn/thinking-in-react',
    length: 'medium',
    format: 'bullets',
    kind: 'tutorial',
  },
  {
    url: 'https://dev.to/valyuai/how-to-build-a-competitive-intelligence-agent-for-public-companies-op6',
    length: 'long',
    format: 'paragraph',
    kind: 'tutorial',
  },
  {
    url: 'https://arxiv.org/abs/1706.03762',
    length: 'short',
    format: 'bullets',
    kind: 'paper abstract',
  },
  {
    url: 'https://en.wikipedia.org/wiki/Transformer_(deep_learning_architecture)',
    length: 'long',
    format: 'bullets',
    kind: 'long technical',
  },
];

const GENERIC =
  /^(this|the)\s+(article|page|post|text|author|tutorial|guide|document|paper|website|blog|piece|passage|content)\b|\b(discusses|talks about|provides an overview|gives an overview|explains how|delves into|explores the)\b/i;
const VAGUE =
  /\b(various|several|numerous|a variety of|a number of|key (steps|factors|methods|aspects|concepts)|different (ways|methods|approaches|types)|multiple)\b/i;
const STOP = new Set(
  'the a an and or of to in on for with is are was were be been by as at from that this it its into than then also can will may not but have has had which their they them such more most other some any each'.split(
    ' ',
  ),
);
const contentWords = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
const jaccard = (a: Set<string>, b: Set<string>): number => {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.max(1, a.size + b.size - inter);
};
/** A concrete detail: a number, or a capitalized word that is not the first word of the sentence. */
const hasSpecific = (s: string): boolean =>
  /\d/.test(s) || /\s[A-Z][\p{L}\d-]{2,}/u.test(s.replace(/[.!?]\s+[A-Z]/g, '. x'));

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const outFile = flag('--out') ?? 'eval-out.json';
const only = flag('--only');
const forceLength = flag('--length') as Length | undefined;

const env = loadEnv();
const logger = createLogger('warn');
const router = buildRouter(env, logger);
const fetcher = createSafeFetcher({
  timeoutMs: env.FETCH_TIMEOUT_MS,
  maxBytes: env.MAX_HTML_BYTES,
});

interface Row {
  url: string;
  kind: string;
  length: Length;
  format: Format;
  ok: boolean;
  error?: string;
  provider?: string;
  words?: number;
  tldrWords?: number;
  avgPointWords?: number;
  points?: number;
  grounded?: number;
  quoted?: number;
  badFigures?: string[];
  generic?: number;
  vague?: number;
  specific?: number;
  overlap?: number;
  ms?: number;
  readMs?: number;
  mode?: string;
  sections?: Record<string, number>;
  findings?: number;
  /** Share of the page (in tenths) that at least one cited passage comes from: did it read the whole page? */
  coverage?: number;
  tldr?: string;
  items?: Array<{
    text: string;
    quote?: string;
    grounded: boolean;
    section?: string;
    heading?: string;
  }>;
}

const rows: Row[] = [];
for (const base of CASES.filter((x) => !only || x.url.includes(only))) {
  const c = { ...base, length: forceLength ?? base.length };
  const row: Row = { url: c.url, kind: c.kind, length: c.length, format: c.format, ok: false };
  const started = performance.now();
  try {
    const scraped = await scrapePage(
      c.url,
      { fetcher },
      { maxInputChars: env.GEMINI_MAX_INPUT_CHARS },
    );
    const source = figureSet(scraped.fullText);
    let tldr = '';
    const items: NonNullable<Row['items']> = [];
    let done:
      { meta: { provider: string; mode?: string }; stats: { summaryWords: number } } | undefined;
    let findings: number | undefined;
    let readMs: number | undefined;
    for await (const ev of summarizeScraped({ router, logger }, scraped, {
      length: c.length,
      format: c.format,
    })) {
      if (ev.type === 'tldr') tldr = ev.text;
      else if (ev.type === 'analysis') {
        findings = ev.findings;
        readMs = Math.round(performance.now() - started);
      } else if (ev.type === 'point')
        items.push({
          ...(ev.section ? { section: ev.section } : {}),
          ...(ev.heading ? { heading: ev.heading } : {}),
          text: ev.text,
          ...(ev.quote ? { quote: ev.quote } : {}),
          grounded: ev.grounded,
        });
      else if (ev.type === 'done') done = ev;
    }
    const all = [tldr, ...items.map((i) => i.text)].join(' ');
    const sets = items.map((i) => contentWords(i.text));
    let overlap = 0;
    for (let i = 0; i < sets.length; i++)
      for (let j = i + 1; j < sets.length; j++)
        overlap = Math.max(overlap, jaccard(sets[i]!, sets[j]!));
    const quoted = items.filter((i) => i.quote);
    const sections: Record<string, number> = {};
    for (const i of items) if (i.section) sections[i.section] = (sections[i.section] ?? 0) + 1;
    const deciles = new Set<number>();
    const normFull = normalizeForMatch(scraped.fullText);
    for (const i of quoted) {
      if (!i.grounded || !i.quote) continue;
      const key = normalizeForMatch(i.quote).split(' ').slice(0, 6).join(' ');
      if (key.split(' ').length < 3) continue;
      const at = normFull.indexOf(key);
      if (at !== -1) deciles.add(Math.min(9, Math.floor((at / normFull.length) * 10)));
    }
    Object.assign(row, {
      ok: true,
      mode: done?.meta.mode ?? 'standard',
      sections,
      findings,
      readMs,
      coverage: deciles.size,
      provider: done?.meta.provider,
      words: done?.stats.summaryWords,
      tldrWords: countWords(tldr),
      avgPointWords: Math.round(
        items.reduce((n, i) => n + countWords(i.text), 0) / Math.max(1, items.length),
      ),
      points: items.length,
      grounded: quoted.filter((i) => i.grounded).length,
      quoted: quoted.length,
      badFigures: unverifiedFigures(all, source),
      generic: items.filter((i) => GENERIC.test(i.text)).length + (GENERIC.test(tldr) ? 1 : 0),
      vague: items.filter((i) => VAGUE.test(i.text)).length,
      specific: Math.round(
        (items.filter((i) => hasSpecific(i.text)).length / Math.max(1, items.length)) * 100,
      ),
      overlap: Math.round(overlap * 100),
      ms: Math.round(performance.now() - started),
      tldr,
      items,
    });
  } catch (err) {
    row.error = (err as { code?: string }).code ?? (err as Error).message;
  }
  rows.push(row);
  console.log(
    `${row.ok ? 'ok ' : 'ERR'} ${c.kind.padEnd(15)} ${c.url.slice(8, 60).padEnd(52)} ${
      row.ok
        ? `${row.provider} grounded ${row.grounded}/${row.quoted} mode ${row.mode} read ${row.readMs ?? '-'}ms total ${row.ms}ms points ${row.points} findings ${row.findings ?? '-'} coverage ${row.coverage}/10 figs ${row.badFigures?.length} generic ${row.generic} vague ${row.vague} specific ${row.specific}% overlap ${row.overlap}% words ${row.avgPointWords}/pt`
        : row.error
    }`,
  );
  await new Promise((r) => setTimeout(r, 1500)); // stay well inside free-tier rate limits
}

const okRows = rows.filter((r) => r.ok);
const sum = (f: (r: Row) => number): number => okRows.reduce((n, r) => n + f(r), 0);
console.log('\nSUMMARY');
console.log(`  pages ok         ${okRows.length}/${rows.length}`);
console.log(
  `  grounded         ${sum((r) => r.grounded ?? 0)}/${sum((r) => r.quoted ?? 0)} cited passages`,
);
console.log(`  invented figures ${sum((r) => r.badFigures?.length ?? 0)}`);
console.log(
  `  generic openers  ${sum((r) => r.generic ?? 0)} of ${sum((r) => r.points ?? 0)} points`,
);
console.log(
  `  page coverage    ${(sum((r) => r.coverage ?? 0) / Math.max(1, okRows.length)).toFixed(1)}/10 tenths of the page cited, on average`,
);
console.log(
  `  deep mode        ${okRows.filter((r) => r.mode === 'deep').length}/${okRows.length} pages`,
);
console.log(`  vague wording    ${sum((r) => r.vague ?? 0)} points`);
console.log(
  `  specific points  ${Math.round(sum((r) => r.specific ?? 0) / Math.max(1, okRows.length))}% avg`,
);
console.log(
  `  max overlap      ${Math.round(sum((r) => r.overlap ?? 0) / Math.max(1, okRows.length))}% avg`,
);
writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
console.log(`\nfull output written to ${outFile}`);
