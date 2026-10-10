import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import type { LlmProvider, LlmRequest } from '../src/llm/provider.js';
import { LlmRouter } from '../src/llm/router.js';

type Impl = (req: LlmRequest, call: number) => AsyncGenerator<string>;
function fake(
  name: 'gemini' | 'groq',
  impl: Impl,
  maxInputChars = 1000,
): LlmProvider & { calls: number; seen: number[] } {
  const p = {
    name,
    model: `${name}-model`,
    maxInputChars,
    calls: 0,
    seen: [] as number[],
    stream(req: LlmRequest) {
      p.calls++;
      return impl(req, p.calls);
    },
  };
  return p;
}
const ok = (...chunks: string[]): Impl =>
  async function* () {
    for (const c of chunks) yield c;
  };
const failing = (code: ConstructorParameters<typeof AppError>[0], retryAfterSec?: number): Impl =>
  async function* () {
    throw new AppError(code, retryAfterSec !== undefined ? { retryAfterSec } : {});
  };
const hang: Impl = async function* (req) {
  await new Promise<void>((_, reject) =>
    req.signal?.addEventListener('abort', () => reject(req.signal?.reason ?? new Error('aborted'))),
  );
  yield 'never';
};
const build = (p: LlmProvider) => ({
  request: { system: 's', user: 'u', maxOutputTokens: 10, temperature: 0 },
  context: { budget: p.maxInputChars },
});
const drain = async (it: AsyncIterable<string>) => {
  let s = '';
  for await (const c of it) s += c;
  return s;
};
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof AppError ? e.code : `non-app:${(e as Error).message}`;
  }
};

describe('LlmRouter', () => {
  it('uses the primary provider when it works', async () => {
    const a = fake('gemini', ok('he', 'llo'));
    const b = fake('groq', ok('nope'));
    const s = await new LlmRouter({ providers: [a, b] }).start(build);
    expect(s.provider).toBe('gemini');
    expect(s.attempts).toBe(1);
    expect(await drain(s.chunks)).toBe('hello');
    expect(b.calls).toBe(0);
  });

  it('builds the prompt per provider so each gets its own input budget', async () => {
    const a = fake('gemini', failing('ai_unavailable'), 60_000);
    const b = fake('groq', ok('x'), 14_000);
    const s = await new LlmRouter({ providers: [a, b] }).start(build);
    expect(s.context.budget).toBe(14_000);
    expect(s.attempts).toBe(2);
  });

  it('falls back when the primary fails before its first token', async () => {
    const s = await new LlmRouter({
      providers: [fake('gemini', failing('ai_unavailable')), fake('groq', ok('b'))],
    }).start(build);
    expect(s.provider).toBe('groq');
    expect(await drain(s.chunks)).toBe('b');
  });

  it('falls back when the primary is too slow to produce a first token, and cancels it', async () => {
    let aborted = false;
    const slow: Impl = async function* (req) {
      req.signal?.addEventListener('abort', () => (aborted = true));
      yield* hang(req, 1);
    };
    const s = await new LlmRouter({
      providers: [fake('gemini', slow), fake('groq', ok('fast'))],
      firstTokenTimeoutMs: 60,
    }).start(build);
    expect(s.provider).toBe('groq');
    expect(aborted).toBe(true);
  });

  it('never switches provider after text has started (no spliced answers)', async () => {
    const midFail: Impl = async function* () {
      yield 'partial ';
      throw new AppError('ai_unavailable');
    };
    const b = fake('groq', ok('other'));
    const s = await new LlmRouter({ providers: [fake('gemini', midFail), b] }).start(build);
    expect(s.provider).toBe('gemini');
    await expect(drain(s.chunks)).rejects.toMatchObject({ code: 'ai_unavailable' });
    expect(b.calls).toBe(0);
  });

  it('treats an empty stream as a failure and moves on', async () => {
    const s = await new LlmRouter({
      providers: [fake('gemini', ok()), fake('groq', ok('x'))],
    }).start(build);
    expect(s.provider).toBe('groq');
  });

  it('enforces a total timeout on a stream that stalls mid-way', async () => {
    const stall: Impl = async function* (req) {
      yield 'a';
      yield* hang(req, 1);
    };
    const s = await new LlmRouter({ providers: [fake('gemini', stall)], totalTimeoutMs: 80 }).start(
      build,
    );
    await expect(drain(s.chunks)).rejects.toMatchObject({ code: 'ai_unavailable' });
  });

  describe('circuit breaker', () => {
    it('opens after a quota error for the advertised retry window, then recovers', async () => {
      let now = 1_000_000;
      const a = fake('gemini', failing('ai_quota_exhausted', 30));
      const b = fake('groq', ok('x'));
      const r = new LlmRouter({ providers: [a, b], now: () => now });
      await r.start(build); // gemini hits quota, groq answers
      expect(a.calls).toBe(1);
      await r.start(build);
      expect(a.calls).toBe(1); // skipped while breaker open
      now += 31_000;
      await r.start(build);
      expect(a.calls).toBe(2); // retried after the window
    });

    it('opens after repeated generic failures within the window', async () => {
      let now = 0;
      const a = fake('gemini', failing('ai_unavailable'));
      const b = fake('groq', ok('x'));
      const r = new LlmRouter({
        providers: [a, b],
        now: () => now,
        breaker: { failures: 3, windowMs: 60_000, openMs: 60_000 },
      });
      for (let i = 0; i < 3; i++) await r.start(build);
      expect(a.calls).toBe(3);
      await r.start(build);
      expect(a.calls).toBe(3);
      now += 61_000;
      await r.start(build);
      expect(a.calls).toBe(4);
    });

    it('does not count content refusals against provider health', async () => {
      const a = fake('gemini', failing('ai_refused'));
      const r = new LlmRouter({
        providers: [a, fake('groq', ok('x'))],
        breaker: { failures: 2, windowMs: 60_000, openMs: 60_000 },
      });
      for (let i = 0; i < 4; i++) await r.start(build);
      expect(a.calls).toBe(4);
    });
  });

  describe('error aggregation', () => {
    it('quota everywhere => ai_quota_exhausted with the shortest retry-after', async () => {
      const r = new LlmRouter({
        providers: [
          fake('gemini', failing('ai_quota_exhausted', 120)),
          fake('groq', failing('ai_quota_exhausted', 45)),
        ],
      });
      await expect(r.start(build)).rejects.toMatchObject({
        code: 'ai_quota_exhausted',
        retryAfterSec: 45,
      });
    });
    it('refusal everywhere => ai_refused', async () => {
      const r = new LlmRouter({
        providers: [fake('gemini', failing('ai_refused')), fake('groq', failing('ai_refused'))],
      });
      await expect(r.start(build)).rejects.toMatchObject({ code: 'ai_refused' });
    });
    it('mixed failures => ai_unavailable', async () => {
      const r = new LlmRouter({
        providers: [
          fake('gemini', failing('ai_quota_exhausted', 10)),
          fake('groq', failing('ai_unavailable')),
        ],
      });
      await expect(r.start(build)).rejects.toMatchObject({ code: 'ai_unavailable' });
    });
    it('no providers configured => ai_unavailable', async () => {
      expect(await codeOf(new LlmRouter({ providers: [] }).start(build))).toBe('ai_unavailable');
    });
    it('all providers skipped by an open quota breaker => ai_quota_exhausted with a wait hint', async () => {
      const now = 0;
      const r = new LlmRouter({
        providers: [fake('gemini', failing('ai_quota_exhausted', 90))],
        now: () => now,
      });
      await codeOf(r.start(build));
      await expect(r.start(build)).rejects.toMatchObject({
        code: 'ai_quota_exhausted',
        retryAfterSec: 90,
      });
    });
    it('wraps unexpected exceptions as ai_unavailable', async () => {
      const boom: Impl = async function* () {
        throw new TypeError('kaboom');
      };
      expect(await codeOf(new LlmRouter({ providers: [fake('gemini', boom)] }).start(build))).toBe(
        'ai_unavailable',
      );
    });
  });

  describe('caller cancellation', () => {
    it('rethrows an abort immediately and does not try the next provider', async () => {
      const b = fake('groq', ok('x'));
      const ac = new AbortController();
      const r = new LlmRouter({ providers: [fake('gemini', hang), b], firstTokenTimeoutMs: 5_000 });
      const p = r.start(build, ac.signal);
      setTimeout(() => ac.abort(), 30);
      expect(await codeOf(p)).not.toBe('ok');
      await p.catch(() => undefined);
      expect(b.calls).toBe(0);
    });
    it('aborts the upstream request when the consumer stops reading early', async () => {
      let aborted = false;
      const endless: Impl = async function* (req) {
        req.signal?.addEventListener('abort', () => (aborted = true));
        for (;;) {
          yield 'x';
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      const s = await new LlmRouter({ providers: [fake('gemini', endless)] }).start(build);
      for await (const _ of s.chunks) break; // consumer leaves
      expect(aborted).toBe(true);
    });
  });
});

describe('size-aware routing', () => {
  const big = fake('gemini', ok('G'), 60_000);
  const small = Object.assign(fake('groq', ok('Q'), 14_000), { fast: true });

  it('tries the fast provider first when the page fits its budget', async () => {
    const r = new LlmRouter({ providers: [big, small], routing: 'size-aware' });
    expect(r.orderFor({ inputChars: 5_000 }).map((p) => p.name)).toEqual(['groq', 'gemini']);
    const s = await r.start(build, undefined, { inputChars: 5_000 });
    expect(s.provider).toBe('groq');
  });

  it('uses the larger-context provider first for long pages', async () => {
    const r = new LlmRouter({ providers: [big, small], routing: 'size-aware' });
    expect(r.orderFor({ inputChars: 30_000 }).map((p) => p.name)).toEqual(['gemini', 'groq']);
    expect((await r.start(build, undefined, { inputChars: 30_000 })).provider).toBe('gemini');
  });

  it('boundary: exactly the fast budget still fits', () => {
    const r = new LlmRouter({ providers: [big, small], routing: 'size-aware' });
    expect(r.orderFor({ inputChars: 14_000 })[0]!.name).toBe('groq');
    expect(r.orderFor({ inputChars: 14_001 })[0]!.name).toBe('gemini');
  });

  it('ordered mode and a missing hint keep the configured order', () => {
    expect(
      new LlmRouter({ providers: [big, small], routing: 'ordered' })
        .orderFor({ inputChars: 100 })
        .map((p) => p.name),
    ).toEqual(['gemini', 'groq']);
    expect(
      new LlmRouter({ providers: [big, small], routing: 'size-aware' })
        .orderFor()
        .map((p) => p.name),
    ).toEqual(['gemini', 'groq']);
  });

  it('still falls back across the reordered list', async () => {
    const failingFast = Object.assign(fake('groq', failing('ai_quota_exhausted', 20), 14_000), {
      fast: true,
    });
    const r = new LlmRouter({ providers: [big, failingFast], routing: 'size-aware' });
    const s = await r.start(build, undefined, { inputChars: 2_000 });
    expect(s.provider).toBe('gemini');
    expect(s.attempts).toBe(2);
  });
});
