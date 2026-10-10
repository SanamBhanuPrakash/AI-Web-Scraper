/**
 * Invisible / direction-control / "tag" characters. They are a known way to hide instructions inside
 * a page that a human can't see but an LLM reads (prompt injection). We strip them before anything
 * reaches the model or the UI.
 */
// eslint-disable-next-line no-misleading-character-class
const INVISIBLE_RE = /[­؜᠎​-‏‪-‮⁠-⁯﻿￹-￻]|[\u{e0000}-\u{e007f}]/gu;
// C0/C1 control chars except \t and \n
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const BOILERPLATE_LINES = new Set([
  'share', 'tweet', 'subscribe', 'sign up', 'sign in', 'log in', 'login', 'skip to content', 'skip to main content',
  'read more', 'advertisement', 'advertisements', 'sponsored', 'accept all cookies', 'accept cookies',
  'cookie settings', 'menu', 'search', 'related articles', 'recommended', 'comments', 'print', 'email', 'follow us',
  'back to top', 'next', 'previous', 'loading...', 'loading…',
]);

export function stripInvisible(text: string): string {
  return text.replace(INVISIBLE_RE, '').replace(CONTROL_RE, '');
}

/** Normalize whitespace, drop obvious UI boilerplate lines and consecutive duplicates. */
export function cleanText(raw: string): string {
  const text = stripInvisible(raw).replace(/\r\n?/g, '\n').replace(/ /g, ' ');
  const out: string[] = [];
  let prev = '';
  for (const line of text.split('\n')) {
    const t = line.replace(/[ \t]+/g, ' ').trim();
    if (t === '') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      continue;
    }
    if (t.length < 28 && BOILERPLATE_LINES.has(t.toLowerCase().replace(/[.:!]+$/, ''))) continue;
    if (t === prev) continue; // consecutive duplicate
    out.push(t);
    prev = t;
  }
  while (out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });

/** Word count that also behaves sensibly for CJK text (which has no spaces). */
export function countWords(text: string): number {
  let n = 0;
  for (const seg of segmenter.segment(text)) if (seg.isWordLike) n++;
  return n;
}

export function readingMinutes(words: number): number {
  return Math.max(1, Math.round(words / 230));
}
