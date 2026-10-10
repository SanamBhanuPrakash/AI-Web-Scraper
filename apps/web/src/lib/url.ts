export type UrlCheck = { ok: true; url: string } | { ok: false; message: string };

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/i;
const SENTENCE_PUNCTUATION = '.,;:!?’”"\'';
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Remove punctuation that belongs to the sentence around a link, not to the link. A closing bracket is
 * kept when the link opened it, so ".../Python_(programming_language)" survives.
 */
function trimTrailing(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1] as string;
    if (SENTENCE_PUNCTUATION.includes(ch)) {
      end -= 1;
      continue;
    }
    const opener = CLOSERS[ch];
    if (opener === undefined) break;
    const body = url.slice(0, end);
    const opens = body.split(opener).length - 1;
    const closes = body.split(ch).length - 1;
    if (closes <= opens) break;
    end -= 1;
  }
  return url.slice(0, end);
}

/**
 * Turn whatever the user pasted into a clean http(s) address, or explain why not.
 * This is a convenience layer only. The server re-validates everything and is the real authority.
 */
export function normalizeInput(raw: string): UrlCheck {
  const input = raw.trim();
  if (input === '') return { ok: false, message: 'Enter the address of a web page to summarize.' };

  let candidate = input;
  if (/\s/.test(input)) {
    // Pasted a sentence or a "Title https://..." share string: use the first link in it.
    const found = URL_IN_TEXT.exec(input)?.[0];
    if (!found)
      return {
        ok: false,
        message: "That doesn't look like a web address. Paste a link that starts with https://.",
      };
    candidate = found;
  }
  candidate = trimTrailing(candidate);

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(candidate) && !/^[^:/?#]+:\d+([/?#]|$)/.test(candidate)) {
      return { ok: false, message: 'Only web pages (http or https) can be summarized.' };
    }
    candidate = `https://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, message: "That doesn't look like a web address. Check it and try again." };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: 'Only web pages (http or https) can be summarized.' };
  }
  if (!parsed.hostname.includes('.') && !/^\[.*\]$/.test(parsed.hostname)) {
    return { ok: false, message: "That doesn't look like a public web address." };
  }
  parsed.hash = '';
  return { ok: true, url: parsed.toString() };
}

/** "en.wikipedia.org/wiki/Web_scraping" style label for compact display. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.hostname.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}
