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

/** The cited passage as a Markdown quote, with its status, so a pasted copy stays checkable. */
function evidence(p: SummaryPoint, indent: string): string[] {
  const out: string[] = [];
  if (p.quote) {
    out.push(`${indent}> "${p.quote}"${p.grounded ? '' : ' (not found in the page)'}`);
  }
  if (p.unverifiedFigures && p.unverifiedFigures.length > 0) {
    out.push(`${indent}> Check: ${p.unverifiedFigures.join(', ')} not stated in the page.`);
  }
  return out;
}

/**
 * A result as Markdown: it pastes cleanly into Notion, GitHub, Slack and most editors, and still reads
 * well as plain text. Evidence is included so the copy can be checked against the page.
 */
export function summaryToMarkdown(
  page: PageInfo,
  tldr: string | undefined,
  points: SummaryPoint[],
): string {
  const lines: string[] = [`# ${page.title}`, '', `Source: ${page.finalUrl}`, ''];
  if (tldr) lines.push(`> **${tldr}**`, '');

  if (points.some((p) => p.section !== undefined)) {
    for (const g of BRIEF_GROUPS) {
      const items = points.filter((p) => p.section === g.section);
      if (items.length === 0) continue;
      lines.push(`## ${g.title}`, '');
      items.forEach((p, n) => {
        if (g.section === 'overview') {
          lines.push(p.text, ...evidence(p, ''), '');
        } else if (g.section === 'section') {
          lines.push(`### ${p.heading ?? 'Section'}`, '', p.text, ...evidence(p, ''), '');
        } else {
          lines.push(g.numbered ? `${n + 1}. ${p.text}` : `- ${p.text}`, ...evidence(p, '   '));
        }
      });
      if (g.section !== 'overview' && g.section !== 'section') lines.push('');
    }
    return (
      lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim() + '\n'
    );
  }

  points.forEach((p, i) => {
    if (p.kind === 'bullet' && points.length > 1) {
      lines.push(`${i + 1}. ${p.text}`, ...evidence(p, '   '));
    } else {
      lines.push(p.text, ...evidence(p, ''), '');
    }
  });
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}

/** A safe file name for the downloaded brief: the page title, lower case, hyphenated, never empty. */
export function markdownFileName(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'summary'}.md`;
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
