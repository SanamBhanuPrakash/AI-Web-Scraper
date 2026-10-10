export interface Range {
  start: number;
  end: number;
}

const SEP = '[^\\p{L}\\p{N}]+';
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const tokensOf = (s: string): string[] => s.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

const MIN_SHORT_CHARS = 6;

function find(source: string, tokens: string[]): Range | undefined {
  if (tokens.length === 0) return undefined;
  const re = new RegExp(tokens.map(esc).join(SEP), 'iu');
  const m = re.exec(source);
  return m ? { start: m.index, end: m.index + m[0].length } : undefined;
}

/**
 * Find where a quoted passage sits in the page text so it can be highlighted. Punctuation and case
 * differences are ignored. If the model slightly altered the quote, fall back to its longest
 * recognisable pieces (the server already confirmed it was grounded).
 */
export function locateQuote(source: string, quote: string): Range | undefined {
  const tokens = tokensOf(quote);
  if (tokens.length < 3) {
    // Short quotes and scripts written without spaces (Chinese, Japanese, Thai) produce few tokens.
    // Accept an exact whole-quote match when it is long enough not to hit unrelated text.
    if (tokens.join('').length < MIN_SHORT_CHARS) return undefined;
    return find(source, tokens);
  }
  const whole = find(source, tokens);
  if (whole) return whole;
  const trimmed = tokens.length > 4 ? find(source, tokens.slice(1, -1)) : undefined;
  if (trimmed) return trimmed;
  for (const size of [8, 6, 5, 4]) {
    if (tokens.length < size) continue;
    for (let i = 0; i + size <= tokens.length; i++) {
      const hit = find(source, tokens.slice(i, i + size));
      if (hit) return hit;
    }
  }
  return undefined;
}

export interface Segment {
  text: string;
  /** Index into the `ranges` array when this text is inside a highlight. */
  mark?: number;
}

/** Split one paragraph (which starts at `offset` in the full text) into plain and highlighted segments. */
export function segmentParagraph(
  text: string,
  offset: number,
  ranges: Array<Range | undefined>,
): Segment[] {
  const end = offset + text.length;
  const hits = ranges
    .map((r, i) => ({ r, i }))
    .filter((x): x is { r: Range; i: number } => !!x.r && x.r.end > offset && x.r.start < end)
    .sort((a, b) => a.r.start - b.r.start);
  const out: Segment[] = [];
  let cursor = 0;
  for (const { r, i } of hits) {
    const s = Math.max(0, r.start - offset);
    const e = Math.min(text.length, r.end - offset);
    if (s < cursor) continue; // overlapping highlights: first one wins
    if (s > cursor) out.push({ text: text.slice(cursor, s) });
    out.push({ text: text.slice(s, e), mark: i });
    cursor = e;
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor) });
  return out.length > 0 ? out : [{ text }];
}

export interface Context {
  before: string;
  match: string;
  after: string;
  leadEllipsis: boolean;
  tailEllipsis: boolean;
}

/**
 * The paragraph around a located passage, clipped to roughly `radius` characters either side at word
 * boundaries. This is what the evidence button reveals inline, so the reader sees the passage in its
 * real surroundings without leaving the point they are reading.
 */
export function contextAround(text: string, range: Range, radius = 320): Context {
  const pStart = text.lastIndexOf('\n', range.start - 1) + 1;
  const nl = text.indexOf('\n', range.end);
  const pEnd = nl === -1 ? text.length : nl;

  let start = pStart;
  let end = pEnd;
  if (range.start - pStart > radius) {
    start = range.start - radius;
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < range.start) start = space + 1;
  }
  if (pEnd - range.end > radius) {
    end = range.end + radius;
    const space = text.lastIndexOf(' ', end);
    if (space > range.end) end = space;
  }
  return {
    before: text.slice(start, range.start),
    match: text.slice(range.start, range.end),
    after: text.slice(range.end, end),
    leadEllipsis: start > pStart,
    tailEllipsis: end < pEnd,
  };
}
