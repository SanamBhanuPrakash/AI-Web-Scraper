import type { Readable } from 'node:stream';
import zlib from 'node:zlib';
import { Agent, request } from 'undici';
import { AppError, findInCauseChain } from '../lib/errors.js';
import { createGuardedLookup, SsrfBlockedError, type Resolver } from './ssrf-guard.js';
import { parseTargetUrl, STRICT_POLICY, type UrlPolicy } from './validate-url.js';

export interface SafeFetcherConfig {
  /** Total wall-clock budget for the whole fetch including redirects. */
  timeoutMs?: number;
  /** Cap on decoded body size. Enforced while streaming, never trusted from headers alone. */
  maxBytes?: number;
  maxRedirects?: number;
  userAgent?: string;
  policy?: UrlPolicy;
  /** Injectable DNS for tests. */
  resolver?: Resolver;
}

export interface FetchedPage {
  requestedUrl: URL;
  finalUrl: URL;
  status: number;
  contentType: string;
  body: Buffer;
  redirects: number;
  /** Declared (or sniffed) mime type, lowercased, without parameters. */
  mime: string;
}

const ALLOWED_MIME = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);
const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ETIMEOUT',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME']);
const TLS_CODE_RE = /^(CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|ERR_TLS_|ERR_SSL|HOSTNAME_MISMATCH|ERR_OSSL)/;

function collectCodes(err: unknown): string[] {
  const out: string[] = [];
  findInCauseChain(err, (e) => {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string') out.push(c);
    return undefined;
  });
  return out;
}

function mapNetworkError(err: unknown, timedOut: boolean): Error {
  if (err instanceof AppError) return err;
  if (findInCauseChain(err, (e) => (e instanceof AppError ? e : undefined))) {
    return findInCauseChain(err, (e) => (e instanceof AppError ? e : undefined))!;
  }
  if (findInCauseChain(err, (e) => (e instanceof SsrfBlockedError ? e : undefined))) {
    return new AppError('blocked_url', { detail: 'dns-resolved-to-blocked-address', cause: err });
  }
  if (timedOut) return new AppError('fetch_timeout', { cause: err });
  const codes = collectCodes(err);
  if (codes.some((c) => TIMEOUT_CODES.has(c))) return new AppError('fetch_timeout', { cause: err });
  if (codes.some((c) => DNS_CODES.has(c))) return new AppError('host_not_found', { cause: err });
  if (codes.some((c) => TLS_CODE_RE.test(c))) return new AppError('tls_error', { cause: err });
  if (codes.length > 0) return new AppError('site_error', { detail: codes.join(','), cause: err });
  return err instanceof Error ? err : new Error(String(err));
}

function mapStatus(status: number, headers: Record<string, string | string[] | undefined>): AppError | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 404 || status === 410) return new AppError('not_found');
  if (status === 401 || status === 403 || status === 451) return new AppError('blocked_by_site', { detail: String(status) });
  if (status === 408) return new AppError('fetch_timeout', { detail: '408' });
  if (status === 429) {
    const ra = Number(Array.isArray(headers['retry-after']) ? headers['retry-after'][0] : headers['retry-after']);
    return new AppError('site_rate_limited', Number.isFinite(ra) && ra > 0 ? { retryAfterSec: Math.min(ra, 300) } : {});
  }
  if (status >= 500) return new AppError('site_error', { detail: String(status) });
  return new AppError('blocked_by_site', { detail: String(status) });
}

/**
 * Destroy a response body without risking an unhandled 'error' event. undici emits an AbortError on
 * destroy(); with no listener attached that would surface as an uncaught exception and could take
 * the whole process down. Always discard bodies through this helper.
 */
function discard(body: Readable): void {
  body.on('error', () => undefined);
  body.destroy();
}

async function readCapped(body: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > max) {
      discard(body);
      throw new AppError('too_large', { detail: 'stream-exceeded-cap' });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks, total);
}

/** Decompress with a hard output cap so a tiny gzip "bomb" cannot exhaust memory. */
export function decompressCapped(buf: Buffer, encoding: string | undefined, max: number): Buffer {
  const enc = (encoding ?? '').toLowerCase().trim();
  if (enc === '' || enc === 'identity') return buf;
  const opts = { maxOutputLength: max };
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf, opts);
    if (enc === 'br') return zlib.brotliDecompressSync(buf, opts);
    if (enc === 'deflate') {
      try {
        return zlib.inflateSync(buf, opts);
      } catch (e) {
        if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') throw e;
        return zlib.inflateRawSync(buf, opts); // some servers send raw deflate
      }
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
      throw new AppError('too_large', { detail: 'decompressed-exceeded-cap', cause: err });
    }
    throw new AppError('site_error', { detail: 'bad-content-encoding', cause: err });
  }
  throw new AppError('site_error', { detail: `unsupported-content-encoding:${enc}` });
}

function sniffLooksLikeHtml(buf: Buffer): boolean {
  const head = buf.subarray(0, 1024).toString('latin1').trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<head') || head.includes('<body');
}

function headerString(v: string | string[] | undefined): string {
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

export function createSafeFetcher(cfg: SafeFetcherConfig = {}) {
  const timeoutMs = cfg.timeoutMs ?? 10_000;
  const maxBytes = cfg.maxBytes ?? 2_000_000;
  const maxRedirects = cfg.maxRedirects ?? 5;
  const policy = cfg.policy ?? STRICT_POLICY;
  const userAgent = cfg.userAgent ?? 'DigestBot/1.0 (user-initiated page summarizer)';

  return async function safeFetch(input: string, callerSignal?: AbortSignal): Promise<FetchedPage> {
    const requestedUrl = parseTargetUrl(input, policy);
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;

    const dispatcher = new Agent({
      connect: {
        lookup: createGuardedLookup({
          ...(cfg.resolver ? { resolver: cfg.resolver } : {}),
          isBlockedIp: policy.isBlockedIp,
        }) as never,
        timeout: Math.min(5_000, timeoutMs),
      },
      headersTimeout: Math.min(8_000, timeoutMs),
      bodyTimeout: Math.min(8_000, timeoutMs),
      pipelining: 0,
    });

    try {
      let current = requestedUrl;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        let res: Awaited<ReturnType<typeof request>>;
        try {
          res = await request(current, {
            method: 'GET',
            dispatcher,
            signal,
            headers: {
              'user-agent': userAgent,
              accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.8,*/*;q=0.1',
              'accept-language': 'en;q=0.9,*;q=0.5',
              'accept-encoding': 'gzip, deflate, br',
            },
          });
        } catch (err) {
          throw mapNetworkError(err, timeoutSignal.aborted);
        }

        const status = res.statusCode;
        const headers = res.headers;

        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = headerString(headers['location']);
          discard(res.body);
          if (!location) throw new AppError('site_error', { detail: 'redirect-without-location' });
          if (hop === maxRedirects) throw new AppError('too_many_redirects');
          let next: URL;
          try {
            next = parseTargetUrl(new URL(location, current).toString(), policy); // re-validate EVERY hop
          } catch (err) {
            if (err instanceof AppError && err.code === 'invalid_request') {
              throw new AppError('blocked_url', { detail: 'bad-redirect-target', cause: err });
            }
            throw err;
          }
          if (current.protocol === 'https:' && next.protocol === 'http:') {
            throw new AppError('blocked_url', { detail: 'https-downgrade' });
          }
          current = next;
          continue;
        }

        const statusErr = mapStatus(status, headers);
        if (statusErr) {
          discard(res.body);
          throw statusErr;
        }

        const contentType = headerString(headers['content-type']);
        const mime = contentType.split(';')[0]!.trim().toLowerCase();
        if (mime !== '' && !ALLOWED_MIME.has(mime)) {
          discard(res.body);
          throw new AppError('unsupported_content_type', { detail: mime });
        }
        const declared = Number(headerString(headers['content-length']));
        if (Number.isFinite(declared) && declared > maxBytes) {
          discard(res.body);
          throw new AppError('too_large', { detail: 'content-length' });
        }

        let raw: Buffer;
        try {
          raw = await readCapped(res.body, maxBytes);
        } catch (err) {
          throw mapNetworkError(err, timeoutSignal.aborted);
        }
        const body = decompressCapped(raw, headerString(headers['content-encoding']), maxBytes);

        let finalMime = mime;
        if (finalMime === '') {
          if (!sniffLooksLikeHtml(body)) throw new AppError('unsupported_content_type', { detail: 'unknown' });
          finalMime = 'text/html';
        }
        return { requestedUrl, finalUrl: current, status, contentType, body, redirects: hop, mime: finalMime };
      }
      throw new AppError('too_many_redirects');
    } finally {
      void dispatcher.close().catch(() => dispatcher.destroy());
    }
  };
}

export type SafeFetcher = ReturnType<typeof createSafeFetcher>;
