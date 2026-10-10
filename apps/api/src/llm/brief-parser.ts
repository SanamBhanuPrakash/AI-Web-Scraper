import type { BriefSection } from '../shared.js';
import { stripInvisible } from '../pipeline/clean.js';
import type { Finding } from './deep.js';
import { normalizeForMatch } from './grounding.js';
import type { SummaryEvent } from './summary-parser.js';

const LABELS = [
  'TLDR',
  'TL;DR',
  'OVERVIEW',
  'TAKEAWAY',
  'SECTION',
  'FACT',
  'CAVEAT',
  'NEXT',
] as const;
const LABEL_ALT = LABELS.join('|');
const LABEL_RE = new RegExp(
  `^\\s*(?:[-*•]\\s*)?\\**\\s*(${LABEL_ALT})\\s*\\**\\s*:\\s*\\**\\s*(.*)$`,
  'i',
);
const LABEL_START_RE = new RegExp(`^\\s*(?:[-*•]\\s*)?\\**\\s*(?:${LABEL_ALT})\\s*\\**\\s*:`, 'i');
const REF_SPLIT_RE = /\s*\|\s*(?:REFS?|SOURCES?|NOTES?)\s*:\s*/i;

const SECTION_OF: Record<string, BriefSection> = {
  OVERVIEW: 'overview',
  TAKEAWAY: 'takeaway',
  SECTION: 'section',
  FACT: 'fact',
  CAVEAT: 'caveat',
  NEXT: 'next',
};

/** A takeaway, fact, caveat or next step that restates (nearly) the same words as an earlier line is dropped. */
const REPEAT_SHARE = 0.75;
const MAX_POINTS = 40;
const MAX_TEXT = 900;

const clean = (s: string, max: number): string =>
  stripInvisible(s).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Note ids in a REF clause: "3", "3, 7", "[3][7]". Anything that is not a number is ignored. */
export function parseRefs(s: string): number[] {
  return [...s.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => n > 0 && n < 1000);
}

/**
 * Incremental parser for the writer's line protocol. The evidence for a line is taken from the verified notes
 * it cites, not from anything the writer typed, so a "grounded" quote here was checked against the page before
 * the writer ran. A line that cites nothing valid simply has no evidence (and is shown without a Source marker).
 */
export class BriefParser {
  private buffer = '';
  private current: { label: string; text: string } | undefined;
  private emitted = 0;
  private emittedTldr = false;
  private readonly byId: Map<number, Finding>;
  private readonly seen: Array<Set<string>> = [];

  constructor(findings: Finding[]) {
    this.byId = new Map(findings.map((f) => [f.id, f]));
  }

  push(chunk: string): SummaryEvent[] {
    this.buffer += chunk;
    const events: SummaryEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      this.consume(line, events);
    }
    if (this.current && LABEL_START_RE.test(this.buffer)) this.flush(events);
    return events;
  }

  end(): SummaryEvent[] {
    const events: SummaryEvent[] = [];
    if (this.buffer.trim()) this.consume(this.buffer.replace(/\r$/, ''), events);
    this.buffer = '';
    this.flush(events);
    return events;
  }

  get hasContent(): boolean {
    return this.emittedTldr || this.emitted > 0;
  }

  /** True when almost all of the shorter line's words already occur in one earlier line. */
  private restates(words: Set<string>): boolean {
    if (words.size < 3) return false;
    return this.seen.some((prev) => {
      let inter = 0;
      for (const w of words) if (prev.has(w)) inter++;
      return inter / Math.min(words.size, Math.max(1, prev.size)) >= REPEAT_SHARE;
    });
  }

  private consume(line: string, events: SummaryEvent[]): void {
    const m = LABEL_RE.exec(line);
    if (m) {
      this.flush(events);
      this.current = { label: m[1]!.toUpperCase().replace('TL;DR', 'TLDR'), text: m[2] ?? '' };
    } else if (this.current && line.trim()) {
      this.current.text += ` ${line.trim()}`;
    }
  }

  private flush(events: SummaryEvent[]): void {
    const cur = this.current;
    this.current = undefined;
    if (!cur) return;
    const [body = '', refText = ''] = cur.text.split(REF_SPLIT_RE);

    if (cur.label === 'TLDR') {
      const text = clean(body, MAX_TEXT);
      if (text && !this.emittedTldr) {
        this.emittedTldr = true;
        events.push({ type: 'tldr', text });
      }
      return;
    }
    const section = SECTION_OF[cur.label];
    if (!section || this.emitted >= MAX_POINTS) return;

    let heading: string | undefined;
    let text = body;
    if (section === 'section') {
      const at = body.indexOf('::');
      if (at !== -1) {
        heading = clean(body.slice(0, at), 120);
        text = body.slice(at + 2);
      }
    }
    text = clean(text, MAX_TEXT);
    if (!text) return;

    const wordSet = new Set(
      normalizeForMatch(text)
        .split(' ')
        .filter((w) => w.length > 2),
    );
    if (section !== 'overview' && section !== 'section' && this.restates(wordSet)) return;
    this.seen.push(wordSet);
    const cited = parseRefs(refText)
      .map((id) => this.byId.get(id))
      .find((f): f is Finding => f !== undefined);
    this.emitted++;
    events.push({
      type: 'point',
      kind: section === 'overview' || section === 'section' ? 'paragraph' : 'bullet',
      section,
      ...(heading ? { heading } : {}),
      text,
      ...(cited ? { quote: cited.quote } : {}),
      grounded: cited !== undefined,
    });
  }
}
