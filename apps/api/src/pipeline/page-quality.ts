import type { ErrorCode } from '@digest/shared';
import { AppError } from '../lib/errors.js';

/**
 * Real-world pages that return HTTP 200 but are not the page the user asked for: bot challenges, cookie and
 * sign-in walls, "not found" pages with a success status, and sites that can never be read without an app or
 * an account. Summarizing these would produce a confident summary of the wrong thing, so we detect them and say so.
 */

const BOT_TITLE =
  /^(just a moment|attention required|access denied|checking your browser|please wait|security check|are you a (human|robot)|verify you are (a )?human|ddos protection|one more step|human verification|request blocked|you have been blocked)/i;
const BOT_TEXT =
  /(enable javascript and cookies to continue|checking (if|whether) the site connection is secure|verifying you are (a )?human|needs to review the security of your connection|unusual traffic from your (computer|network)|performing security verification)/i;
const CONSENT_TEXT =
  /(before you continue|we value your privacy|accept all cookies|manage (cookie )?(preferences|settings)|consent to (the use of )?cookies|your privacy choices|reject all)/i;
const LOGIN_TEXT =
  /(sign in to (continue|view|read)|log ?in to (continue|view|read)|create (a free )?account to (continue|read)|subscribe to (continue|read)|already a subscriber|this content is for (members|subscribers)|you've reached your (free )?article limit)/i;
const SOFT_404_TITLE =
  /(^|\W)(404|page not found|not found|no longer available|doesn'?t exist|does not exist|page can'?t be found)(\W|$)/i;

/** Pages shorter than this are suspected of being a wall or an error page rather than an article. */
const THIN_WORDS = 400;

/** Returns the error that best describes why this page is not real content, or undefined if it looks fine. */
export function classifyThinPage(
  title: string,
  text: string,
  wordCount: number,
): ErrorCode | undefined {
  const sample = text.slice(0, 3000);
  // A real article can mention these phrases; a challenge page has little else, so the body check needs a thin page.
  if (BOT_TITLE.test(title.trim()) || (wordCount < THIN_WORDS && BOT_TEXT.test(sample)))
    return 'blocked_by_site';
  if (wordCount >= THIN_WORDS) return undefined;
  if (SOFT_404_TITLE.test(title) || /\b(404|page not found)\b/i.test(sample.slice(0, 250)))
    return 'not_found';
  if (CONSENT_TEXT.test(sample) || LOGIN_TEXT.test(sample)) return 'access_wall';
  return undefined;
}

/** Cheap title + visible-text approximation of raw HTML, used when normal extraction found nothing. */
export function roughTitleAndText(html: string): { title: string; text: string } {
  // Every pattern here is bounded or replaced by an indexOf scan. This runs on raw attacker HTML before any
  // structural check, and unbounded "[^>]+" / lazy "[\s\S]*?" patterns backtrack quadratically when the closing
  // character is missing (a 400 KB page of "<" took 50 s).
  const title =
    /<title[^<>]{0,200}>([^<]{0,300})<\/title>/i
      .exec(html.slice(0, 100_000))?.[1]
      ?.replace(/\s+/g, ' ')
      .trim() ?? '';
  const text = stripTags(html.slice(0, 400_000))
    .replace(/&nbsp;|&amp;|&#\d{1,7};/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text };
}

const RAW_TEXT_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const asciiLower = (s: string): string =>
  s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** Remove tags, comments and script-like bodies in one linear pass (each step moves the cursor forward). */
function stripTags(html: string): string {
  const lower = asciiLower(html);
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    const next = html.charCodeAt(lt + 1);
    const startsTag =
      (next >= 65 && next <= 90) ||
      (next >= 97 && next <= 122) ||
      next === 47 ||
      next === 33 ||
      next === 63;
    if (!startsTag) {
      out.push('<');
      i = lt + 1;
      continue;
    }
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break; // unterminated comment swallows the rest, as in a browser
      out.push(' ');
      i = end + 3;
      continue;
    }
    let nameEnd = lt + 1;
    while (nameEnd < html.length && /[a-z]/.test(lower[nameEnd]!)) nameEnd++;
    const name = lower.slice(lt + 1, nameEnd);
    if (RAW_TEXT_TAGS.has(name)) {
      const close = lower.indexOf(`</${name}`, nameEnd);
      if (close === -1) break; // unterminated script/style: the rest is code, not text
      const gt = html.indexOf('>', close);
      out.push(' ');
      if (gt === -1) break;
      i = gt + 1;
      continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt === -1) break; // unterminated tag: nothing after it is readable text
    out.push(' ');
    i = gt + 1;
  }
  return out.join('');
}

/**
 * `<meta http-equiv="refresh" content="0; url=...">` redirects. Many consent, locale and tracking hops use it
 * instead of an HTTP redirect, and a fetcher that ignores it ends up summarizing an empty interstitial.
 */
export function findMetaRefresh(html: string, base: URL): URL | undefined {
  const head = html.slice(0, 20_000);
  const tag = /<meta[^<>]{1,2000}?http-equiv\s*=\s*["']?refresh["']?[^<>]{0,2000}>/i.exec(
    head,
  )?.[0];
  if (!tag) return undefined;
  // Pair the quotes properly: the value may itself contain the other quote character (content="2; URL='/x'").
  const attr = /content\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const content = attr?.[1] ?? attr?.[2];
  if (!content) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*[;,]\s*(?:url\s*=\s*)?['"]?([^'"]+?)['"]?\s*$/i.exec(content);
  if (!m || Number(m[1]) > 10) return undefined;
  try {
    return new URL(m[2]!, base);
  } catch {
    return undefined;
  }
}

const UNREADABLE: Array<{ hosts: string[]; name: string; reason: string }> = [
  {
    hosts: ['youtube.com', 'youtu.be', 'm.youtube.com', 'vimeo.com', 'tiktok.com'],
    name: 'Video',
    reason: 'Video pages have no article text to summarize.',
  },
  {
    hosts: ['x.com', 'twitter.com', 'facebook.com', 'instagram.com', 'threads.net', 'linkedin.com'],
    name: 'Social',
    reason: 'This site shows its content only inside an app or to signed-in users.',
  },
];

/** Sites that can never be read by a plain fetch: refuse immediately with a helpful sentence. */
export function assertReadableSite(url: URL): void {
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  for (const group of UNREADABLE) {
    if (group.hosts.some((h) => host === h || host.endsWith(`.${h}`))) {
      throw new AppError('access_wall', {
        detail: `unreadable-site:${host}`,
        userMessage: `${group.reason} Try a page from a publisher, blog or documentation site.`,
      });
    }
  }
}
