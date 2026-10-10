import type { LlmRequest } from './provider.js';

/**
 * Offline stand-ins for the two passes of the detailed brief, so the whole feature (including verification
 * and evidence linking) runs and is tested with no API keys.
 */

const words = (s: string): string[] => s.split(/\s+/).filter(Boolean);
const clip = (s: string, n: number): string => words(s).slice(0, n).join(' ');

function pageSentences(req: LlmRequest): string[] {
  const page = /<page [^>]*>([\s\S]*?)<\/page>/.exec(req.user)?.[1] ?? req.user;
  return page
    .replace(/^\s*Title:.*$/m, '')
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => words(s).length >= 10);
}

/** Reading pass: extractive findings spread across the whole page, as the JSON the real model returns. */
export function generateNotes(req: LlmRequest): string {
  const sentences = pageSentences(req);
  const sections = ['Opening', 'Middle', 'Closing'];
  const count = Math.min(12, sentences.length);
  const findings = Array.from({ length: count }, (_, i) => {
    const s = sentences[Math.floor((i * sentences.length) / Math.max(1, count))] ?? sentences[0]!;
    return {
      section: sections[Math.min(2, Math.floor((i * 3) / Math.max(1, count)))],
      kind: 'claim',
      importance: i % 3 === 0 ? 5 : 3,
      statement: clip(s, 22),
      quote: clip(s, 20),
    };
  });
  return JSON.stringify({
    pageType: 'other',
    purpose: 'Offline demo reading of the page.',
    audience: '',
    thesis: sentences[0] ? clip(sentences[0], 30) : '',
    outline: sections.map((heading) => ({ heading, gist: 'A part of the page.' })),
    findings,
  });
}

/** Writing pass: arranges the verified notes into the brief line format, citing note ids. */
export function generateBrief(req: LlmRequest): string {
  const thesis = /^Thesis: (.*)$/m.exec(req.user)?.[1] ?? '';
  const notes = [...req.user.matchAll(/^\[(\d+)\] \([^)]*\) (.*)$/gm)].map((m) => ({
    id: m[1]!,
    text: m[2]!,
  }));
  const headings = [...req.user.matchAll(/^\d+\. (.*?) - /gm)].map((m) => m[1]!);
  if (notes.length === 0)
    return 'TLDR: There is not enough readable text on this page to summarize.\n';

  const lines = [
    `TLDR: ${clip(thesis || notes[0]!.text, 40)}`,
    `OVERVIEW: ${clip(thesis || notes[0]!.text, 50)}`,
  ];
  const count = Math.min(4, notes.length);
  for (let i = 0; i < count; i++) {
    const n = notes[Math.floor((i * notes.length) / count)]!;
    lines.push(`TAKEAWAY: ${clip(n.text, 24)} | REF: ${n.id}`);
  }
  headings.slice(0, 3).forEach((h, i) => {
    const n = notes[Math.min(notes.length - 1, Math.floor(((i + 0.5) * notes.length) / 3))]!;
    lines.push(`SECTION: ${h} :: ${clip(n.text, 30)} | REF: ${n.id}`);
  });
  return lines.join('\n') + '\n';
}
