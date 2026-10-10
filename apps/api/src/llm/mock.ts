import type { LlmProvider, LlmRequest } from './provider.js';

export interface MockOptions {
  delayMs?: number;
  chunkSize?: number;
  /** Test hook: replace the generated text entirely. */
  script?: (req: LlmRequest) => string;
}

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const clip = (s: string, n: number): string => words(s).slice(0, n).join(' ');

/**
 * Deterministic offline "model" (F-28). It performs extractive summarization on the page text and
 * quotes real passages, so the entire product - including grounding checks - can be demonstrated
 * and tested with no API keys and no network.
 */
export function createMockProvider(opts: MockOptions = {}): LlmProvider {
  const delayMs = opts.delayMs ?? 0;
  const chunkSize = opts.chunkSize ?? 24;
  return {
    name: 'mock',
    model: 'extractive-demo',
    maxInputChars: 60_000,
    async *stream(req: LlmRequest) {
      const text = opts.script ? opts.script(req) : generate(req);
      for (let i = 0; i < text.length; i += chunkSize) {
        if (req.signal?.aborted) throw req.signal.reason ?? new DOMException('Aborted', 'AbortError');
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        yield text.slice(i, i + chunkSize);
      }
    },
  };
}

function generate(req: LlmRequest): string {
  const page = /<page [^>]*>([\s\S]*?)<\/page>/.exec(req.user)?.[1] ?? req.user;
  const body = page.replace(/^\s*Title:.*$/m, '').trim();
  const sentences = body.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => words(s).length >= 6);
  if (sentences.length === 0) return 'TLDR: There is not enough readable text on this page to summarize.\n';

  const spec = /exactly (\d+) (POINT|PARA) lines/.exec(req.system);
  const count = Math.max(1, Number(spec?.[1] ?? 3));
  const label = spec?.[2] ?? 'POINT';
  const tldrMax = Number(/at most (\d+) words>/.exec(req.system)?.[1] ?? 25);

  const lines = [`TLDR: ${clip(sentences[0]!, tldrMax)}`];
  for (let i = 0; i < count; i++) {
    const s = sentences[Math.floor((i * sentences.length) / count)] ?? sentences[0]!;
    const sentence = label === 'PARA' ? clip(`${s} ${sentences[(i + 1) % sentences.length] ?? ''}`, 60) : clip(s, 22);
    lines.push(`${label}: ${sentence} | QUOTE: "${clip(s, 10)}"`);
  }
  return lines.join('\n') + '\n';
}
