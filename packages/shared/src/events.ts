import type { ApiErrorBody } from './errors.js';
import type { PageInfo } from './schemas.js';

/** Which part of a detailed brief a point belongs to. Absent for the short, medium and long summaries. */
export type BriefSection = 'overview' | 'takeaway' | 'section' | 'fact' | 'caveat' | 'next';

/** One summary line. `grounded` = the supporting `quote` was mechanically found in the page text. */
export interface SummaryPoint {
  kind: 'bullet' | 'paragraph';
  section?: BriefSection;
  /** Name of the page section a `section` point summarizes. */
  heading?: string;
  text: string;
  quote?: string;
  grounded: boolean;
  /** Numbers written in `text` that do not occur in the page (likely invented). Absent when all figures check out. */
  unverifiedFigures?: string[];
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
  /** `deep` = the page was read and analysed first; `standard` = single pass (or a deep request that fell back). */
  mode?: 'deep' | 'standard';
  timingsMs: { fetch: number; extract: number; llm: number; total: number };
}

/** Server-sent events of POST /api/summarize (Accept: text/event-stream). Exactly one of done|error ends the stream. */
export type SummaryStreamEvent =
  | { type: 'phase'; phase: 'fetching' | 'understanding' | 'writing' }
  /** Sent once the page has been read and understood (detailed mode only). */
  | {
      type: 'analysis';
      pageType: string;
      audience?: string;
      sections: number;
      findings: number;
      /** Names of the page's sections, in order, so the UI can show what was found while the brief is written. */
      outline?: string[];
    }
  | { type: 'meta'; page: PageInfo; sourceText?: string; sourceTextTruncated?: boolean }
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
  sourceText?: string;
  sourceTextTruncated?: boolean;
  /** Detailed mode: what the page was understood to be (also sent as an `analysis` event when streaming). */
  analysis?: {
    pageType: string;
    audience?: string;
    sections: number;
    findings: number;
    outline?: string[];
  };
  summary: { tldr?: string; points: SummaryPoint[] };
  stats: SummaryStats;
  meta: SummaryMeta;
}
