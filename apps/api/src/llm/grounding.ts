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
/** Share of the quote's adjacent word pairs that must survive in the matched window (rejects scrambled words). */
const MIN_PAIR_SHARE = 0.6;

const NEGATIONS = new Set([
  'not',
  'no',
  'never',
  'without',
  'neither',
  'nor',
  'none',
  'cannot',
  't',
]);
/**
 * Words that change the meaning of a sentence when altered: any number, and negations ("t" is what is left
 * of "don't" after normalization). A fuzzy match must contain every one of them, otherwise "did not approve"
 * would be accepted as a quote of "did approve", and "50 million" as a quote of "5 million".
 */
const isCritical = (t: string): boolean => NEGATIONS.has(t) || /\p{N}/u.test(t);

/**
 * True if `quote` occurs in the source verbatim (after normalization), or - to tolerate a model
 * dropping an article or reordering punctuation - if a same-sized window of the source contains
 * at least 90% of the quote's tokens (multiset overlap).
 */
export function isQuoteGrounded(quote: string, index: GroundingIndex): boolean {
  const q = normalizeForMatch(quote);
  const qTokens = tokenize(q);
  const enough =
    qTokens.length >= MIN_QUOTE_TOKENS || (qTokens.length === 1 && q.length >= MIN_QUOTE_CHARS);
  if (!enough) return false; // too short to be meaningful evidence
  if (index.normalized.includes(q)) return true;
  if (qTokens.length < MIN_QUOTE_TOKENS) return false; // fuzzy matching needs several tokens
  if (new Set(qTokens).size < 3) return false; // "the the the the" is not evidence

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
  const critical = qTokens.filter(isCritical);
  const pairs = new Set<string>();
  for (let k = 0; k + 1 < size; k++) pairs.add(`${qTokens[k]} ${qTokens[k + 1]}`);
  for (let i = 0; i < src.length; i++) {
    add(src[i]!);
    if (i >= win) remove(src[i - win]!);
    if (i >= win - 1 && overlap >= threshold) {
      const window = src.slice(i - win + 1, i + 1);
      if (critical.some((t) => !window.includes(t))) continue;
      let kept = 0;
      for (let k = 0; k + 1 < window.length; k++)
        if (pairs.has(`${window[k]} ${window[k + 1]}`)) kept++;
      if (kept >= Math.ceil(pairs.size * MIN_PAIR_SHARE)) return true;
    }
  }
  return matchesInOrder(qTokens, src);
}

/** Longest run of skipped source words (a parenthetical, an aside) tolerated between two quoted words. */
const MAX_GAP = 25;

/**
 * Models often condense a quote by silently dropping a parenthetical or clause from the middle of a
 * sentence. This accepts such a quote when at least 90% of its words appear IN ORDER in the source with
 * only short gaps between them. Order and density make fabrication or reordering fail, so it stays strong
 * evidence while sparing honest summaries a false "not found".
 */
function matchesInOrder(qTokens: string[], src: string[]): boolean {
  const need = Math.ceil(qTokens.length * FUZZY_THRESHOLD);
  const firstFew = qTokens.slice(0, 3);
  const maxSpan = qTokens.length * 4 + 20;
  for (let s = 0; s < src.length; s++) {
    const startIdx = firstFew.indexOf(src[s]!);
    if (startIdx === -1) continue;
    let matched = 1;
    let qpos = startIdx + 1;
    let gap = 0;
    for (let i = s + 1; i < src.length && qpos < qTokens.length && i - s <= maxSpan; i++) {
      if (src[i] === qTokens[qpos]) {
        matched++;
        qpos++;
        gap = 0;
      } else if (++gap > MAX_GAP) {
        break;
      }
    }
    if (matched >= need) {
      // Only the ends of the quote may be unmatched; they must not hold a number or a negation.
      const skipped = [...qTokens.slice(0, startIdx), ...qTokens.slice(qpos)];
      if (!skipped.some(isCritical)) return true;
    }
  }
  return false;
}
