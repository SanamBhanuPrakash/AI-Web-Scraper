export interface HistoryItem {
  url: string;
  title: string;
  site: string;
  at: number;
}

const KEY = 'digest:v1:recent';
const MAX = 6;

function read(): HistoryItem[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is HistoryItem =>
          !!x &&
          typeof x.url === 'string' &&
          typeof x.title === 'string' &&
          typeof x.site === 'string' &&
          typeof x.at === 'number',
      )
      .slice(0, MAX);
  } catch {
    return []; // storage blocked, private mode, or corrupted JSON
  }
}

function write(items: HistoryItem[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage unavailable: history is a convenience, never a requirement */
  }
}

export const loadHistory = (): HistoryItem[] => read();

export function addHistory(item: HistoryItem): HistoryItem[] {
  const next = [item, ...read().filter((x) => x.url !== item.url)].slice(0, MAX);
  write(next);
  return next;
}

export function clearHistory(): HistoryItem[] {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  return [];
}
