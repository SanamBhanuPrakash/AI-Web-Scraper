import type { PageInfo } from '@digest/shared';
import { AppError } from '../lib/errors.js';
import { applyBudget } from './budget.js';
import { cleanText, countWords, readingMinutes } from './clean.js';
import { decodeBody } from './decode.js';
import { extractContent, type ExtractResult } from './extract.js';
import type { SafeFetcher } from './safe-fetch.js';

export interface ScrapeResult {
  page: PageInfo;
  /** Full cleaned article text (for the "show extracted text" view and grounding checks). */
  fullText: string;
  /** Text trimmed to the model's input budget. */
  promptText: string;
  timingsMs: { fetch: number; extract: number };
}

/** URL in, clean budgeted text + metadata out. No LLM, no HTTP framework: easy to test in isolation. */
export async function scrapePage(
  url: string,
  deps: { fetcher: SafeFetcher },
  opts: { maxInputChars: number },
  signal?: AbortSignal,
): Promise<ScrapeResult> {
  const t0 = performance.now();
  const fetched = await deps.fetcher(url, signal);
  const t1 = performance.now();

  const { text: html } = decodeBody(fetched.body, fetched.contentType);
  const extracted =
    fetched.mime === 'text/plain'
      ? extractPlain(html, fetched.finalUrl)
      : extractContent(html, fetched.finalUrl);
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
  if (cleaned.length < 200) throw new AppError('insufficient_content', { detail: 'plain-text-too-short' });
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
