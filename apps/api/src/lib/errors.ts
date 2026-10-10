import { ERROR_CODES, type ApiErrorBody, type ErrorCode } from '@digest/shared';

/** The only error type that crosses module boundaries. Everything else is mapped by `toApiError`. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryAfterSec?: number;
  /** Internal-only detail for logs. Never sent to clients. */
  readonly detail?: string;

  constructor(code: ErrorCode, opts: { detail?: string; retryAfterSec?: number; cause?: unknown } = {}) {
    super(ERROR_CODES[code].message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    if (opts.detail !== undefined) this.detail = opts.detail;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
  }
}

/** Walk the `cause` chain looking for a match. Network libraries wrap the useful error. */
export function findInCauseChain<T>(err: unknown, pick: (e: unknown) => T | undefined): T | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const hit = pick(cur);
    if (hit !== undefined) return hit;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Single place that turns any thrown value into a safe, typed API error body. */
export function toApiError(err: unknown, requestId: string): { status: number; body: ApiErrorBody } {
  const app = findInCauseChain(err, (e) => (e instanceof AppError ? e : undefined));
  const code: ErrorCode = app?.code ?? 'internal_error';
  const meta = ERROR_CODES[code];
  return {
    status: meta.status,
    body: {
      requestId,
      error: {
        code,
        message: meta.message,
        retryable: meta.retryable,
        ...(app?.retryAfterSec !== undefined ? { retryAfterSec: app.retryAfterSec } : {}),
      },
    },
  };
}
