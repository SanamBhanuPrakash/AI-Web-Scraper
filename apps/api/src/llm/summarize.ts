import type { PageInfo, SummarizeRequest } from '@digest/shared';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { applyBudget } from '../pipeline/budget.js';
import { countWords } from '../pipeline/clean.js';
import type { ScrapeResult } from '../pipeline/scrape.js';
import { BriefParser } from './brief-parser.js';
import {
  buildReadPrompt,
  buildWritePrompt,
  mergeAnalyses,
  parseAnalysis,
  splitForReading,
  verifyFindings,
  type Analysis,
  type RawAnalysis,
} from './deep.js';
import { figureSet, unverifiedFigures } from './figures.js';
import { indexSource } from './grounding.js';
import { buildPrompt, PROMPT_VERSION, type PassLength } from './prompt.js';
import type { LlmRouter } from './router.js';
import { SummaryParser, type SummaryEvent } from './summary-parser.js';

export interface DoneEvent {
  type: 'done';
  stats: {
    summaryWords: number;
    compressionRatio: number;
    groundedPoints: number;
    totalPoints: number;
  };
  /** Final truncation facts: a fallback provider may have a smaller input budget than the primary. */
  page: { usedWords: number; truncated: boolean };
  meta: {
    provider: string;
    model: string;
    promptVersion: string;
    fallback: boolean;
    mode: 'deep' | 'standard';
    timingsMs: { fetch: number; extract: number; llm: number; total: number };
  };
}

export type StreamEvent =
  | { type: 'meta'; page: PageInfo }
  | { type: 'phase'; phase: 'understanding' | 'writing' }
  | { type: 'analysis'; pageType: string; audience?: string; sections: number; findings: number }
  | SummaryEvent
  | DoneEvent;

export interface SummarizeDeps {
  router: LlmRouter;
  logger?: Logger;
}

type Options = Pick<SummarizeRequest, 'length' | 'format' | 'language'>;

/** The reading pass sends the whole page, so it must not be routed to a small-context "fast" provider first. */
const READ_HINT = { inputChars: Number.POSITIVE_INFINITY, needsLargeContext: true };

/**
 * Scraped page in, stream of structured events out:
 *   meta -> tldr -> point* -> done        (or throws an AppError at any point before `done`)
 * `detailed` first reads and verifies the whole page (phase, analysis events), then writes the brief.
 * The route layer decides how to frame these (SSE or one JSON body).
 */
export async function* summarizeScraped(
  deps: SummarizeDeps,
  scraped: ScrapeResult,
  options: Options,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const t0 = performance.now();
  yield { type: 'meta', page: scraped.page };

  if (options.length === 'detailed') {
    yield { type: 'phase', phase: 'understanding' };
    const read = await readPage(deps, scraped, signal);
    if (read) {
      yield {
        type: 'analysis',
        pageType: read.analysis.pageType,
        ...(read.analysis.audience ? { audience: read.analysis.audience } : {}),
        sections: read.analysis.outline.length,
        findings: read.analysis.findings.length,
      };
      yield { type: 'phase', phase: 'writing' };
      yield* writeBrief(deps, scraped, options, read, t0, signal);
      return;
    }
    deps.logger?.warn('deep read produced no usable notes; falling back to a single pass', {});
  }
  const length: PassLength = options.length === 'detailed' ? 'long' : options.length;
  yield* singlePass(deps, scraped, { ...options, length }, t0, signal);
}

/** Shared bookkeeping: summary words and grounded counts, plus the figure check on every point. */
function tracker(sourceText: string) {
  const sourceFigures = figureSet(sourceText);
  let total = 0;
  let grounded = 0;
  let words = 0;
  return {
    check(ev: SummaryEvent): SummaryEvent {
      let checked = ev;
      if (ev.type === 'point') {
        const bad = unverifiedFigures(ev.text, sourceFigures);
        if (bad.length > 0) checked = { ...ev, unverifiedFigures: bad };
      }
      words += countWords(checked.text);
      if (checked.type === 'point') {
        total++;
        if (checked.grounded) grounded++;
      }
      return checked;
    },
    stats(pageWords: number) {
      return {
        summaryWords: words,
        compressionRatio: Math.round((pageWords / Math.max(1, words)) * 10) / 10,
        groundedPoints: grounded,
        totalPoints: total,
      };
    },
  };
}

async function* singlePass(
  deps: SummarizeDeps,
  scraped: ScrapeResult,
  options: Omit<Options, 'length'> & { length: PassLength },
  t0: number,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const started = await deps.router.start(
    (provider) => {
      const budget = applyBudget(scraped.fullText, provider.maxInputChars);
      const built = buildPrompt({
        pageText: budget.text,
        title: scraped.page.title,
        length: options.length,
        format: options.format,
        language: options.language,
      });
      return { request: built, context: { budget, index: indexSource(budget.text) } };
    },
    signal,
    { inputChars: scraped.fullText.length },
  );

  const parser = new SummaryParser(started.context.index);
  const track = tracker(started.context.budget.text);

  for await (const chunk of started.chunks) {
    for (const ev of parser.push(chunk)) yield track.check(ev);
  }
  for (const ev of parser.end()) yield track.check(ev);
  if (!parser.hasContent) throw new AppError('ai_unavailable', { detail: 'empty-summary' });

  const { budget } = started.context;
  yield doneEvent(scraped, track.stats(scraped.page.wordCount), budget, started, 'standard', t0);
}

interface ReadResult {
  analysis: Analysis;
  usedWords: number;
  truncated: boolean;
  attempts: number;
}

/**
 * Pass 1. Read the entire page (in parallel parts when it is too long for one request), parse the notes,
 * and keep only findings the page backs up. Returns undefined when nothing usable came back, so the caller
 * can fall back to a single pass instead of failing the request.
 */
async function readPage(
  deps: SummarizeDeps,
  scraped: ScrapeResult,
  signal?: AbortSignal,
): Promise<ReadResult | undefined> {
  const parts = splitForReading(scraped.fullText);
  const results = await Promise.all(
    parts.map(async (text, i) => {
      const started = await deps.router.start(
        (provider) => {
          const budget = applyBudget(text, provider.maxInputChars);
          const request = buildReadPrompt({
            pageText: budget.text,
            title: scraped.page.title,
            part: { index: i + 1, total: parts.length },
          });
          return { request, context: { budget } };
        },
        signal,
        READ_HINT,
      );
      let raw = '';
      for await (const chunk of started.chunks) {
        raw += chunk;
        if (raw.length > 100_000) break; // a runaway answer is not notes
      }
      const parsed = parseAnalysis(raw);
      if (!parsed) return undefined;
      const { kept, dropped } = verifyFindings(parsed.findings, started.context.budget.text);
      deps.logger?.debug('read pass', {
        part: i + 1,
        of: parts.length,
        findings: parsed.findings.length,
        verified: kept.length,
        dropped,
      });
      const part: RawAnalysis = { ...parsed, findings: kept };
      return { part, budget: started.context.budget, attempts: started.attempts };
    }),
  );
  const ok = results.filter((r): r is NonNullable<typeof r> => r !== undefined);
  if (ok.length === 0) return undefined;
  const analysis = mergeAnalyses(ok.map((r) => r.part));
  if (analysis.findings.length < 3 || !analysis.thesis) return undefined;
  return {
    analysis,
    usedWords: ok.reduce((n, r) => n + r.budget.usedWords, 0),
    truncated: ok.some((r) => r.budget.truncated) || ok.length < parts.length,
    attempts: Math.max(...ok.map((r) => r.attempts)),
  };
}

/** Pass 2. Write the brief from verified notes only; evidence for each line comes from the notes it cites. */
async function* writeBrief(
  deps: SummarizeDeps,
  scraped: ScrapeResult,
  options: Options,
  read: ReadResult,
  t0: number,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const started = await deps.router.start(
    () => ({
      request: buildWritePrompt({
        analysis: read.analysis,
        title: scraped.page.title,
        language: options.language,
      }),
      context: undefined,
    }),
    signal,
    READ_HINT,
  );
  const parser = new BriefParser(read.analysis.findings);
  const track = tracker(scraped.fullText);
  for await (const chunk of started.chunks) {
    for (const ev of parser.push(chunk)) yield track.check(ev);
  }
  for (const ev of parser.end()) yield track.check(ev);
  if (!parser.hasContent) throw new AppError('ai_unavailable', { detail: 'empty-brief' });

  yield doneEvent(
    scraped,
    track.stats(scraped.page.wordCount),
    { usedWords: read.usedWords, truncated: read.truncated },
    {
      provider: started.provider,
      model: started.model,
      attempts: Math.max(started.attempts, read.attempts),
    },
    'deep',
    t0,
  );
}

function doneEvent(
  scraped: ScrapeResult,
  stats: DoneEvent['stats'],
  budget: { usedWords: number; truncated: boolean },
  started: { provider: string; model: string; attempts: number },
  mode: 'deep' | 'standard',
  t0: number,
): DoneEvent {
  const llmMs = Math.round(performance.now() - t0);
  return {
    type: 'done',
    stats,
    page: { usedWords: budget.usedWords, truncated: budget.truncated },
    meta: {
      provider: started.provider,
      model: started.model,
      promptVersion: PROMPT_VERSION,
      fallback: started.attempts > 1,
      mode,
      timingsMs: {
        fetch: scraped.timingsMs.fetch,
        extract: scraped.timingsMs.extract,
        llm: llmMs,
        total: scraped.timingsMs.fetch + scraped.timingsMs.extract + llmMs,
      },
    },
  };
}
