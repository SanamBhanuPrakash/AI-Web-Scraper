import { countWords } from './clean.js';

export interface BudgetResult {
  text: string;
  truncated: boolean;
  originalChars: number;
  usedChars: number;
  originalWords: number;
  usedWords: number;
}

const MARKER = '\n\n[… middle of the page omitted for length …]\n\n';

/** Cut at the last paragraph or sentence boundary before `limit`, searching back at most `slack` chars. */
function cutBefore(text: string, limit: number, slack = 600): string {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit);
  const para = window.lastIndexOf('\n');
  if (para > limit - slack) return window.slice(0, para);
  const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
  if (sentence > limit - slack) return window.slice(0, sentence + 1);
  return window;
}

function cutAfter(text: string, limit: number, slack = 600): string {
  if (text.length <= limit) return text;
  const window = text.slice(text.length - limit);
  const para = window.indexOf('\n');
  if (para !== -1 && para < slack) return window.slice(para + 1);
  const sentence = window.indexOf('. ');
  if (sentence !== -1 && sentence < slack) return window.slice(sentence + 2);
  return window;
}

/**
 * Fit text into a model's input budget. Keeps the head (intro, thesis) and tail (conclusion),
 * which carry most summary signal, and reports exactly what was dropped so the UI can say so.
 */
export function applyBudget(text: string, maxChars: number, headRatio = 0.7): BudgetResult {
  const originalWords = countWords(text);
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length, usedChars: text.length, originalWords, usedWords: originalWords };
  }
  const budget = Math.max(200, maxChars - MARKER.length);
  const head = cutBefore(text, Math.floor(budget * headRatio));
  const tail = cutAfter(text, budget - head.length);
  const out = `${head.trimEnd()}${MARKER}${tail.trimStart()}`;
  return {
    text: out,
    truncated: true,
    originalChars: text.length,
    usedChars: out.length,
    originalWords,
    usedWords: countWords(head) + countWords(tail),
  };
}
