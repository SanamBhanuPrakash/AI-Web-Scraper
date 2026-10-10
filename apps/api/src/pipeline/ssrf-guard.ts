import dns from 'node:dns';
import { isBlockedIp } from './ip-policy.js';

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export class SsrfBlockedError extends Error {
  readonly code = 'ESSRF_BLOCKED';
  constructor(hostname: string, address: string) {
    super(`blocked address for ${hostname}`);
    this.name = 'SsrfBlockedError';
    this.cause = { address };
  }
}

export const systemResolver: Resolver = async (hostname) => {
  const rows = await dns.promises.lookup(hostname, { all: true, verbatim: true });
  return rows.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

function dnsError(code: string, hostname: string): Error & { code: string } {
  return Object.assign(new Error(`${code} ${hostname}`), { code });
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | ResolvedAddress[],
  family?: number,
) => void;

/**
 * Builds a `lookup` function for net/tls sockets. This is the heart of the SSRF defence (ADR-013):
 *
 *  - It resolves ALL records for the host and rejects if ANY of them is non-public
 *    (an attacker can publish one public and one private A record).
 *  - Because the check runs inside the socket's own lookup, the address that passed the check is
 *    the address the socket connects to. There is no second resolution, so DNS rebinding between
 *    "check" and "use" is impossible.
 *  - It runs again for every redirect hop automatically (each hop opens/validates a connection).
 *
 * Node skips `lookup` when the host is already an IP literal; those are validated separately in
 * `parseTargetUrl` before any connection is attempted.
 */
export function createGuardedLookup(
  opts: { resolver?: Resolver; isBlockedIp?: (ip: string) => boolean; dnsTimeoutMs?: number } = {},
) {
  const resolver = opts.resolver ?? systemResolver;
  const blocked = opts.isBlockedIp ?? isBlockedIp;
  const dnsTimeoutMs = opts.dnsTimeoutMs ?? 3000;

  return function lookup(
    hostname: string,
    optionsOrCb: dns.LookupOptions | LookupCallback | undefined,
    maybeCb?: LookupCallback,
  ): void {
    const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as LookupCallback;
    const options: dns.LookupOptions = typeof optionsOrCb === 'function' ? {} : (optionsOrCb ?? {});

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(dnsError('ETIMEOUT', hostname)), dnsTimeoutMs);
    });

    Promise.race([resolver(hostname), deadline])
      .then((rows) => {
        const wanted =
          options.family === 4 || options.family === 6
            ? rows.filter((r) => r.family === options.family)
            : rows;
        if (wanted.length === 0) throw dnsError('ENOTFOUND', hostname);
        const bad = wanted.find((r) => blocked(r.address));
        if (bad) throw new SsrfBlockedError(hostname, bad.address);
        if (options.all) cb(null, wanted);
        else cb(null, wanted[0]!.address, wanted[0]!.family);
      })
      .catch((err: NodeJS.ErrnoException) => cb(err))
      .finally(() => clearTimeout(timer));
  };
}
