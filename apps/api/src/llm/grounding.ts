/**
 * Grounding verification (F-24, ADR-014): the model is asked to back every point with a verbatim
 * quote. We *mechanically* check that the quote really occurs in the text the model was given.
 * This does not prove the point is true, but it proves the model is anchored to a real passage,
 * and makes fabricated "evidence" detectable instead of trusted.
 */

/** Lowercase, unify quotes/dashes, drop punctuation, collapse whitespace. Unicode letters/digits are kept. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const tokenize = (s: string): string[] => (s === '' ? [] : s.split(' '));

export interface GroundingIndex {
  normalized: string;
  tokens: string[];
}

export function indexSource(sourceText: string): GroundingIndex {
  const normalized = normalizeForMatch(sourceText);
  return { normalized, tokens: tokenize(normalized) };
}

export const MIN_QUOTE_TOKENS = 4;
/** Scripts without spaces (CJK) form one long token, so also accept enough characters. */
const MIN_QUOTE_CHARS = 12;
const FUZZY_THRESHOLD = 0.9;

/**
 * True if `quote` occurs in the source verbatim (after normalization), or - to tolerate a model
 * dropping an article or reordering punctuation - if a same-sized window of the source contains
 * at least 90% of the quote's tokens (multiset overlap).
 */
export function isQuoteGrounded(quote: string, index: GroundingIndex): boolean {
  const q = normalizeForMatch(quote);
  const qTokens = tokenize(q);
  const enough = qTokens.length >= MIN_QUOTE_TOKENS || (qTokens.length === 1 && q.length >= MIN_QUOTE_CHARS);
  if (!enough) return false; // too short to be meaningful evidence
  if (index.normalized.includes(q)) return true;
  if (qTokens.length < MIN_QUOTE_TOKENS) return false; // fuzzy matching needs several tokens

  const need = new Map<string, number>();
  for (const t of qTokens) need.set(t, (need.get(t) ?? 0) + 1);

  const size = qTokens.length;
  // Window is a bit larger than the quote so one or two inserted words in the source don't break the match.
  const win = size + Math.max(2, Math.ceil(size * 0.3));
  const src = index.tokens;
  if (src.length < win) return false;
  const have = new Map<string, number>();
  let overlap = 0;
  const add = (t: string): void => {
    const n = need.get(t);
    if (n === undefined) return;
    const h = have.get(t) ?? 0;
    if (h < n) overlap++;
    have.set(t, h + 1);
  };
  const remove = (t: string): void => {
    const n = need.get(t);
    if (n === undefined) return;
    const h = have.get(t) ?? 0;
    if (h <= n) overlap--;
    have.set(t, h - 1);
  };
  const threshold = Math.ceil(size * FUZZY_THRESHOLD);
  for (let i = 0; i < src.length; i++) {
    add(src[i]!);
    if (i >= win) remove(src[i - win]!);
    if (i >= win - 1 && overlap >= threshold) return true;
  }
  return false;
}
