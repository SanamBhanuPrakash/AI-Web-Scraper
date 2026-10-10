import type {
  ApiErrorBody,
  ErrorCode,
  SummarizeResponse,
  SummaryStreamEvent,
} from '@digest/shared';
import { SseParser } from './sse';

export type Length = 'short' | 'medium' | 'long' | 'detailed';
export type Format = 'bullets' | 'paragraph';

export interface SummarizeParams {
  url: string;
  length: Length;
  format: Format;
  /** BCP-47 tag for the summary language. Omitted means "same language as the page". */
  language?: string;
}

export type FailureCode = ErrorCode | 'network' | 'connection_lost' | 'bad_response';

export interface FailureInfo {
  code: FailureCode;
  message: string;
  retryable: boolean;
  retryAfterSec?: number;
  requestId?: string;
}

export class SummarizeFailure extends Error {
  constructor(readonly info: FailureInfo) {
    super(info.message);
    this.name = 'SummarizeFailure';
  }
}

/** Failures that happen before the server can say anything (so there is no server message to show). */
const LOCAL: Record<'network' | 'connection_lost' | 'bad_response', FailureInfo> = {
  network: {
    code: 'network',
    message: "We couldn't reach the service. Check your connection and try again.",
    retryable: true,
  },
  connection_lost: {
    code: 'connection_lost',
    message: 'The connection dropped before the summary finished. Try again.',
    retryable: true,
  },
  bad_response: {
    code: 'bad_response',
    message: 'The service sent a response we could not read. Try again in a moment.',
    retryable: true,
  },
};

const fromBody = (body: ApiErrorBody, retryAfterHeader?: string | null): FailureInfo => {
  const fallback = Number(retryAfterHeader);
  return {
    code: body.error.code,
    message: body.error.message,
    retryable: body.error.retryable,
    requestId: body.requestId,
    ...(body.error.retryAfterSec !== undefined
      ? { retryAfterSec: body.error.retryAfterSec }
      : Number.isFinite(fallback) && fallback > 0
        ? { retryAfterSec: Math.ceil(fallback) }
        : {}),
  };
};

const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';

/** Rebuild the event sequence from a one-shot JSON response (used if the stream is unavailable). */
export function eventsFromJson(body: SummarizeResponse): SummaryStreamEvent[] {
  const events: SummaryStreamEvent[] = [
    {
      type: 'meta',
      page: body.page,
      ...(body.sourceText !== undefined
        ? { sourceText: body.sourceText, sourceTextTruncated: body.sourceTextTruncated === true }
        : {}),
    },
  ];
  if (body.analysis) events.push({ type: 'analysis', ...body.analysis });
  if (body.summary.tldr) events.push({ type: 'tldr', text: body.summary.tldr });
  for (const p of body.summary.points) events.push({ type: 'point', ...p });
  events.push({
    type: 'done',
    stats: body.stats,
    page: { usedWords: body.page.usedWords, truncated: body.page.truncated },
    meta: body.meta,
  });
  return events;
}

/**
 * POST /api/summarize and deliver events as they arrive. Resolves only after a terminal `done`.
 * Rejects with SummarizeFailure (typed, user-presentable) or an AbortError if cancelled.
 */
export async function summarizeStream(
  params: SummarizeParams,
  onEvent: (ev: SummaryStreamEvent) => void,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl('/api/summarize', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ ...params, includeText: true }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted || isAbort(err)) throw err;
    throw new SummarizeFailure(LOCAL.network);
  }

  const type = res.headers.get('content-type') ?? '';

  if (!res.ok) {
    try {
      const body = (await res.json()) as ApiErrorBody;
      if (body?.error?.code)
        throw new SummarizeFailure(fromBody(body, res.headers.get('retry-after')));
    } catch (err) {
      if (err instanceof SummarizeFailure) throw err;
      if (signal?.aborted || isAbort(err)) throw err;
    }
    throw new SummarizeFailure(LOCAL.bad_response);
  }

  if (type.includes('application/json')) {
    let body: SummarizeResponse;
    try {
      body = (await res.json()) as SummarizeResponse;
    } catch (err) {
      if (signal?.aborted || isAbort(err)) throw err;
      throw new SummarizeFailure(LOCAL.bad_response);
    }
    for (const ev of eventsFromJson(body)) onEvent(ev);
    return;
  }

  if (!res.body) throw new SummarizeFailure(LOCAL.bad_response);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let finished = false;

  const handle = (data: string): void => {
    let ev: SummaryStreamEvent;
    try {
      ev = JSON.parse(data) as SummaryStreamEvent;
    } catch {
      return; // ignore a malformed event rather than abandoning the whole summary
    }
    if (ev.type === 'error') throw new SummarizeFailure(fromBody(ev));
    if (ev.type === 'done') finished = true;
    onEvent(ev);
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value)
        for (const m of parser.push(decoder.decode(value, { stream: true }))) handle(m.data);
      if (done) break;
    }
    for (const m of parser.end()) handle(m.data);
  } catch (err) {
    if (err instanceof SummarizeFailure || signal?.aborted || isAbort(err)) throw err;
    if (finished) return; // the socket was reset after the summary was complete
    throw new SummarizeFailure(LOCAL.connection_lost);
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (!finished) throw new SummarizeFailure(LOCAL.connection_lost);
}
