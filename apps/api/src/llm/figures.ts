/**
 * Figure check: every number a summary states should appear in the page it summarizes. Quote grounding proves
 * a passage exists; it does not stop the model from writing "40%" in the point when the page says 14%. This is
 * the cheap, deterministic half of faithfulness: numbers cannot be paraphrased, so a mismatch is a real signal.
 */

const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

/** "1,600" "1.600" and "1600" all compare equal: separators are dropped. */
const digitsOf = (token: string): string => token.replace(/[.,]/g, '');

/** Numbers a reader would call a figure: two or more digits (counts like "3 steps" are often derived, not quoted). */
const isFigure = (digits: string): boolean => digits.length >= 2;

/** Every number in `text`, normalized for comparison. */
export function figureSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.normalize('NFKC').matchAll(NUMBER_RE)) out.add(digitsOf(m[0]));
  return out;
}

/** Figures stated in `summary` that do not occur in the source, as written (deduplicated, in order). */
export function unverifiedFigures(summary: string, source: Set<string>): string[] {
  const missing: string[] = [];
  for (const m of summary.normalize('NFKC').matchAll(NUMBER_RE)) {
    const digits = digitsOf(m[0]);
    if (isFigure(digits) && !source.has(digits) && !missing.includes(m[0].replace(/[.,]$/, ''))) {
      missing.push(m[0].replace(/[.,]$/, ''));
    }
  }
  return missing;
}
