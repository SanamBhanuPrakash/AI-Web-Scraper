import type { BriefSection, PageInfo, SummaryPoint } from '@digest/shared';

/** The parts of a detailed brief, in reading order. Only `takeaway` is numbered. */
export const BRIEF_GROUPS: ReadonlyArray<{
  section: BriefSection;
  title: string;
  numbered: boolean;
}> = [
  { section: 'overview', title: 'Overview', numbered: false },
  { section: 'takeaway', title: 'Key takeaways', numbered: true },
  { section: 'section', title: 'Section by section', numbered: false },
  { section: 'fact', title: 'Key facts', numbered: false },
  { section: 'caveat', title: 'Caveats', numbered: false },
  { section: 'next', title: 'What to do next', numbered: false },
];

const evidenceLine = (p: SummaryPoint): string =>
  p.quote ? `   Passage${p.grounded ? '' : ' (not found in page)'}: "${p.quote}"` : '';

/** Plain-text version of a result for the clipboard. Includes the evidence so the copy stays checkable. */
export function summaryToText(
  page: PageInfo,
  tldr: string | undefined,
  points: SummaryPoint[],
): string {
  const lines: string[] = [page.title, page.finalUrl, ''];
  if (tldr) lines.push(tldr, '');

  if (points.some((p) => p.section !== undefined)) {
    for (const g of BRIEF_GROUPS) {
      const items = points.filter((p) => p.section === g.section);
      if (items.length === 0) continue;
      lines.push(g.title.toUpperCase());
      items.forEach((p, n) => {
        const head = p.heading ? `${p.heading}: ` : '';
        lines.push(g.numbered ? `${n + 1}. ${head}${p.text}` : `${head}${p.text}`);
        const ev = evidenceLine(p);
        if (ev) lines.push(ev);
      });
      lines.push('');
    }
    return lines.join('\n').trim() + '\n';
  }

  points.forEach((p, i) => {
    lines.push(points.length > 1 && p.kind === 'bullet' ? `${i + 1}. ${p.text}` : p.text);
    const ev = evidenceLine(p);
    if (ev) lines.push(ev);
  });
  return lines.join('\n').trim() + '\n';
}

export interface CurlParams {
  origin: string;
  url: string;
  length: string;
  format: string;
  language?: string | undefined;
}

/** The exact request the UI just made, as a command a developer can paste into a terminal. */
export function buildCurl({ origin, url, length, format, language }: CurlParams): string {
  const body = JSON.stringify({ url, length, format, ...(language ? { language } : {}) });
  const quoted = body.replace(/'/g, "'\\''");
  return [
    `curl -X POST ${origin}/api/summarize`,
    "  -H 'content-type: application/json'",
    `  -d '${quoted}'`,
  ].join(' \\\n');
}
