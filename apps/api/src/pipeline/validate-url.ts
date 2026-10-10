import { isIP } from 'node:net';
import { AppError } from '../lib/errors.js';
import { isBlockedIp } from './ip-policy.js';

/**
 * Policy knobs for what a fetch may touch. The strict default is what production uses.
 * Tests may construct a more permissive policy and pass it in explicitly; it is deliberately
 * NOT configurable through environment variables (ADR-015).
 */
export interface UrlPolicy {
  readonly allowedPorts: readonly number[] | 'any';
  readonly allowedProtocols: readonly string[];
  /** Hostnames (lowercased, no trailing dot) that must never be fetched, e.g. our own deployment. */
  readonly ownHosts: readonly string[];
  readonly isBlockedIp: (ip: string) => boolean;
  /** Reject names that cannot be public: localhost, *.local, *.internal, single-label hosts. */
  readonly blockNonPublicNames: boolean;
  readonly maxUrlLength: number;
}

export const STRICT_POLICY: UrlPolicy = {
  allowedPorts: [80, 443],
  allowedProtocols: ['http:', 'https:'],
  ownHosts: [],
  isBlockedIp,
  blockNonPublicNames: true,
  maxUrlLength: 2048,
};

export function withOwnHosts(policy: UrlPolicy, hosts: readonly string[]): UrlPolicy {
  return { ...policy, ownHosts: hosts.map((h) => h.toLowerCase().replace(/:\d+$/, '')) };
}

const NON_PUBLIC_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.localdomain',
  '.lan',
  '.home.arpa',
  '.intranet',
  '.corp',
];

function isNonPublicName(host: string): boolean {
  if (host === 'localhost') return true;
  if (!host.includes('.')) return true; // single-label names only resolve on private networks
  return NON_PUBLIC_SUFFIXES.some((s) => host.endsWith(s));
}

/**
 * Parse + normalize user input into a URL that is safe to *attempt*. Does not touch the network.
 * (DNS-level checks happen at connect time in ssrf-guard.ts; this layer handles everything that
 * can be decided from the text alone, including IP literals in any encoding.)
 */
export function parseTargetUrl(input: string, policy: UrlPolicy = STRICT_POLICY): URL {
  let s = input.trim();
  if (s.length === 0 || s.length > policy.maxUrlLength)
    throw new AppError('invalid_request', { detail: 'length' });
  // Control characters / whitespace inside a URL are never legitimate here.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f]/.test(s))
    throw new AppError('invalid_request', { detail: 'control-chars' });

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  if (!schemeMatch) {
    s = `https://${s}`;
  } else if (!s.startsWith(`${schemeMatch[0]}//`)) {
    // "host:port/path" has a scheme-looking prefix; "javascript:..." / "mailto:..." must be rejected.
    if (/^[^:/?#]+:\d+([/?#]|$)/.test(s)) s = `https://${s}`;
    else throw new AppError('invalid_request', { detail: 'scheme' });
  }

  let url: URL;
  try {
    url = new URL(s);
  } catch (cause) {
    throw new AppError('invalid_request', { detail: 'unparseable', cause });
  }

  if (!policy.allowedProtocols.includes(url.protocol)) {
    // file:, ftp:, gopher:, data:, javascript: ... are not web pages we may fetch.
    throw new AppError(
      url.protocol === 'http:' || url.protocol === 'https:' ? 'blocked_url' : 'invalid_request',
      {
        detail: `protocol:${url.protocol}`,
      },
    );
  }
  if (url.username !== '' || url.password !== '')
    throw new AppError('invalid_request', { detail: 'credentials' });

  if (policy.allowedPorts !== 'any' && url.port !== '') {
    if (!policy.allowedPorts.includes(Number(url.port)))
      throw new AppError('blocked_url', { detail: `port:${url.port}` });
  }

  // WHATWG URL has already canonicalized decimal/hex/octal IPv4 and compressed IPv6 into standard form.
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '');
  if (host === '') throw new AppError('invalid_request', { detail: 'empty-host' });

  if (policy.ownHosts.includes(host)) throw new AppError('blocked_url', { detail: 'self' });

  if (isIP(host) !== 0) {
    if (policy.isBlockedIp(host)) throw new AppError('blocked_url', { detail: `ip:${host}` });
  } else if (policy.blockNonPublicNames && isNonPublicName(host)) {
    throw new AppError('blocked_url', { detail: `name:${host}` });
  }

  url.hash = '';
  return url;
}
