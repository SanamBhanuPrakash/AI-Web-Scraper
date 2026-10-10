import { AppError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import type { LlmProvider, LlmRequest, ProviderName } from './provider.js';

export interface RouterOptions {
  providers: LlmProvider[];
  /** If a provider produces no token within this time we abort it and try the next one. */
  firstTokenTimeoutMs?: number;
  /** Hard ceiling for one provider's whole stream. */
  totalTimeoutMs?: number;
  breaker?: { failures: number; windowMs: number; openMs: number };
  /**
   * `ordered`: use the configured order. `size-aware`: when the page fits a fast provider's input budget, try
   * the fast provider(s) first (about 1 s end to end instead of 4 to 7 s); longer pages go to the larger-context
   * provider first. Decided per request from the input size, so it needs no per-instance memory (serverless-safe).
   */
  routing?: 'ordered' | 'size-aware';
  logger?: Logger;
  now?: () => number;
}

/** What the router may know about a request when choosing a provider order. */
export interface RouteHint {
  inputChars: number;
  /** The whole page must fit: try larger-context providers first, whatever the page size. */
  needsLargeContext?: boolean;
}

export interface Started<C> {
  provider: ProviderName;
  model: string;
  context: C;
  /** How many providers were tried before this one answered (1 = primary succeeded). */
  attempts: number;
  chunks: AsyncGenerator<string>;
}

interface SkipInfo {
  quota: boolean;
  waitMs: number;
}

/** Per-instance circuit breaker. Eventual consistency is fine: worst case is one extra failed call. */
class Breaker {
  private readonly fails = new Map<string, number[]>();
  private readonly open = new Map<string, { until: number; quota: boolean }>();
  constructor(
    private readonly cfg: { failures: number; windowMs: number; openMs: number },
    private readonly now: () => number,
  ) {}

  state(name: string): SkipInfo | undefined {
    const o = this.open.get(name);
    if (!o) return undefined;
    const waitMs = o.until - this.now();
    if (waitMs <= 0) {
      this.open.delete(name);
      return undefined;
    }
    return { quota: o.quota, waitMs };
  }

  fail(name: string, err: AppError): void {
    if (err.code === 'ai_refused') return; // content-specific, says nothing about provider health
    const t = this.now();
    if (err.code === 'ai_quota_exhausted') {
      const openMs = err.retryAfterSec !== undefined ? err.retryAfterSec * 1000 : this.cfg.openMs;
      this.open.set(name, { until: t + openMs, quota: true });
      return;
    }
    const recent = (this.fails.get(name) ?? []).filter((x) => t - x < this.cfg.windowMs);
    recent.push(t);
    this.fails.set(name, recent);
    if (recent.length >= this.cfg.failures) {
      this.open.set(name, { until: t + this.cfg.openMs, quota: false });
      this.fails.delete(name);
    }
  }

  success(name: string): void {
    this.fails.delete(name);
    this.open.delete(name);
  }
}

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException('Aborted', 'AbortError');

export class LlmRouter {
  private readonly providers: LlmProvider[];
  private readonly firstTokenMs: number;
  private readonly totalMs: number;
  private readonly breaker: Breaker;
  private readonly logger: Logger | undefined;
  private readonly routing: 'ordered' | 'size-aware';

  constructor(opts: RouterOptions) {
    this.routing = opts.routing ?? 'ordered';
    this.providers = opts.providers;
    this.firstTokenMs = opts.firstTokenTimeoutMs ?? 8_000;
    this.totalMs = opts.totalTimeoutMs ?? 30_000;
    this.breaker = new Breaker(
      opts.breaker ?? { failures: 3, windowMs: 60_000, openMs: 60_000 },
      opts.now ?? Date.now,
    );
    this.logger = opts.logger;
  }

  get providerNames(): ProviderName[] {
    return this.providers.map((p) => p.name);
  }

  /**
   * Try providers in order until one produces its FIRST token, then commit to it. We never switch
   * provider after text has started flowing: that would splice two different models into one answer.
   * `build` is called per provider so each gets a prompt sized to its own quota-aware input budget.
   */
  async start<C>(
    build: (provider: LlmProvider) => { request: Omit<LlmRequest, 'signal'>; context: C },
    callerSignal?: AbortSignal,
    hint?: RouteHint,
  ): Promise<Started<C>> {
    const failures: AppError[] = [];
    const skipped: SkipInfo[] = [];
    let attempts = 0;

    for (const provider of this.orderFor(hint)) {
      if (callerSignal?.aborted) throw abortError(callerSignal);
      const state = this.breaker.state(provider.name);
      if (state) {
        skipped.push(state);
        this.logger?.debug('provider skipped (breaker open)', {
          provider: provider.name,
          waitMs: state.waitMs,
        });
        continue;
      }
      attempts++;
      try {
        return await this.attempt(provider, build, callerSignal, attempts);
      } catch (err) {
        if (callerSignal?.aborted) throw err;
        const app = toAppError(err);
        failures.push(app);
        this.breaker.fail(provider.name, app);
        this.logger?.warn('provider failed before first token', {
          provider: provider.name,
          model: provider.model,
          errorCode: app.code,
          detail: app.detail,
        });
      }
    }
    throw this.aggregate(failures, skipped);
  }

  /** Providers in the order they should be tried for this request. Stable: ties keep the configured order. */
  orderFor(hint?: RouteHint): LlmProvider[] {
    // A request that needs the whole page in context must not start on a small-context "fast" provider.
    if (hint?.needsLargeContext)
      return [...this.providers.filter((p) => !p.fast), ...this.providers.filter((p) => p.fast)];
    if (this.routing !== 'size-aware' || !hint) return this.providers;
    const fitsFast = (p: LlmProvider): boolean =>
      p.fast === true && hint.inputChars <= p.maxInputChars;
    return [...this.providers.filter(fitsFast), ...this.providers.filter((p) => !fitsFast(p))];
  }

  private async attempt<C>(
    provider: LlmProvider,
    build: (p: LlmProvider) => { request: Omit<LlmRequest, 'signal'>; context: C },
    callerSignal: AbortSignal | undefined,
    attempts: number,
  ): Promise<Started<C>> {
    const ac = new AbortController();
    const onCallerAbort = (): void => ac.abort(callerSignal?.reason);
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    let timedOut: 'first-token' | 'total' | undefined;
    const cleanupCaller = (): void => callerSignal?.removeEventListener('abort', onCallerAbort);

    const mapErr = (err: unknown): unknown => {
      if (callerSignal?.aborted) return err;
      if (err instanceof AppError) return err;
      if (timedOut)
        return new AppError('ai_unavailable', { detail: `${timedOut}-timeout`, cause: err });
      return toAppError(err);
    };

    const { request, context } = build(provider);
    const iter = provider.stream({ ...request, signal: ac.signal })[Symbol.asyncIterator]();

    const firstTimer = setTimeout(() => {
      timedOut = 'first-token';
      ac.abort(new Error('first-token-timeout'));
    }, this.firstTokenMs);

    let first: IteratorResult<string>;
    try {
      first = await iter.next();
    } catch (err) {
      cleanupCaller();
      ac.abort();
      throw mapErr(err);
    } finally {
      clearTimeout(firstTimer);
    }
    if (first.done) {
      cleanupCaller();
      throw new AppError('ai_unavailable', { detail: 'empty-response' });
    }

    this.breaker.success(provider.name);
    const totalTimer = setTimeout(() => {
      timedOut = 'total';
      ac.abort(new Error('total-timeout'));
    }, this.totalMs);
    const breaker = this.breaker;
    const firstValue = first.value;

    async function* chunks(): AsyncGenerator<string> {
      try {
        yield firstValue;
        for (;;) {
          const n = await iter.next();
          if (n.done) return;
          yield n.value;
        }
      } catch (err) {
        const mapped = mapErr(err);
        if (mapped instanceof AppError) breaker.fail(provider.name, mapped);
        throw mapped;
      } finally {
        clearTimeout(totalTimer);
        cleanupCaller();
        ac.abort();
        await iter.return?.().catch(() => undefined);
      }
    }

    return { provider: provider.name, model: provider.model, context, attempts, chunks: chunks() };
  }

  private aggregate(failures: AppError[], skipped: SkipInfo[]): AppError {
    if (this.providers.length === 0)
      return new AppError('ai_unavailable', { detail: 'no-providers-configured' });
    if (failures.length === 0) {
      const wait = Math.ceil(Math.min(...skipped.map((s) => s.waitMs)) / 1000);
      const quota = skipped.some((s) => s.quota);
      return new AppError(quota ? 'ai_quota_exhausted' : 'ai_unavailable', {
        detail: 'all-providers-skipped',
        retryAfterSec: wait,
      });
    }
    if (failures.every((f) => f.code === 'ai_refused'))
      return new AppError('ai_refused', { detail: failures[0]?.detail ?? '' });
    const quotaOnly = failures.every(
      (f) => f.code === 'ai_quota_exhausted' || f.code === 'ai_refused',
    );
    if (quotaOnly && failures.some((f) => f.code === 'ai_quota_exhausted')) {
      const waits = failures
        .map((f) => f.retryAfterSec)
        .filter((x): x is number => x !== undefined);
      return new AppError('ai_quota_exhausted', {
        detail: 'all-providers-quota',
        ...(waits.length ? { retryAfterSec: Math.min(...waits) } : {}),
      });
    }
    return new AppError('ai_unavailable', {
      detail: failures
        .map((f) => `${f.code}:${f.detail ?? ''}`)
        .join(' | ')
        .slice(0, 300),
    });
  }
}

function toAppError(err: unknown): AppError {
  return err instanceof AppError
    ? err
    : new AppError('ai_unavailable', { detail: 'unexpected', cause: err });
}
