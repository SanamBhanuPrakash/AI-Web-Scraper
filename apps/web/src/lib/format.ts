const nf = new Intl.NumberFormat('en-US');
export const formatNumber = (n: number): string => nf.format(Math.round(n));

export function formatDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

export function relativeTime(then: number, now: number = Date.now()): string {
  const sec = Math.round((then - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  const abs = Math.abs(sec);
  if (abs < 60) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
  return rtf.format(Math.round(sec / 86400), 'day');
}

/** Reading time saved, in whole minutes, assuming 230 words per minute. Returns 0 when it is not worth mentioning. */
export function minutesSaved(wordsIn: number, wordsOut: number): number {
  const m = Math.round((wordsIn - wordsOut) / 230);
  return m >= 2 ? m : 0;
}
