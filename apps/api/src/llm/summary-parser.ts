import { stripInvisible } from '../pipeline/clean.js';
import { isQuoteGrounded, type GroundingIndex } from './grounding.js';

export type SummaryEvent =
  | { type: 'tldr'; text: string }
  | { type: 'point'; kind: 'bullet' | 'paragraph'; text: string; quote?: string; grounded: boolean };

const MAX_ITEMS = 12;
const MAX_ITEM_CHARS = 1200;
const MAX_QUOTE_CHARS = 300;

const LABEL_RE = /^\s*(?:[-*•]\s*)?\**\s*(TLDR|TL;DR|POINT|PARA)\s*\**\s*:\s*\**\s*(.*)$/i;
const LABEL_START_RE = /^\s*(?:[-*•]\s*)?\**\s*(?:TLDR|TL;DR|POINT|PARA)\s*\**\s*:/i;
const QUOTE_SPLIT_RE = /\s*\|\s*QUOTE\s*:\s*/i;

const stripWrappingQuotes = (s: string): string =>
  s.trim().replace(/^["'“‘]+/, '').replace(/["'”’]+[.;]?$/, '').trim();

const clean = (s: string, max: number): string =>
  stripInvisible(s).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Incremental parser for the line-oriented summary format. It tolerates the usual model sloppiness
 * (markdown bullets, bold labels, wrapped lines, missing quotes) and never trusts the model to
 * follow the format: whatever it emits becomes plain text items, never markup.
 */
export class SummaryParser {
  private buffer = '';
  private current: { label: 'tldr' | 'point' | 'para'; text: string } | undefined;
  private emittedItems = 0;
  private emittedTldr = false;
  private unlabeled: string[] = [];

  constructor(private readonly grounding: GroundingIndex) {}

  push(chunk: string): SummaryEvent[] {
    this.buffer += chunk;
    const events: SummaryEvent[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, '');
      this.buffer = this.buffer.slice(nl + 1);
      this.consumeLine(line, events);
    }
    // A new label has started on the partial line: the previous item is complete, so emit it now
    // instead of waiting for this line to finish (shaves a line of latency off every item).
    if (this.current && LABEL_START_RE.test(this.buffer)) this.flushCurrent(events);
    return events;
  }

  end(): SummaryEvent[] {
    const events: SummaryEvent[] = [];
    if (this.buffer.trim() !== '') this.consumeLine(this.buffer, events);
    this.buffer = '';
    this.flushCurrent(events);
    // Model ignored the format entirely: still give the user a summary, as plain (ungrounded) text.
    if (!this.emittedTldr && this.emittedItems === 0 && this.unlabeled.length > 0) {
      const text = clean(this.unlabeled.join(' '), MAX_ITEM_CHARS * 2);
      if (text) events.push({ type: 'point', kind: 'paragraph', text, grounded: false });
      this.emittedItems++;
    }
    return events;
  }

  get hasContent(): boolean {
    return this.emittedTldr || this.emittedItems > 0;
  }

  private consumeLine(line: string, events: SummaryEvent[]): void {
    const m = LABEL_RE.exec(line);
    if (m) {
      this.flushCurrent(events);
      const label = m[1]!.toLowerCase();
      this.current = { label: label === 'point' ? 'point' : label === 'para' ? 'para' : 'tldr', text: m[2] ?? '' };
      return;
    }
    if (line.trim() === '') {
      this.flushCurrent(events);
      return;
    }
    if (this.current) this.current.text += ` ${line.trim()}`; // wrapped continuation of the current item
    else this.unlabeled.push(line.trim());
  }

  private flushCurrent(events: SummaryEvent[]): void {
    const cur = this.current;
    this.current = undefined;
    if (!cur) return;

    if (cur.label === 'tldr') {
      const text = clean(cur.text.split(QUOTE_SPLIT_RE)[0] ?? '', 600);
      if (text && !this.emittedTldr) {
        this.emittedTldr = true;
        events.push({ type: 'tldr', text });
      }
      return;
    }
    if (this.emittedItems >= MAX_ITEMS) return;

    const parts = cur.text.split(QUOTE_SPLIT_RE);
    const text = clean(parts[0] ?? '', MAX_ITEM_CHARS);
    if (!text) return;
    const rawQuote = parts.length > 1 ? clean(stripWrappingQuotes(parts.slice(1).join(' | ')), MAX_QUOTE_CHARS) : '';
    const grounded = rawQuote !== '' && isQuoteGrounded(rawQuote, this.grounding);
    this.emittedItems++;
    events.push({
      type: 'point',
      kind: cur.label === 'para' ? 'paragraph' : 'bullet',
      text,
      ...(rawQuote ? { quote: rawQuote } : {}),
      grounded,
    });
  }
}
