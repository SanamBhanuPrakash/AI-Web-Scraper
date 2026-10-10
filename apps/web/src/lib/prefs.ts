import type { Format, Length } from './api';

/**
 * The choices a person makes every visit (depth or length, format, summary language), remembered in this browser so
 * they do not have to be set again. A link's own `?length=` and similar always win over what is remembered.
 */
export interface Prefs {
  length: Length;
  format: Format;
  language: string;
}

const KEY = 'digest:v1:prefs';
const LENGTHS: readonly string[] = ['short', 'medium', 'long', 'detailed'];
const FORMATS: readonly string[] = ['bullets', 'paragraph'];

/** Whatever was saved and is still valid. Missing, corrupted or blocked storage simply yields nothing. */
export function loadPrefs(): Partial<Prefs> {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<Prefs> = {};
    if (typeof data['length'] === 'string' && LENGTHS.includes(data['length']))
      out.length = data['length'] as Length;
    if (typeof data['format'] === 'string' && FORMATS.includes(data['format']))
      out.format = data['format'] as Format;
    if (typeof data['language'] === 'string' && data['language'].length <= 35)
      out.language = data['language'];
    return out;
  } catch {
    return {};
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* private mode or quota: remembering is a convenience, never required */
  }
}
