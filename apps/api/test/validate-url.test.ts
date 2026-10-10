import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { parseTargetUrl, STRICT_POLICY, withOwnHosts } from '../src/pipeline/validate-url.js';

const codeOf = (input: string, policy = STRICT_POLICY): string => {
  try {
    parseTargetUrl(input, policy);
    return 'ok';
  } catch (e) {
    if (e instanceof AppError) return e.code;
    throw e;
  }
};

describe('parseTargetUrl: accepted input and normalization', () => {
  it('adds https:// to scheme-less input', () => {
    expect(parseTargetUrl('example.com').toString()).toBe('https://example.com/');
    expect(parseTargetUrl('  example.com/path?q=1  ').toString()).toBe('https://example.com/path?q=1');
  });
  it('keeps http and https, drops the fragment', () => {
    expect(parseTargetUrl('http://example.com/a#frag').toString()).toBe('http://example.com/a');
    expect(parseTargetUrl('https://en.wikipedia.org/wiki/Web_scraping').hostname).toBe('en.wikipedia.org');
  });
  it('accepts explicit default ports and public IP literals', () => {
    expect(codeOf('https://example.com:443/')).toBe('ok');
    expect(codeOf('http://example.com:80/')).toBe('ok');
    expect(codeOf('http://93.184.216.34/')).toBe('ok');
    expect(codeOf('http://[2606:4700:4700::1111]/')).toBe('ok');
  });
  it('accepts internationalized hostnames (punycode via WHATWG URL)', () => {
    expect(parseTargetUrl('https://bücher.example/').hostname).toBe('xn--bcher-kva.example');
  });
});

describe('parseTargetUrl: SSRF matrix (must all be rejected)', () => {
  const blockedUrl = [
    'http://localhost', 'http://localhost:80/', 'https://LOCALHOST/', 'http://foo.localhost/', 'http://localhost./',
    'http://127.0.0.1', 'http://127.1', 'http://0.0.0.0', 'http://0/', 'http://[::1]/', 'http://[::]/',
    'http://2130706433/', 'http://0x7f000001/', 'http://0x7f.0.0.1/', 'http://017700000001/', 'http://0177.0.0.1/', 'http://127.0.0.1.',
    'http://169.254.169.254/latest/meta-data/', 'http://[::ffff:169.254.169.254]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:127.0.0.1]/',
    'http://10.0.0.1', 'http://172.16.0.1', 'http://172.31.255.255', 'http://192.168.1.1', 'http://100.64.0.1', 'http://198.18.0.1',
    'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/',
    'http://example.com:22/', 'http://example.com:8080/', 'https://example.com:8443/', 'http://example.com:25/', 'http://example.com:6379/',
    'http://printer.local/', 'http://nas.internal/', 'http://router.lan/', 'http://intranet/', 'http://db/', 'http://metadata.google.internal/',
  ];
  it.each(blockedUrl)('blocks %s', (u) => expect(codeOf(u)).toBe('blocked_url'));
});

describe('parseTargetUrl: invalid input', () => {
  const invalid = [
    '', '   ', 'http://', 'https://:443', 'ht!tp://x.com', 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd', 'ftp://example.com/file', 'gopher://example.com/', 'mailto:a@b.co', 'ws://example.com',
    'http://user:pass@example.com/', 'https://user@example.com/', 'http://exa mple.com/', 'http://example.com/\u0000', 'http://example.com/\nHost: evil',
    'a'.repeat(2100),
  ];
  it.each(invalid)('rejects %j', (u) => expect(['invalid_request', 'blocked_url']).toContain(codeOf(u)));
  it('classifies scheme abuse as invalid_request', () => {
    expect(codeOf('javascript:alert(1)')).toBe('invalid_request');
    expect(codeOf('file:///etc/passwd')).toBe('invalid_request');
    expect(codeOf('http://user:pass@example.com/')).toBe('invalid_request');
  });
  it('treats "host:port" as a host, not a scheme', () => {
    expect(codeOf('localhost:3000')).toBe('blocked_url');
    expect(codeOf('example.com:8080')).toBe('blocked_url');
    expect(codeOf('example.com:443')).toBe('ok');
  });
});

describe('parseTargetUrl: own-host (self-recursion) protection', () => {
  const policy = withOwnHosts(STRICT_POLICY, ['digest.example.app']);
  it('rejects our own deployment host', () => {
    expect(codeOf('https://digest.example.app/api/summarize', policy)).toBe('blocked_url');
    expect(codeOf('https://DIGEST.example.app/', policy)).toBe('blocked_url');
  });
  it('still allows other hosts', () => expect(codeOf('https://example.org/', policy)).toBe('ok'));
});

describe('parseTargetUrl: properties', () => {
  it('never returns a URL with credentials, a non-http(s) scheme, or a fragment', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (s) => {
        try {
          const u = parseTargetUrl(s);
          expect(['http:', 'https:']).toContain(u.protocol);
          expect(u.username + u.password).toBe('');
          expect(u.hash).toBe('');
        } catch (e) {
          expect(e).toBeInstanceOf(AppError); // never an unhandled/unknown exception type
        }
      }),
      { numRuns: 4000 },
    );
  });
  it('blocks every private IPv4 literal regardless of how it is written', () => {
    const octet = fc.integer({ min: 0, max: 255 });
    fc.assert(
      fc.property(octet, octet, octet, (b, c, d) => {
        expect(codeOf(`http://10.${b}.${c}.${d}/`)).toBe('blocked_url');
        expect(codeOf(`http://192.168.${c}.${d}/`)).toBe('blocked_url');
        expect(codeOf(`http://127.${b}.${c}.${d}/`)).toBe('blocked_url');
        const asInt = ((127 << 24) | (b << 16) | (c << 8) | d) >>> 0;
        expect(codeOf(`http://${asInt}/`)).toBe('blocked_url'); // decimal form
        expect(codeOf(`http://0x${asInt.toString(16)}/`)).toBe('blocked_url'); // hex form
      }),
      { numRuns: 500 },
    );
  });
});
