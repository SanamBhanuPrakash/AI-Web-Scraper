import { BlockList, isIP } from 'node:net';

/**
 * Address classification for the SSRF guard. Fails CLOSED: anything we cannot parse is "blocked".
 * Uses Node's built-in BlockList (no third-party CIDR code to audit).
 */
const blocked = new BlockList();

const V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // deprecated 6to4 relay
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
];

const V6: ReadonlyArray<readonly [string, number]> = [
  ['::', 96], // unspecified, loopback ::1, deprecated IPv4-compatible
  ['64:ff9b::', 96], // NAT64 (embeds IPv4)
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['::ffff:0:0:0', 96], // SIIT translated addresses (embed IPv4)
  ['3fff::', 20], // documentation (RFC 9637)
  ['2001::', 32], // Teredo (embeds IPv4)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 (embeds IPv4)
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
];

for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, 'ipv6');

/** Expand any valid IPv6 text form to 8 numeric 16-bit groups. Returns undefined if invalid. */
export function expandIPv6(ip: string): number[] | undefined {
  if (isIP(ip) !== 6) return undefined;
  let s = ip.toLowerCase();
  // Convert a trailing dotted IPv4 (::ffff:1.2.3.4) into two hex groups.
  const m = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m) {
    const [a, b, c, d] = [m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number];
    s = `${m[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return undefined;
  const groups = [...head, ...(halves.length === 2 ? Array(missing).fill('0') : []), ...tail];
  const nums = groups.map((g) => parseInt(g, 16));
  return nums.length === 8 && nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
    ? nums
    : undefined;
}

/** If `ip` is an IPv4-mapped IPv6 address (::ffff:a.b.c.d), return the embedded IPv4 text. */
export function embeddedIPv4(ip: string): string | undefined {
  const g = expandIPv6(ip);
  if (!g) return undefined;
  const isMapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff;
  if (!isMapped) return undefined;
  const hi = g[6] as number;
  const lo = g[7] as number;
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** True if connecting to this address could reach a non-public network. Unknown input => true. */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return true; // not an IP literal (incl. zone ids like fe80::1%eth0) => fail closed
  if (family === 4) return blocked.check(ip, 'ipv4');
  const mapped = embeddedIPv4(ip);
  if (mapped) return blocked.check(mapped, 'ipv4');
  return blocked.check(ip, 'ipv6');
}
