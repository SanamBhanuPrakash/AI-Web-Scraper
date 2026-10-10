import type { PageInfo, SummarizeResponse, SummaryPoint, SummaryStreamEvent } from '@digest/shared';
import { SummarizeRequestSchema } from '@digest/shared';
import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Env } from '../lib/env.js';
import { AppError, toApiError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { cacheKey, canonicalCacheUrl, type SummaryCache } from '../lib/cache.js';
import type { RateLimiter } from '../lib/ratelimit.js';
import type { LlmRouter } from '../llm/router.js';
import { summarizeScraped } from '../llm/summarize.js';
import type { SafeFetcher } from '../pipeline/safe-fetch.js';
import { scrapePage } from '../pipeline/scrape.js';
import { parseTargetUrl, withOwnHosts, type UrlPolicy } from '../pipeline/validate-url.js';

export type AppVars = { Variables: { requestId: string } };

export interface SummarizeDeps {
  env: Env;
  logger: Logger;
  router: LlmRouter;
  cache: SummaryCache;
  rateLimiter: RateLimiter;
  policy: UrlPolicy;
  makeFetcher: (policy: UrlPolicy) => SafeFetcher;
  getClientIp: (c: Context<AppVars>) => string;
  /** Whole-request deadline in ms (fetch + extraction + LLM). */
  deadlineMs?: number;
}

const MAX_BODY_BYTES = 4096;
/** Cap on the page text returned to clients that ask for it (the UI uses it to highlight evidence). */
const MAX_SOURCE_CHARS = 120_000;

/** Strip the page text from a meta event for clients that did not ask for it. */
function forClient(ev: SummaryStreamEvent, includeText: boolean): SummaryStreamEvent {
  if (ev.type !== 'meta' || includeText) return ev;
  return { type: 'meta', page: ev.page };
}

/** Hostnames that identify THIS deployment, so the service can't be pointed at itself. */
function ownHostsFor(c: Context<AppVars>): string[] {
  const hosts = [
    c.req.header('host'),
    process.env['VERCEL_URL'],
    process.env['VERCEL_BRANCH_URL'],
    process.env['VERCEL_PROJECT_PRODUCTION_URL'],
  ];
  return hosts
    .filter((h): h is string => !!h)
    .map((h) =>
      h
        .replace(/^https?:\/\//, '')
        .replace(/[:/].*$/, '')
        .toLowerCase(),
    );
}

async function readJsonBody(c: Context<AppVars>): Promise<unknown> {
  const type = (c.req.header('content-type') ?? '').toLowerCase();
  if (!type.startsWith('application/json'))
    throw new AppError('invalid_request', { detail: 'content-type' });
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
    throw new AppError('invalid_request', { detail: 'body-too-large' });
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES)
    throw new AppError('invalid_request', { detail: 'body-too-large' });
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new AppError('invalid_request', { detail: 'bad-json', cause });
  }
}

export function createSummarizeHandler(d: SummarizeDeps) {
  return async (c: Context<AppVars>): Promise<Response> => {
    const requestId = c.get('requestId');
    const t0 = performance.now();
    const wantsStream = (c.req.header('accept') ?? '').includes('text/event-stream');
    const log: Record<string, unknown> = { route: 'summarize', stream: wantsStream };
    const emitLog = (status: number, extra: Record<string, unknown> = {}): void =>
      d.logger.info('request', {
        requestId,
        ...log,
        ...extra,
        status,
        totalMs: Math.round(performance.now() - t0),
      });

    try {
      // 1. Abuse protection first: cheapest check, protects everything behind it.
      const rl = await d.rateLimiter.check(d.getClientIp(c));
      c.header('X-RateLimit-Limit', String(rl.limit));
      c.header('X-RateLimit-Remaining', String(rl.remaining));
      if (!rl.allowed) throw new AppError('rate_limited', { retryAfterSec: rl.retryAfterSec });

      // 2. Input validation (server never trusts the client's own validation).
      const parsed = SummarizeRequestSchema.safeParse(await readJsonBody(c));
      if (!parsed.success) throw new AppError('invalid_request', { detail: 'schema' });
      const req = parsed.data;

      const policy = withOwnHosts(d.policy, ownHostsFor(c));
      const url = parseTargetUrl(req.url, policy);
      log['host'] = url.hostname;
      log['length'] = req.length;
      log['format'] = req.format;

      // 3. Produce events (from cache or by doing the work).
      const key = cacheKey(canonicalCacheUrl(url), req.length, req.format, req.language);
      const clientSignal = c.req.raw.signal;
      const deadline = AbortSignal.timeout(d.deadlineMs ?? 50_000);
      const signal = AbortSignal.any([clientSignal, deadline]);

      async function* produce(): AsyncGenerator<SummaryStreamEvent> {
        const cached = await d.cache.get(key);
        if (cached) {
          log['cached'] = true;
          for (const ev of cached.events) {
            if (ev.type === 'phase') continue; // progress of the original run means nothing on a replay
            yield ev.type === 'done'
              ? { ...ev, meta: { ...ev.meta, cached: true } }
              : forClient(ev, req.includeText);
          }
          return;
        }
        log['cached'] = false;
        yield { type: 'phase', phase: 'fetching' };
        const scraped = await scrapePage(
          url.toString(),
          { fetcher: d.makeFetcher(policy) },
          { maxInputChars: d.env.GEMINI_MAX_INPUT_CHARS },
          signal,
        );
        const recorded: SummaryStreamEvent[] = [];
        for await (const ev of summarizeScraped(
          { router: d.router, logger: d.logger },
          scraped,
          req,
          signal,
        )) {
          const wire: SummaryStreamEvent =
            ev.type === 'done'
              ? {
                  type: 'done',
                  stats: ev.stats,
                  page: ev.page,
                  meta: { ...ev.meta, cached: false },
                }
              : ev.type === 'meta'
                ? {
                    type: 'meta',
                    page: ev.page,
                    sourceText: scraped.fullText.slice(0, MAX_SOURCE_CHARS),
                    sourceTextTruncated: scraped.fullText.length > MAX_SOURCE_CHARS,
                  }
                : (ev as SummaryStreamEvent);
          recorded.push(wire); // the cache keeps the page text; it is stripped per request below
          if (wire.type === 'done') {
            log['provider'] = wire.meta.provider;
            log['model'] = wire.meta.model;
            log['fallback'] = wire.meta.fallback;
            log['timingsMs'] = wire.meta.timingsMs;
            log['wordsIn'] = scraped.page.wordCount;
            log['wordsOut'] = wire.stats.summaryWords;
            log['truncated'] = wire.page.truncated;
            log['grounded'] = `${wire.stats.groundedPoints}/${wire.stats.totalPoints}`;
          }
          yield forClient(wire, req.includeText);
        }
        await d.cache.set(key, { events: recorded });
      }

      /** Turn an abort caused by OUR deadline (not the client leaving) into a typed error. */
      const guard = async function* (): AsyncGenerator<SummaryStreamEvent> {
        try {
          yield* produce();
        } catch (err) {
          if (deadline.aborted && !clientSignal.aborted)
            throw new AppError('request_timeout', { cause: err });
          throw err;
        }
      };

      if (wantsStream) {
        return streamSSE(c, async (stream) => {
          const keepAlive = setInterval(
            () => void stream.write(': keep-alive\n\n').catch(() => undefined),
            10_000,
          );
          try {
            for await (const ev of guard()) {
              await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) });
            }
            emitLog(200);
          } catch (err) {
            if (clientSignal.aborted) {
              emitLog(499, { aborted: true });
              return;
            }
            const { status, body } = toApiError(err, requestId);
            const detail =
              err instanceof AppError
                ? err.detail
                : err instanceof Error
                  ? err.message
                  : String(err);
            if (body.error.code === 'internal_error')
              d.logger.error('stream failed', { requestId, err: detail });
            emitLog(status, { errorCode: body.error.code, detail });
            await stream.writeSSE({
              event: 'error',
              data: JSON.stringify({ type: 'error', ...body }),
            });
          } finally {
            clearInterval(keepAlive);
          }
        });
      }

      // JSON mode: same pipeline, drained into one document.
      let page: PageInfo | undefined;
      let sourceText: { text: string; truncated: boolean } | undefined;
      let tldr: string | undefined;
      let analysis: SummarizeResponse['analysis'];
      const points: SummaryPoint[] = [];
      let done: Extract<SummaryStreamEvent, { type: 'done' }> | undefined;
      for await (const ev of guard()) {
        if (ev.type === 'meta') {
          page = ev.page;
          if (ev.sourceText !== undefined)
            sourceText = { text: ev.sourceText, truncated: ev.sourceTextTruncated === true };
        } else if (ev.type === 'tldr') tldr = ev.text;
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
            ...(ev.unverifiedFigures ? { unverifiedFigures: ev.unverifiedFigures } : {}),
          });
        else if (ev.type === 'done') done = ev;
      }
      if (!page || !done)
        throw new AppError('internal_error', { detail: 'incomplete-event-sequence' });
      const body: SummarizeResponse = {
        requestId,
        page: { ...page, usedWords: done.page.usedWords, truncated: done.page.truncated },
        ...(sourceText
          ? { sourceText: sourceText.text, sourceTextTruncated: sourceText.truncated }
          : {}),
        ...(analysis ? { analysis } : {}),
        summary: { ...(tldr ? { tldr } : {}), points },
        stats: done.stats,
        meta: done.meta,
      };
      emitLog(200);
      return c.json(body);
    } catch (err) {
      const { status, body } = toApiError(err, requestId);
      const detail =
        err instanceof AppError ? err.detail : err instanceof Error ? err.message : String(err);
      emitLog(status, { errorCode: body.error.code, detail });
      if (body.error.code === 'internal_error')
        d.logger.error('request failed', { requestId, err: detail });
      if (body.error.retryAfterSec !== undefined)
        c.header('Retry-After', String(body.error.retryAfterSec));
      return c.json(body, status as 400);
    }
  };
}
