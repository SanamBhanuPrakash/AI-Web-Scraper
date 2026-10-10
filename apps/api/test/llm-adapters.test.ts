import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { createGeminiProvider } from '../src/llm/gemini.js';
import { createGroqProvider } from '../src/llm/groq.js';
import type { LlmRequest } from '../src/llm/provider.js';
import { startServer, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const serve = async (...a: Parameters<typeof startServer>) => {
  const s = await startServer(...a);
  servers.push(s);
  return s;
};

const KEY = 'test-key-1234567890-abcdefghij';
const req: LlmRequest = { system: 'sys', user: 'usr', maxOutputTokens: 100, temperature: 0.2 };
const drain = async (it: AsyncIterable<string>) => {
  let s = '';
  for await (const c of it) s += c;
  return s;
};
const sse = (res: ServerResponse, events: unknown[], raw = false) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`data: ${raw ? e : JSON.stringify(e)}\n\n`);
  res.end();
};
const readBody = (r: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let b = '';
    r.on('data', (c) => (b += c));
    r.on('end', () => resolve(b));
  });
const errOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e as AppError;
  }
};

describe('Gemini adapter', () => {
  const gem = (s: TestServer) =>
    createGeminiProvider({ apiKey: KEY, model: 'gem-test', baseUrl: s.url });

  it('sends the key in a header (never the URL) and the expected request shape', async () => {
    let seen: { url?: string; headers: Record<string, unknown>; body?: any } = { headers: {} };
    const s = await serve(async (r, res) => {
      seen = { url: r.url ?? '', headers: r.headers, body: JSON.parse(await readBody(r)) };
      sse(res, [{ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }]);
    });
    await drain(gem(s).stream(req));
    expect(seen.url).toContain('/v1beta/models/gem-test:streamGenerateContent');
    expect(seen.url).toContain('alt=sse');
    expect(seen.url).not.toContain(KEY);
    expect(seen.headers['x-goog-api-key']).toBe(KEY);
    expect(seen.body.systemInstruction.parts[0].text).toBe('sys');
    expect(seen.body.contents[0].parts[0].text).toBe('usr');
    expect(seen.body.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 100 });
  });

  it('streams text parts, skips "thought" parts and malformed events', async () => {
    const s = await serve((_r, res) =>
      sse(
        res,
        [
          {
            candidates: [
              {
                content: { parts: [{ text: 'secret reasoning', thought: true }, { text: 'Hel' }] },
              },
            ],
          },
          'not json',
          { candidates: [{ content: { parts: [{ text: 'lo' }] }, finishReason: 'STOP' }] },
        ].map((e) => (typeof e === 'string' ? e : JSON.stringify(e))),
        true,
      ),
    );
    expect(await drain(gem(s).stream(req))).toBe('Hello');
  });

  it('maps 429 to ai_quota_exhausted using Retry-After, then the body retryDelay', async () => {
    let mode = 0;
    const s = await serve((_r, res) => {
      if (mode++ === 0)
        return void res
          .writeHead(429, { 'retry-after': '17' })
          .end('{"error":{"message":"quota"}}');
      res.writeHead(429).end('{"error":{"details":[{"retryDelay":"32s"}]}}');
    });
    expect(await errOf(drain(gem(s).stream(req)))).toMatchObject({
      code: 'ai_quota_exhausted',
      retryAfterSec: 17,
    });
    expect(await errOf(drain(gem(s).stream(req)))).toMatchObject({
      code: 'ai_quota_exhausted',
      retryAfterSec: 32,
    });
  });

  it.each([400, 401, 403, 404, 500, 503])(
    'maps HTTP %i to ai_unavailable without leaking the upstream body',
    async (status) => {
      const s = await serve((_r, res) => void res.writeHead(status).end(`leak:${KEY}`));
      const e = await errOf(drain(gem(s).stream(req)));
      expect(e).toMatchObject({ code: 'ai_unavailable' });
      expect(e!.message).not.toContain('leak');
      expect(e!.message).not.toContain(KEY);
    },
  );

  it('maps prompt blocks and safety finishes to ai_refused', async () => {
    const blocked = await serve((_r, res) =>
      sse(res, [{ promptFeedback: { blockReason: 'SAFETY' } }]),
    );
    expect(await errOf(drain(gem(blocked).stream(req)))).toMatchObject({ code: 'ai_refused' });
    const finished = await serve((_r, res) =>
      sse(res, [{ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'SAFETY' }] }]),
    );
    expect(await errOf(drain(gem(finished).stream(req)))).toMatchObject({ code: 'ai_refused' });
  });

  it('maps in-stream errors', async () => {
    const s = await serve((_r, res) =>
      sse(res, [{ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }]),
    );
    expect(await errOf(drain(gem(s).stream(req)))).toMatchObject({ code: 'ai_quota_exhausted' });
  });

  it('reports connection failures as ai_unavailable and honours abort', async () => {
    const dead = await startServer(() => undefined);
    const url = dead.url;
    await dead.close();
    expect(
      await errOf(
        drain(createGeminiProvider({ apiKey: KEY, model: 'm', baseUrl: url }).stream(req)),
      ),
    ).toMatchObject({ code: 'ai_unavailable' });

    const hang = await serve(() => undefined);
    const ac = new AbortController();
    const p = errOf(drain(gem(hang).stream({ ...req, signal: ac.signal })));
    setTimeout(() => ac.abort(), 50);
    const e = await p;
    expect(e).toBeTruthy();
    expect(e).not.toBeInstanceOf(AppError);
  });
});

describe('Groq adapter', () => {
  const groq = (s: TestServer) =>
    createGroqProvider({ apiKey: KEY, model: 'groq-test', baseUrl: s.url });

  it('sends a bearer token and an OpenAI-compatible body', async () => {
    let seen: { url?: string; headers: Record<string, unknown>; body?: any } = { headers: {} };
    const s = await serve(async (r, res) => {
      seen = { url: r.url ?? '', headers: r.headers, body: JSON.parse(await readBody(r)) };
      sse(res, ['{"choices":[{"delta":{"content":"hi"}}]}', '[DONE]'], true);
    });
    expect(await drain(groq(s).stream(req))).toBe('hi');
    expect(seen.url).toBe('/openai/v1/chat/completions');
    expect(seen.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(seen.body).toMatchObject({
      model: 'groq-test',
      stream: true,
      temperature: 0.2,
      max_tokens: 100,
    });
    expect(seen.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
    ]);
  });

  it('streams deltas and stops at [DONE], ignoring role-only and empty deltas', async () => {
    const s = await serve((_r, res) =>
      sse(
        res,
        [
          '{"choices":[{"delta":{"role":"assistant"}}]}',
          '{"choices":[{"delta":{"content":"A"}}]}',
          '{"choices":[{"delta":{"content":null}}]}',
          '{"choices":[{"delta":{"content":"B"},"finish_reason":"stop"}]}',
          '[DONE]',
          '{"choices":[{"delta":{"content":"ignored"}}]}',
        ],
        true,
      ),
    );
    expect(await drain(groq(s).stream(req))).toBe('AB');
  });

  it('maps 429 with Retry-After, errors without leaking bodies, and content filtering', async () => {
    const limited = await serve(
      (_r, res) =>
        void res
          .writeHead(429, { 'retry-after': '9' })
          .end('{"error":{"message":"Rate limit reached"}}'),
    );
    expect(await errOf(drain(groq(limited).stream(req)))).toMatchObject({
      code: 'ai_quota_exhausted',
      retryAfterSec: 9,
    });

    const broken = await serve((_r, res) => void res.writeHead(500).end(`secret:${KEY}`));
    const e = await errOf(drain(groq(broken).stream(req)));
    expect(e).toMatchObject({ code: 'ai_unavailable' });
    expect(e!.message).not.toContain(KEY);

    const filtered = await serve((_r, res) =>
      sse(res, ['{"choices":[{"delta":{"content":"x"},"finish_reason":"content_filter"}]}'], true),
    );
    expect(await errOf(drain(groq(filtered).stream(req)))).toMatchObject({ code: 'ai_refused' });
  });

  it('maps in-stream rate-limit errors', async () => {
    const s = await serve((_r, res) =>
      sse(res, ['{"error":{"type":"rate_limit_exceeded","message":"slow down"}}'], true),
    );
    expect(await errOf(drain(groq(s).stream(req)))).toMatchObject({ code: 'ai_quota_exhausted' });
  });
});
