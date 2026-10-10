import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { embeddedIPv4, expandIPv6, isBlockedIp } from '../src/pipeline/ip-policy.js';

describe('isBlockedIp: blocked addresses', () => {
  const blocked = [
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.255.255.254',
    '169.254.169.254', '169.254.0.1', '172.16.0.1', '172.31.255.255', '192.0.0.1', '192.0.2.1', '192.168.0.1', '192.168.255.255',
    '198.18.0.1', '198.19.255.255', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fe80::1', 'fc00::1', 'fd12:3456:789a::1', 'ff02::1', '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    // IPv4-mapped IPv6 pointing at private space, in both textual forms
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:169.254.169.254', '0:0:0:0:0:ffff:7f00:1',
  ];
  it.each(blocked)('%s is blocked', (ip) => expect(isBlockedIp(ip)).toBe(true));
});

describe('isBlockedIp: public addresses', () => {
  const allowed = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.169.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.255', '2606:4700:4700::1111', '2a00:1450:4001:81b::200e', '::ffff:8.8.8.8', '::ffff:808:808'];
  it.each(allowed)('%s is allowed', (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe('isBlockedIp: fails closed on non-IP input', () => {
  it.each(['', 'localhost', 'example.com', '1.2.3', '1.2.3.4.5', '256.1.1.1', 'fe80::1%eth0', '[::1]', '::ffff:999.1.1.1', '2130706433', '0x7f000001'])(
    '%j is treated as blocked',
    (v) => expect(isBlockedIp(v)).toBe(true),
  );
});

describe('IPv6 helpers', () => {
  it('expands compressed forms', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('2001:db8::ff00:42:8329')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0xff00, 0x42, 0x8329]);
    expect(expandIPv6('::ffff:1.2.3.4')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandIPv6('1:2:3:4:5:6:7::')).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
  });
  it('rejects malformed addresses', () => {
    expect(expandIPv6('1::2::3')).toBeUndefined();
    expect(expandIPv6('not-an-ip')).toBeUndefined();
    expect(expandIPv6('1.2.3.4')).toBeUndefined();
  });
  it('extracts embedded IPv4 only from ::ffff:0:0/96', () => {
    expect(embeddedIPv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(embeddedIPv4('::ffff:8.8.4.4')).toBe('8.8.4.4');
    expect(embeddedIPv4('64:ff9b::7f00:1')).toBeUndefined();
    expect(embeddedIPv4('2001:db8::1')).toBeUndefined();
  });
});

// Independent oracle written differently from the implementation: integer range checks.
const ipv4ToInt = (a: number, b: number, c: number, d: number) => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
const RANGES: Array<[number, number]> = [
  [ipv4ToInt(0, 0, 0, 0), ipv4ToInt(0, 255, 255, 255)],
  [ipv4ToInt(10, 0, 0, 0), ipv4ToInt(10, 255, 255, 255)],
  [ipv4ToInt(100, 64, 0, 0), ipv4ToInt(100, 127, 255, 255)],
  [ipv4ToInt(127, 0, 0, 0), ipv4ToInt(127, 255, 255, 255)],
  [ipv4ToInt(169, 254, 0, 0), ipv4ToInt(169, 254, 255, 255)],
  [ipv4ToInt(172, 16, 0, 0), ipv4ToInt(172, 31, 255, 255)],
  [ipv4ToInt(192, 0, 0, 0), ipv4ToInt(192, 0, 0, 255)],
  [ipv4ToInt(192, 0, 2, 0), ipv4ToInt(192, 0, 2, 255)],
  [ipv4ToInt(192, 88, 99, 0), ipv4ToInt(192, 88, 99, 255)],
  [ipv4ToInt(192, 168, 0, 0), ipv4ToInt(192, 168, 255, 255)],
  [ipv4ToInt(198, 18, 0, 0), ipv4ToInt(198, 19, 255, 255)],
  [ipv4ToInt(198, 51, 100, 0), ipv4ToInt(198, 51, 100, 255)],
  [ipv4ToInt(203, 0, 113, 0), ipv4ToInt(203, 0, 113, 255)],
  [ipv4ToInt(224, 0, 0, 0), ipv4ToInt(255, 255, 255, 255)],
];
const oracleBlocked = (n: number) => RANGES.some(([lo, hi]) => n >= lo && n <= hi);
const octet = fc.integer({ min: 0, max: 255 });

describe('isBlockedIp: property tests against an independent oracle', () => {
  it('agrees with integer-range oracle for every IPv4', () => {
    fc.assert(
      fc.property(octet, octet, octet, octet, (a, b, c, d) => {
        expect(isBlockedIp(`${a}.${b}.${c}.${d}`)).toBe(oracleBlocked(ipv4ToInt(a, b, c, d)));
      }),
      { numRuns: 3000 },
    );
  });
  it('treats IPv4-mapped IPv6 exactly like the embedded IPv4', () => {
    fc.assert(
      fc.property(octet, octet, octet, octet, (a, b, c, d) => {
        const hex = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
        const expected = isBlockedIp(`${a}.${b}.${c}.${d}`);
        expect(isBlockedIp(`::ffff:${a}.${b}.${c}.${d}`)).toBe(expected);
        expect(isBlockedIp(`::ffff:${hex}`)).toBe(expected);
      }),
      { numRuns: 2000 },
    );
  });
});
