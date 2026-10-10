// Concurrency check for the API. Run it against the e2e server (mock summarizer, fixture site), never against
// real AI quotas or third-party sites:
//   npm run e2e-server -w @digest/api        (terminal 1)
//   node scripts/burst.mjs [requests=200] [concurrency=50] [mode=unique|cached]   (terminal 2)
const [, , reqArg, concArg, modeArg] = process.argv;
const TOTAL = Number(reqArg ?? 200);
const CONCURRENCY = Number(concArg ?? 50);
const MODE = modeArg ?? 'unique';
const API = process.env.API_URL ?? 'http://127.0.0.1:8790';
const SITE = process.env.SITE_URL ?? 'http://127.0.0.1:8791';

const latencies = [];
const statuses = new Map();
let next = 0;

async function worker() {
  while (next < TOTAL) {
    const i = next++;
    const url = `${SITE}/article?i=${MODE === 'unique' ? i : 0}`;
    const t = performance.now();
    try {
      const res = await fetch(`${API}/api/summarize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, length: 'short' }),
      });
      await res.arrayBuffer();
      latencies.push(performance.now() - t);
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
    } catch {
      statuses.set('network-error', (statuses.get('network-error') ?? 0) + 1);
    }
  }
}

const q = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]?.toFixed(0) ?? 'n/a';
const t0 = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const seconds = (performance.now() - t0) / 1000;
latencies.sort((a, b) => a - b);

console.log(
  `requests=${TOTAL} concurrency=${CONCURRENCY} mode=${MODE} took=${seconds.toFixed(1)}s (${(TOTAL / seconds).toFixed(1)} req/s)`,
);
console.log('status codes:', Object.fromEntries(statuses));
console.log(
  `latency ms: p50=${q(latencies, 0.5)} p95=${q(latencies, 0.95)} p99=${q(latencies, 0.99)} max=${latencies.at(-1)?.toFixed(0)}`,
);
const bad = [...statuses].filter(
  ([s]) => s === 'network-error' || (typeof s === 'number' && s >= 500),
);
if (bad.length > 0) {
  console.error('FAIL: server errors or dropped connections under load');
  process.exit(1);
}
