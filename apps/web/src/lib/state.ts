import type {
  PageInfo,
  SummaryMeta,
  SummaryPoint,
  SummaryStats,
  SummaryStreamEvent,
} from '@digest/shared';
import type { FailureInfo, SummarizeParams } from './api';

export type Status = 'idle' | 'working' | 'done' | 'error';

export interface State {
  status: Status;
  request?: SummarizeParams;
  page?: PageInfo;
  sourceText?: string;
  sourceTruncated?: boolean;
  tldr?: string;
  points: SummaryPoint[];
  stats?: SummaryStats;
  meta?: SummaryMeta;
  failure?: FailureInfo;
  /** Detailed mode: what the server is doing now, and what it understood about the page. */
  phase?: 'fetching' | 'understanding' | 'writing';
  analysis?: PageAnalysis;
  /** Set when the user cancelled, so the idle screen can acknowledge it. */
  cancelled?: boolean;
}

export interface PageAnalysis {
  pageType: string;
  audience?: string;
  sections: number;
  findings: number;
  outline?: string[];
}

export const initialState: State = { status: 'idle', points: [] };

export type Action =
  | { type: 'start'; request: SummarizeParams }
  | { type: 'event'; event: SummaryStreamEvent }
  | { type: 'fail'; failure: FailureInfo }
  | { type: 'cancel' }
  | { type: 'reset' };

/** Which stage the progress UI should show while working. Derived from real server events, not timers. */
export type Stage = 'fetching' | 'understanding' | 'writing' | 'streaming';
export const stageOf = (s: State): Stage =>
  !s.page
    ? 'fetching'
    : s.tldr || s.points.length > 0
      ? 'streaming'
      : s.phase === 'understanding' && !s.analysis
        ? 'understanding'
        : 'writing';

export function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'start':
      return { status: 'working', request: action.request, points: [] };
    case 'event':
      if (state.status !== 'working') return state; // late event from a cancelled/finished run
      return applyEvent(state, action.event);
    case 'fail':
      if (state.status !== 'working') return state; // never replace a finished result with a late error
      return { ...state, status: 'error', failure: action.failure };
    case 'cancel':
      return {
        status: 'idle',
        points: [],
        cancelled: true,
        ...(state.request ? { request: state.request } : {}),
      };
    case 'reset':
      return initialState;
  }
}

function applyEvent(state: State, ev: SummaryStreamEvent): State {
  switch (ev.type) {
    case 'phase':
      return { ...state, phase: ev.phase };
    case 'analysis':
      return {
        ...state,
        analysis: {
          pageType: ev.pageType,
          ...(ev.audience ? { audience: ev.audience } : {}),
          sections: ev.sections,
          findings: ev.findings,
          ...(ev.outline ? { outline: ev.outline } : {}),
        },
      };
    case 'meta':
      return {
        ...state,
        page: ev.page,
        ...(ev.sourceText !== undefined
          ? { sourceText: ev.sourceText, sourceTruncated: ev.sourceTextTruncated === true }
          : {}),
      };
    case 'tldr':
      return { ...state, tldr: ev.text };
    case 'point': {
      const { type: _t, ...point } = ev;
      return { ...state, points: [...state.points, point] };
    }
    case 'done':
      return {
        ...state,
        status: 'done',
        stats: ev.stats,
        meta: ev.meta,
        ...(state.page
          ? { page: { ...state.page, usedWords: ev.page.usedWords, truncated: ev.page.truncated } }
          : {}),
      };
    case 'error':
      return {
        ...state,
        status: 'error',
        failure: {
          code: ev.error.code,
          message: ev.error.message,
          retryable: ev.error.retryable,
          requestId: ev.requestId,
          ...(ev.error.retryAfterSec !== undefined
            ? { retryAfterSec: ev.error.retryAfterSec }
            : {}),
        },
      };
  }
}
