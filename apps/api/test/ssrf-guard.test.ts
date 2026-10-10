import { describe, expect, it } from 'vitest';
import { createGuardedLookup, SsrfBlockedError, type Resolver } from '../src/pipeline/ssrf-guard.js';

type Result = { err: NodeJS.ErrnoException | null; address?: unknown; family?: number };
const run = (lookup: ReturnType<typeof createGuardedLookup>, host: string, options: object = {}): Promise<Result> =>
  new Promise((resolve) => lookup(host, options, (err, address, family) => resolve({ err, address, family })));

const fixed = (rows: Array<[string, 4 | 6]>): Resolver => async () => rows.map(([address, family]) => ({ address, family }));

describe('createGuardedLookup (connect-time SSRF check)', () => {
  it('returns the validated public address', async () => {
    const r = await run(createGuardedLookup({ resolver: fixed([['93.184.216.34', 4]]) }), 'example.com');
    expect(r.err).toBeNull();
    expect(r.address).toBe('93.184.216.34');
    expect(r.family).toBe(4);
  });

  it('supports { all: true } as used by autoSelectFamily', async () => {
    const r = await run(createGuardedLookup({ resolver: fixed([['93.184.216.34', 4], ['2606:2800:220:1::1', 6]]) }), 'example.com', { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 },
    ]);
  });

  it.each([['127.0.0.1'], ['10.1.2.3'], ['169.254.169.254'], ['::1'], ['::ffff:127.0.0.1'], ['fd00::1']])(
    'rejects a hostname that resolves to %s',
    async (ip) => {
      const r = await run(createGuardedLookup({ resolver: fixed([[ip, ip.includes(':') ? 6 : 4]]) }), 'evil.example');
      expect(r.err).toBeInstanceOf(SsrfBlockedError);
    },
  );

  it('rejects when ANY record is private (mixed public + private answers)', async () => {
    const r = await run(createGuardedLookup({ resolver: fixed([['93.184.216.34', 4], ['192.168.0.10', 4]]) }), 'mixed.example', { all: true });
    expect(r.err).toBeInstanceOf(SsrfBlockedError);
  });

  it('re-validates on every lookup, so DNS rebinding (public then private) is caught', async () => {
    let calls = 0;
    const flipping: Resolver = async () => [{ address: calls++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    const lookup = createGuardedLookup({ resolver: flipping });
    expect((await run(lookup, 'rebind.example')).err).toBeNull();
    expect((await run(lookup, 'rebind.example')).err).toBeInstanceOf(SsrfBlockedError);
  });

  it('maps empty answers to ENOTFOUND', async () => {
    const r = await run(createGuardedLookup({ resolver: fixed([]) }), 'nothing.example');
    expect(r.err?.code).toBe('ENOTFOUND');
  });

  it('filters by requested family and fails if nothing is left', async () => {
    const lookup = createGuardedLookup({ resolver: fixed([['93.184.216.34', 4]]) });
    expect((await run(lookup, 'v4only.example', { family: 6 })).err?.code).toBe('ENOTFOUND');
  });

  it('times out slow DNS instead of hanging', async () => {
    const slow: Resolver = () => new Promise(() => undefined);
    const r = await run(createGuardedLookup({ resolver: slow, dnsTimeoutMs: 50 }), 'slow.example');
    expect(r.err?.code).toBe('ETIMEOUT');
  });

  it('propagates resolver failures', async () => {
    const failing: Resolver = async () => {
      throw Object.assign(new Error('boom'), { code: 'EAI_AGAIN' });
    };
    expect((await run(createGuardedLookup({ resolver: failing }), 'x.example')).err?.code).toBe('EAI_AGAIN');
  });
});
