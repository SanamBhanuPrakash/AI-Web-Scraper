import type { PageInfo, SummarizeRequest } from '@digest/shared';
import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { applyBudget } from '../pipeline/budget.js';
import { countWords } from '../pipeline/clean.js';
import type { ScrapeResult } from '../pipeline/scrape.js';
import { indexSource } from './grounding.js';
import { buildPrompt, PROMPT_VERSION } from './prompt.js';
import type { LlmRouter } from './router.js';
import { SummaryParser, type SummaryEvent } from './summary-parser.js';

export interface DoneEvent {
  type: 'done';
  stats: { summaryWords: number; compressionRatio: number; groundedPoints: number; totalPoints: number };
  /** Final truncation facts: a fallback provider may have a smaller input budget than the primary. */
  page: { usedWords: number; truncated: boolean };
  meta: {
    provider: string;
    model: string;
    promptVersion: string;
    fallback: boolean;
    timingsMs: { fetch: number; extract: number; llm: number; total: number };
  };
}

export type StreamEvent = { type: 'meta'; page: PageInfo } | SummaryEvent | DoneEvent;

export interface SummarizeDeps {
  router: LlmRouter;
  logger?: Logger;
}

/**
 * Scraped page in, stream of structured events out:
 *   meta -> tldr -> point* -> done        (or throws an AppError at any point before `done`)
 * The route layer decides how to frame these (SSE or one JSON body).
 */
export async function* summarizeScraped(
  deps: SummarizeDeps,
  scraped: ScrapeResult,
  options: Pick<SummarizeRequest, 'length' | 'format' | 'language'>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const t0 = performance.now();
  yield { type: 'meta', page: scraped.page };

  const started = await deps.router.start((provider) => {
    const budget = applyBudget(scraped.fullText, provider.maxInputChars);
    const built = buildPrompt({
      pageText: budget.text,
      title: scraped.page.title,
      length: options.length,
      format: options.format,
      language: options.language,
    });
    return { request: built, context: { budget, index: indexSource(budget.text) } };
  }, signal);

  const parser = new SummaryParser(started.context.index);
  let total = 0;
  let grounded = 0;
  let words = 0;
  const track = (ev: SummaryEvent): void => {
    words += countWords(ev.text);
    if (ev.type === 'point') {
      total++;
      if (ev.grounded) grounded++;
    }
  };

  for await (const chunk of started.chunks) {
    for (const ev of parser.push(chunk)) {
      track(ev);
      yield ev;
    }
  }
  for (const ev of parser.end()) {
    track(ev);
    yield ev;
  }
  if (!parser.hasContent) throw new AppError('ai_unavailable', { detail: 'empty-summary' });

  const llmMs = Math.round(performance.now() - t0);
  const { budget } = started.context;
  yield {
    type: 'done',
    stats: {
      summaryWords: words,
      compressionRatio: Math.round((scraped.page.wordCount / Math.max(1, words)) * 10) / 10,
      groundedPoints: grounded,
      totalPoints: total,
    },
    page: { usedWords: budget.usedWords, truncated: budget.truncated },
    meta: {
      provider: started.provider,
      model: started.model,
      promptVersion: PROMPT_VERSION,
      fallback: started.attempts > 1,
      timingsMs: {
        fetch: scraped.timingsMs.fetch,
        extract: scraped.timingsMs.extract,
        llm: llmMs,
        total: scraped.timingsMs.fetch + scraped.timingsMs.extract + llmMs,
      },
    },
  };
}
