import type { ApiErrorBody } from './errors.js';
import type { PageInfo } from './schemas.js';

/** One summary line. `grounded` = the supporting `quote` was mechanically found in the page text. */
export interface SummaryPoint {
  kind: 'bullet' | 'paragraph';
  text: string;
  quote?: string;
  grounded: boolean;
}

export interface SummaryStats {
  summaryWords: number;
  compressionRatio: number;
  groundedPoints: number;
  totalPoints: number;
}

export interface SummaryMeta {
  provider: string;
  model: string;
  promptVersion: string;
  fallback: boolean;
  cached: boolean;
  timingsMs: { fetch: number; extract: number; llm: number; total: number };
}

/** Server-sent events of POST /api/summarize (Accept: text/event-stream). Exactly one of done|error ends the stream. */
export type SummaryStreamEvent =
  | { type: 'phase'; phase: 'fetching' }
  | { type: 'meta'; page: PageInfo }
  | { type: 'tldr'; text: string }
  | ({ type: 'point' } & SummaryPoint)
  | {
      type: 'done';
      stats: SummaryStats;
      /** Final truncation facts (a fallback model can have a smaller input budget than the primary). */
      page: { usedWords: number; truncated: boolean };
      meta: SummaryMeta;
    }
  | ({ type: 'error' } & ApiErrorBody);

/** Body of a successful non-streaming POST /api/summarize. */
export interface SummarizeResponse {
  requestId: string;
  page: PageInfo;
  summary: { tldr?: string; points: SummaryPoint[] };
  stats: SummaryStats;
  meta: SummaryMeta;
}
