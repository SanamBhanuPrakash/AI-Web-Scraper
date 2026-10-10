import { AppError } from '../lib/errors.js';

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

function retryAfterSeconds(res: Response, bodyText: string): number | undefined {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return Math.min(Math.ceil(header), 3600);
  // Gemini reports e.g. "retryDelay": "32s" inside the error body.
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s?"/.exec(bodyText);
  return m ? Math.min(Math.ceil(Number(m[1])), 3600) : undefined;
}

/**
 * POST JSON to a provider and return the streaming response, or throw a typed AppError.
 * Upstream error bodies are NEVER propagated to clients (they can echo request fragments);
 * a short, key-free excerpt is kept in `detail` for server logs only.
 */
export async function postForStream(
  fetchFn: FetchFn,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Response & { body: ReadableStream<Uint8Array> }> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) throw err;
    throw new AppError('ai_unavailable', { detail: 'network', cause: err });
  }

  if (res.ok && res.body) return res as Response & { body: ReadableStream<Uint8Array> };

  const text = (await res.text().catch(() => '')).slice(0, 600);
  const excerpt = text.replace(/\s+/g, ' ').slice(0, 200);
  if (res.status === 429) {
    const ra = retryAfterSeconds(res, text);
    throw new AppError('ai_quota_exhausted', { detail: `429 ${excerpt}`, ...(ra !== undefined ? { retryAfterSec: ra } : {}) });
  }
  // 400/401/403/404 are configuration problems (bad key, retired model): not the user's fault, not retryable.
  throw new AppError('ai_unavailable', { detail: `${res.status} ${excerpt}` });
}
