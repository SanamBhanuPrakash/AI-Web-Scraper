import type { PageInfo } from '@digest/shared';
import { AppError } from '../lib/errors.js';
import { applyBudget } from './budget.js';
import { cleanText, countWords, readingMinutes } from './clean.js';
import { decodeBody } from './decode.js';
import { extractContent, type ExtractResult } from './extract.js';
import {
  assertReadableSite,
  classifyThinPage,
  findMetaRefresh,
  roughTitleAndText,
} from './page-quality.js';
import type { FetchedPage, SafeFetcher } from './safe-fetch.js';

export interface ScrapeResult {
  page: PageInfo;
  /** Full cleaned article text (for the "show extracted text" view and grounding checks). */
  fullText: string;
  /** Text trimmed to the model's input budget. */
  promptText: string;
  timingsMs: { fetch: number; extract: number };
}

/** An interstitial that only exists to redirect has almost no visible text. */
const TINY_PAGE_CHARS = 600;

/** URL in, clean budgeted text + metadata out. No LLM, no HTTP framework: easy to test in isolation. */
export async function scrapePage(
  url: string,
  deps: { fetcher: SafeFetcher },
  opts: { maxInputChars: number },
  signal?: AbortSignal,
): Promise<ScrapeResult> {
  const t0 = performance.now();
  try {
    assertReadableSite(new URL(url));
  } catch (err) {
    if (err instanceof AppError) throw err; // known-unreadable site: stop before any request
    /* unparseable input is reported by the fetcher's own validation */
  }

  let fetched: FetchedPage = await deps.fetcher(url, signal);
  let html = decodeBody(fetched.body, fetched.contentType).text;

  // Follow ONE <meta refresh> hop from a near-empty page (consent/locale/tracking interstitials). The fetcher
  // re-validates the target exactly like any other URL, so this cannot be used to reach private addresses.
  if (fetched.mime !== 'text/plain' && roughTitleAndText(html).text.length < TINY_PAGE_CHARS) {
    const next = findMetaRefresh(html, fetched.finalUrl);
    if (next && (next.protocol === 'http:' || next.protocol === 'https:')) {
      try {
        const hop = await deps.fetcher(next.toString(), signal);
        fetched = hop;
        html = decodeBody(hop.body, hop.contentType).text;
      } catch (err) {
        // The refresh target is a bonus. If it is dead or unreachable, still report on the page we already have.
        // A target the SSRF policy refuses stays an error, because that is worth telling the caller.
        if (signal?.aborted || (err instanceof AppError && err.code === 'blocked_url')) throw err;
      }
    }
  }
  assertReadableSite(fetched.finalUrl); // a short link may have redirected to a site we can't read
  const t1 = performance.now();

  let extracted: ExtractResult;
  try {
    extracted =
      fetched.mime === 'text/plain'
        ? extractPlain(html, fetched.finalUrl)
        : extractContent(html, fetched.finalUrl);
  } catch (err) {
    // "Nothing readable" often means a wall or error page. Say which, instead of a vague failure.
    if (
      err instanceof AppError &&
      (err.code === 'insufficient_content' || err.code === 'js_rendered')
    ) {
      const rough = roughTitleAndText(html);
      const verdict = classifyThinPage(rough.title, rough.text, countWords(rough.text));
      if (verdict) throw new AppError(verdict, { detail: `classified:${err.code}`, cause: err });
    }
    throw err;
  }
  const verdict = classifyThinPage(extracted.title, extracted.text, extracted.wordCount);
  if (verdict) throw new AppError(verdict, { detail: 'classified-after-extraction' });

  const budget = applyBudget(extracted.text, opts.maxInputChars);
  const t2 = performance.now();

  const page: PageInfo = {
    url: fetched.requestedUrl.toString(),
    finalUrl: fetched.finalUrl.toString(),
    title: extracted.title,
    ...(extracted.siteName ? { siteName: extracted.siteName } : {}),
    ...(extracted.author ? { author: extracted.author } : {}),
    ...(extracted.publishedAt ? { publishedAt: extracted.publishedAt } : {}),
    ...(extracted.lang ? { lang: extracted.lang } : {}),
    ...(extracted.favicon ? { favicon: extracted.favicon } : {}),
    wordCount: extracted.wordCount,
    readingMinutes: readingMinutes(extracted.wordCount),
    usedWords: budget.usedWords,
    truncated: budget.truncated,
    confidence: extracted.confidence,
    extractionMethod: extracted.method,
  };
  return {
    page,
    fullText: extracted.text,
    promptText: budget.text,
    timingsMs: { fetch: Math.round(t1 - t0), extract: Math.round(t2 - t1) },
  };
}

function extractPlain(text: string, finalUrl: URL): ExtractResult {
  const cleaned = cleanText(text);
  if (cleaned.length < 200)
    throw new AppError('insufficient_content', { detail: 'plain-text-too-short' });
  const wordCount = countWords(cleaned);
  return {
    text: cleaned,
    title: finalUrl.pathname.split('/').filter(Boolean).pop() ?? finalUrl.hostname,
    siteName: finalUrl.hostname.replace(/^www\./, ''),
    wordCount,
    confidence: wordCount >= 150 ? 'medium' : 'low',
    method: 'body-fallback',
  };
}
