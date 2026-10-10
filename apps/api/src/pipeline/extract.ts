/* eslint-disable @typescript-eslint/no-explicit-any -- linkedom's DOM is structurally typed; we only use a tiny surface. */
import { Readability } from '@mozilla/readability';
import type { Confidence, ExtractionMethod } from '@digest/shared';
import { parseHTML } from 'linkedom';
import { AppError } from '../lib/errors.js';
import { cleanText, countWords, stripInvisible } from './clean.js';

type N = any;

export interface ExtractResult {
  text: string;
  title: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  lang?: string;
  favicon?: string;
  canonical?: string;
  description?: string;
  wordCount: number;
  confidence: Confidence;
  method: ExtractionMethod;
}

/** Below this we refuse to summarize: there is nothing meaningful to summarize. */
export const MIN_CHARS = 200;
/** Readability output shorter than this is suspicious; we try fallbacks and keep the best. */
const GOOD_CHARS = 400;

const NOISE_SELECTOR =
  'script,style,noscript,template,iframe,svg,canvas,nav,header,footer,aside,form,button,select,dialog,[aria-hidden="true"],[hidden]';

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'ul', 'ol', 'li', 'blockquote', 'pre',
  'table', 'tr', 'figure', 'figcaption', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'details', 'summary',
]);
const PARAGRAPH_TAGS = new Set(['p', 'blockquote', 'pre', 'ul', 'ol', 'table', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas']);

/** Convert an HTML fragment to plain text that preserves paragraph and list structure. */
export function htmlToText(html: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`) as any;
  const parts: string[] = [];
  let trailingNewlines = 0; // tracked incrementally so this stays linear on large pages
  const write = (s: string): void => {
    if (s === '') return;
    parts.push(s);
    const m = /\n*$/.exec(s)![0].length;
    trailingNewlines = m === s.length ? trailingNewlines + m : m;
  };
  /** Ensure the output currently ends with at least `n` newlines (never stacks extra ones). */
  const breakTo = (n: 1 | 2): void => {
    if (parts.length === 0) return;
    if (trailingNewlines < n) write('\n'.repeat(n - trailingNewlines));
  };
  const walk = (node: N): void => {
    if (node.nodeType === 3) {
      write(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = String(node.tagName).toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === 'br') {
      write('\n');
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) breakTo(PARAGRAPH_TAGS.has(tag) ? 2 : 1);
    if (tag === 'li') write('- ');
    for (const child of Array.from(node.childNodes as ArrayLike<N>)) walk(child);
    if (tag === 'td' || tag === 'th') write(' ');
    if (block) breakTo(PARAGRAPH_TAGS.has(tag) ? 2 : 1);
  };
  walk(document.body);
  return cleanText(parts.join(''));
}

const squash = (s: string | null | undefined, max = 300): string | undefined => {
  if (!s) return undefined;
  const t = stripInvisible(s).replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
};

const metaContent = (doc: N, selector: string): string | undefined =>
  squash(doc.querySelector(selector)?.getAttribute('content'));

function toIsoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// ---------- JSON-LD / embedded JSON ("salvage") ----------

interface JsonLdInfo {
  articleBody?: string;
  description?: string;
  headline?: string;
  author?: string;
  datePublished?: string;
}

function walkJson(node: unknown, visit: (obj: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 12 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkJson(item, visit, depth + 1);
    return;
  }
  visit(node as Record<string, unknown>);
  for (const v of Object.values(node as Record<string, unknown>)) walkJson(v, visit, depth + 1);
}

function authorName(a: unknown): string | undefined {
  if (typeof a === 'string') return squash(a, 120);
  if (Array.isArray(a)) return squash(a.map(authorName).filter(Boolean).join(', '), 200);
  if (a && typeof a === 'object' && typeof (a as any).name === 'string') return squash((a as any).name, 120);
  return undefined;
}

function readJsonLd(doc: N): JsonLdInfo {
  const info: JsonLdInfo = {};
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]') as ArrayLike<N>)) {
    let data: unknown;
    try {
      data = JSON.parse(s.textContent ?? '');
    } catch {
      continue;
    }
    walkJson(data, (o) => {
      const t = o['@type'];
      const types = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
      if (!types.some((x) => /Article|BlogPosting|Report|NewsArticle|WebPage|TechArticle/i.test(x))) return;
      if (typeof o['articleBody'] === 'string' && (o['articleBody'] as string).length > (info.articleBody?.length ?? 0)) {
        info.articleBody = o['articleBody'] as string;
      }
      info.description ??= squash(typeof o['description'] === 'string' ? (o['description'] as string) : undefined, 600);
      info.headline ??= squash(typeof o['headline'] === 'string' ? (o['headline'] as string) : undefined);
      info.author ??= authorName(o['author']);
      info.datePublished ??= typeof o['datePublished'] === 'string' ? (o['datePublished'] as string) : undefined;
    });
  }
  return info;
}

/** Collect long, human-looking strings from embedded app-state JSON (Next.js etc.). */
function collectProse(root: unknown, budget = 60_000): string[] {
  const found = new Set<string>();
  let size = 0;
  walkJson(root, (obj) => {
    for (const v of Object.values(obj)) {
      if (typeof v !== 'string' || size > budget) continue;
      if (v.length < 120 || /^(https?:|data:|\/|[{[])/.test(v)) continue;
      const looksHtml = /<\/(p|div|li|h\d|ul|ol)>/i.test(v);
      const text = looksHtml ? htmlToText(v) : v;
      if ((text.match(/ /g)?.length ?? 0) < 15) continue; // not prose (ids, tokens, css, base64)
      if (found.has(text)) continue;
      found.add(text);
      size += text.length;
    }
  });
  return [...found];
}

function salvage(doc: N, ld: JsonLdInfo): string {
  const parts: string[] = [];
  if (ld.articleBody) parts.push(ld.articleBody.includes('<') ? htmlToText(ld.articleBody) : ld.articleBody);
  const scripts = Array.from(doc.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"]') as ArrayLike<N>).slice(0, 6);
  for (const s of scripts) {
    const raw = s.textContent ?? '';
    if (raw.length === 0 || raw.length > 1_500_000) continue;
    try {
      parts.push(...collectProse(JSON.parse(raw)));
    } catch {
      /* not JSON: ignore */
    }
  }
  for (const n of Array.from(doc.querySelectorAll('noscript') as ArrayLike<N>)) {
    const t = squash(n.textContent, 4000);
    if (t && t.length > 150 && !/enable javascript/i.test(t)) parts.push(t);
  }
  const og = metaContent(doc, 'meta[property="og:description"]') ?? metaContent(doc, 'meta[name="description"]');
  const desc = ld.description ?? og;
  if (desc && desc.length > 40) parts.push(desc);
  return cleanText(parts.join('\n\n'));
}

// ---------- structure-based fallbacks ----------

function removeNoise(root: N): void {
  for (const el of Array.from(root.querySelectorAll(NOISE_SELECTOR) as ArrayLike<N>)) el.remove();
}

function removeLinkDense(root: N): void {
  for (const el of Array.from(root.querySelectorAll('ul,ol,div,section,table') as ArrayLike<N>)) {
    const total = (el.textContent ?? '').trim().length;
    if (total === 0) continue;
    let linkText = 0;
    for (const a of Array.from(el.querySelectorAll('a') as ArrayLike<N>)) linkText += (a.textContent ?? '').trim().length;
    if (total < 1200 && linkText / total > 0.7) el.remove();
  }
}

function bestSemanticRoot(doc: N): N | undefined {
  const candidates = Array.from(doc.querySelectorAll('article, main, [role="main"], #content, #main, .post, .article') as ArrayLike<N>);
  let best: N | undefined;
  let bestLen = 0;
  for (const c of candidates) {
    const len = (c.textContent ?? '').length;
    if (len > bestLen) {
      best = c;
      bestLen = len;
    }
  }
  return best;
}

function linkDensityOfHtml(html: string): number {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`) as any;
  const total = (document.body.textContent ?? '').length || 1;
  let links = 0;
  for (const a of Array.from(document.querySelectorAll('a') as ArrayLike<N>)) links += (a.textContent ?? '').length;
  return links / total;
}

function looksLikeSpaShell(doc: N, textLen: number): boolean {
  const hasRoot = !!doc.querySelector('#root, #app, #__next, #__nuxt, [data-reactroot], [ng-version], app-root, #svelte');
  const scripts = doc.querySelectorAll('script[src]').length;
  const noscriptWarn = Array.from(doc.querySelectorAll('noscript') as ArrayLike<N>).some((n: N) =>
    /(enable|requires?|need).{0,40}javascript/i.test(n.textContent ?? ''),
  );
  return noscriptWarn || (textLen < MIN_CHARS && (hasRoot || scripts >= 3));
}

function pickConfidence(method: ExtractionMethod, words: number, linkDensity: number): Confidence {
  switch (method) {
    case 'readability':
      if (words >= 150 && linkDensity < 0.3) return 'high';
      return words >= 60 ? 'medium' : 'low';
    case 'semantic-fallback':
      return words >= 150 ? 'medium' : 'low';
    case 'body-fallback':
      return words >= 400 ? 'medium' : 'low';
    case 'salvage':
      return 'low';
  }
}

// ---------- public API ----------

export function extractContent(html: string, finalUrl: URL): ExtractResult {
  const wrapped = /<html[\s>]/i.test(html) ? html : `<!doctype html><html><body>${html}</body></html>`;
  const { document: doc } = parseHTML(wrapped) as any;

  // Metadata first: Readability mutates its own copy, never this one.
  const ld = readJsonLd(doc);
  const title =
    squash(metaContent(doc, 'meta[property="og:title"]') ?? metaContent(doc, 'meta[name="twitter:title"]') ?? doc.title) ??
    ld.headline ??
    squash(doc.querySelector('h1')?.textContent) ??
    finalUrl.hostname;
  const rawAuthor = metaContent(doc, 'meta[name="author"]') ?? metaContent(doc, 'meta[property="article:author"]');
  const author = rawAuthor && !/^https?:/i.test(rawAuthor) ? rawAuthor : ld.author;
  const publishedAt = toIsoDate(
    metaContent(doc, 'meta[property="article:published_time"]') ??
      metaContent(doc, 'meta[itemprop="datePublished"]') ??
      doc.querySelector('time[datetime]')?.getAttribute('datetime') ??
      ld.datePublished,
  );
  const lang = squash(doc.documentElement?.getAttribute('lang') ?? metaContent(doc, 'meta[property="og:locale"]'), 35);
  const siteName =
    metaContent(doc, 'meta[property="og:site_name"]') ??
    metaContent(doc, 'meta[name="application-name"]') ??
    finalUrl.hostname.replace(/^www\./, '');
  const canonical = squash(doc.querySelector('link[rel="canonical"]')?.getAttribute('href'), 500);
  const description = metaContent(doc, 'meta[property="og:description"]') ?? metaContent(doc, 'meta[name="description"]');
  let favicon: string | undefined;
  try {
    const href = doc.querySelector('link[rel~="icon"]')?.getAttribute('href');
    const u = new URL(href ?? '/favicon.ico', finalUrl);
    if (u.protocol === 'http:' || u.protocol === 'https:') favicon = u.toString();
  } catch {
    /* ignore bad favicon URL */
  }

  const base = {
    title,
    ...(siteName ? { siteName } : {}),
    ...(author ? { author } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(lang ? { lang } : {}),
    ...(favicon ? { favicon } : {}),
    ...(canonical ? { canonical } : {}),
    ...(description ? { description } : {}),
  };
  const done = (text: string, method: ExtractionMethod, linkDensity = 0): ExtractResult => {
    const wordCount = countWords(text);
    return { ...base, text, wordCount, method, confidence: pickConfidence(method, wordCount, linkDensity) };
  };

  // 1) Readability on a fresh parse (it destroys the DOM it is given).
  let readabilityText = '';
  let readabilityDensity = 0;
  try {
    const { document: doc2 } = parseHTML(wrapped) as any;
    const article = new Readability(doc2 as any, { charThreshold: 200 }).parse();
    if (article?.content) {
      readabilityText = htmlToText(article.content);
      readabilityDensity = linkDensityOfHtml(article.content);
      if (!base.author && article.byline) (base as any).author = squash(article.byline, 200);
    }
  } catch {
    /* Readability can throw on pathological DOMs; fall through to fallbacks */
  }
  if (readabilityText.length >= GOOD_CHARS) return done(readabilityText, 'readability', readabilityDensity);

  // 2) Semantic fallback, 3) body fallback — keep whichever is richest.
  let best: { text: string; method: ExtractionMethod } | undefined =
    readabilityText.length >= MIN_CHARS ? { text: readabilityText, method: 'readability' } : undefined;

  const { document: doc3 } = parseHTML(wrapped) as any;
  const semantic = bestSemanticRoot(doc3);
  if (semantic) {
    removeNoise(semantic);
    removeLinkDense(semantic);
    const t = htmlToText(semantic.innerHTML ?? '');
    if (t.length >= MIN_CHARS && t.length > (best?.text.length ?? 0)) best = { text: t, method: 'semantic-fallback' };
  }
  if (!best || best.text.length < GOOD_CHARS) {
    const { document: doc4 } = parseHTML(wrapped) as any;
    if (doc4.body) {
      removeNoise(doc4.body);
      removeLinkDense(doc4.body);
      const t = htmlToText(doc4.body.innerHTML ?? '');
      if (t.length >= MIN_CHARS && t.length > (best?.text.length ?? 0) * 1.5) best = { text: t, method: 'body-fallback' };
    }
  }
  if (best) return done(best.text, best.method, best.method === 'readability' ? readabilityDensity : 0.2);

  // 4) Salvage: content that ships in the payload but not in the visible DOM (JSON-LD, app-state, noscript, OG).
  const salvaged = salvage(doc, ld);
  if (salvaged.length >= MIN_CHARS) return done(salvaged, 'salvage');

  const bodyLen = (doc.body?.textContent ?? '').replace(/\s+/g, ' ').trim().length;
  throw new AppError(looksLikeSpaShell(doc, bodyLen) ? 'js_rendered' : 'insufficient_content', {
    detail: `chars:${Math.max(readabilityText.length, salvaged.length)}`,
  });
}
