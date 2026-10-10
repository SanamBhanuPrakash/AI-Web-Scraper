import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { applyBudget } from '../src/pipeline/budget.js';
import { cleanText, countWords, stripInvisible } from '../src/pipeline/clean.js';
import { decodeBody } from '../src/pipeline/decode.js';
import { assertReasonableMarkup, extractContent, htmlToText } from '../src/pipeline/extract.js';
import { PROSE } from './helpers.js';

const URL_ = new URL('https://blog.example.com/posts/scraping');
const paragraphs = PROSE.map((p) => `<p>${p}</p>`).join('\n');

const articlePage = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Fallback title</title>
<meta property="og:title" content="How Responsible Scrapers Work">
<meta property="og:site_name" content="Example Engineering Blog">
<meta name="author" content="Ada Lovelace">
<meta property="article:published_time" content="2026-03-04T10:00:00Z">
<link rel="icon" href="/static/favicon.png">
<link rel="canonical" href="https://blog.example.com/posts/scraping">
</head><body>
<header><nav><a href="/">Home</a> <a href="/about">About</a> <a href="/archive">Archive</a></nav></header>
<div class="cookie-banner">We use cookies. <button>Accept all cookies</button></div>
<main><article><h1>How Responsible Scrapers Work</h1>${paragraphs}
<ul><li>Identify yourself</li><li>Cap the download size</li></ul></article></main>
<aside><h3>Related articles</h3><ul><li><a href="/a">One</a></li><li><a href="/b">Two</a></li></ul></aside>
<footer>© 2026 Example. <a href="/privacy">Privacy</a></footer>
<script>window.track('pageview')</script></body></html>`;

describe('extractContent: article pages', () => {
  const r = extractContent(articlePage, URL_);
  it('extracts the main text without navigation, cookie banners, ads or scripts', () => {
    expect(r.text).toContain('Web scraping is the automated extraction of data');
    expect(r.text).toContain('Finally, results should be honest about their limits');
    for (const junk of [
      'Home',
      'Related articles',
      'Privacy',
      'window.track',
      'Accept all cookies',
    ]) {
      expect(r.text).not.toContain(junk);
    }
  });
  it('keeps paragraph structure and list items', () => {
    expect(r.text.split('\n\n').length).toBeGreaterThanOrEqual(5);
    expect(r.text).toMatch(/- Identify yourself/);
  });
  it('reads metadata', () => {
    expect(r.title).toBe('How Responsible Scrapers Work');
    expect(r.siteName).toBe('Example Engineering Blog');
    expect(r.author).toBe('Ada Lovelace');
    expect(r.publishedAt).toBe('2026-03-04T10:00:00.000Z');
    expect(r.lang).toBe('en');
    expect(r.favicon).toBe('https://blog.example.com/static/favicon.png');
    expect(r.canonical).toBe('https://blog.example.com/posts/scraping');
  });
  it('reports method, word count and high confidence', () => {
    expect(r.method).toBe('readability');
    expect(r.wordCount).toBeGreaterThan(180);
    expect(r.confidence).toBe('high');
  });
});

describe('extractContent: structure fallbacks', () => {
  it('handles a page with no <article>/<main> by falling back to the body', () => {
    const page = `<html><body><div id="menu"><a href="/1">Home</a><a href="/2">Shop</a></div><div>${paragraphs}</div></body></html>`;
    const r = extractContent(page, URL_);
    expect(r.text).toContain('Responsible scrapers identify themselves');
    expect(r.text).not.toContain('Shop');
  });
  it('handles an HTML fragment without <html>', () => {
    expect(extractContent(`<div>${paragraphs}</div>`, URL_).text).toContain(
      'Extraction itself is a ranking problem',
    );
  });
  it('falls back to the hostname when no title exists', () => {
    expect(extractContent(`<body>${paragraphs}</body>`, URL_).title).toBe('blog.example.com');
  });
});

describe('extractContent: JavaScript-rendered pages', () => {
  it('reports js_rendered for an empty SPA shell', () => {
    const shell = `<!doctype html><html><head><title>App</title><script src="/a.js"></script><script src="/b.js"></script><script src="/c.js"></script></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>`;
    expect(() => extractContent(shell, URL_)).toThrowError(
      expect.objectContaining({ code: 'js_rendered' }),
    );
  });

  it('salvages article text embedded as JSON-LD articleBody', () => {
    const body = PROSE.join(' ');
    const page = `<html><head><title>x</title><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      headline: 'Salvaged headline',
      author: { '@type': 'Person', name: 'Grace Hopper' },
      datePublished: '2026-01-02',
      articleBody: body,
    })}</script></head><body><div id="root"></div></body></html>`;
    const r = extractContent(page, URL_);
    expect(r.method).toBe('salvage');
    expect(r.confidence).toBe('low');
    expect(r.text).toContain('Web scraping is the automated extraction');
    expect(r.author).toBe('Grace Hopper');
  });

  it('salvages prose from Next.js __NEXT_DATA__ app state, including HTML bodies', () => {
    const data = {
      props: {
        pageProps: {
          post: {
            id: 'abc123',
            slug: 'x',
            body: `<p>${PROSE[0]}</p><p>${PROSE[1]}</p><p>${PROSE[2]}</p>`,
          },
        },
      },
    };
    const page = `<html><head><title>Next page</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
    const r = extractContent(page, URL_);
    expect(r.method).toBe('salvage');
    expect(r.text).toContain('Modern sites complicate that picture');
    expect(r.text).not.toContain('abc123');
  });

  it('reports insufficient_content (not js_rendered) for a genuinely short static page', () => {
    expect(() => extractContent('<html><body><p>Hi.</p></body></html>', URL_)).toThrowError(
      expect.objectContaining({ code: 'insufficient_content' }),
    );
  });
});

describe('prompt-injection hardening in extraction', () => {
  it('strips invisible and bidirectional characters that could hide instructions', () => {
    const hidden = '\u200b\u200d\u202e\u2066\ufeff\u{e0049}\u{e0067}';
    const page = `<html><body><article>${PROSE.map((p) => `<p>${p}${hidden}</p>`).join('')}</article></body></html>`;
    const r = extractContent(page, URL_);
    expect(
      /[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|[\u{e0000}-\u{e007f}]/u.test(r.text),
    ).toBe(false);
  });
  it('does not execute or keep script/style text', () => {
    const page = `<html><body><article>${paragraphs}<script>alert(1)</script><style>body{display:none}</style></article></body></html>`;
    const r = extractContent(page, URL_);
    expect(r.text).not.toMatch(/alert\(1\)|display:none/);
  });
});

describe('cleaning, counting, budgeting, decoding', () => {
  it('cleanText collapses whitespace, drops boilerplate lines and duplicate lines', () => {
    const out = cleanText('Share\n\n\n  Hello   world \u00a0 \nHello   world\nSubscribe\n\n\nBye');
    expect(out).toBe('Hello world\n\nBye');
  });
  it('stripInvisible removes zero-width, bidi and tag characters', () => {
    expect(stripInvisible('a\u200bb\u202ec\u{e0041}d\u0007e')).toBe('abcde');
  });
  it('countWords handles Latin and CJK text', () => {
    expect(countWords('one two  three')).toBe(3);
    expect(countWords('これは日本語の文章です')).toBeGreaterThan(2);
  });
  it('htmlToText keeps list structure and separates paragraphs', () => {
    expect(htmlToText('<p>A</p><p>B<br>C</p><ul><li>x</li><li>y</li></ul>')).toBe(
      'A\n\nB\nC\n\n- x\n- y',
    );
  });

  it('applyBudget leaves short text untouched', () => {
    const r = applyBudget('short text', 1000);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe('short text');
  });
  it('applyBudget keeps head and tail, marks truncation and respects the limit', () => {
    const text = Array.from(
      { length: 400 },
      (_, i) => `Paragraph ${i} has some filler words to take up space.`,
    ).join('\n');
    const r = applyBudget(text, 3000);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(3000);
    expect(r.text).toContain('Paragraph 0 ');
    expect(r.text).toContain('Paragraph 399 ');
    expect(r.text).toContain('omitted for length');
    expect(r.usedWords).toBeLessThan(r.originalWords);
  });

  it('decodeBody honours HTTP charset, meta charset and BOM', () => {
    const latin1 = Buffer.from('café', 'latin1');
    expect(decodeBody(latin1, 'text/html; charset=iso-8859-1').text).toBe('café');
    expect(
      decodeBody(Buffer.concat([Buffer.from('<meta charset="windows-1252">'), latin1])).text,
    ).toContain('café');
    expect(
      decodeBody(
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('héllo')]),
        'text/html; charset=iso-8859-1',
      ).text,
    ).toContain('héllo');
    expect(decodeBody(Buffer.from('plain utf8 ✓'), '').charset).toBe('utf-8');
  });
  it('decodeBody ignores bogus charset labels instead of throwing', () => {
    expect(decodeBody(Buffer.from('ok'), 'text/html; charset=not-a-charset').text).toBe('ok');
  });
});

describe('AppError contract', () => {
  it('extraction failures are typed AppErrors', () => {
    try {
      extractContent('<html><body></body></html>', URL_);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
    }
  });
});

describe('citation markers', () => {
  it('strips footnote markers and editorial notes but keeps normal brackets', () => {
    expect(
      cleanText(
        'Web scraping is old.[1] It is common, they say,[12] and legal[citation needed] in places.',
      ),
    ).toBe('Web scraping is old. It is common, they say, and legal in places.');
    // Code and normal brackets are left alone: a numeric marker only counts right after punctuation.
    expect(cleanText('Use arr[0] and arr[12] with [Optional] tags')).toBe(
      'Use arr[0] and arr[12] with [Optional] tags',
    );
  });
});

describe('adversarial markup stays bounded', () => {
  it('rejects 60,000 nested elements quickly with a typed error (parsing them takes minutes)', () => {
    const nested = '<div>'.repeat(60_000) + 'deep text '.repeat(40) + '</div>'.repeat(60_000);
    const started = Date.now();
    expect(() => extractContent('<html><body>' + nested + '</body></html>', URL_)).toThrowError(
      expect.objectContaining({ code: 'too_large' }),
    );
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('rejects a flood of tags but not large, sloppy, real-world markup', () => {
    expect(() => assertReasonableMarkup('<span>x</span>'.repeat(110_000))).toThrowError(
      expect.objectContaining({ code: 'too_large' }),
    );
    // 5,000 unclosed <p> and <li>, plus a big flat page: fine.
    expect(() =>
      assertReasonableMarkup('<ul>' + '<li>item'.repeat(5000) + '</ul>' + '<p>para'.repeat(5000)),
    ).not.toThrow();
    expect(() => assertReasonableMarkup('<div><p>text</p></div>'.repeat(20_000))).not.toThrow();
  });

  it('bounds CPU for a JSON blob full of HTML strings', () => {
    const items = Array.from({ length: 4000 }, (_, i) => ({
      body: `<p>${'Some readable words go here. '.repeat(8)}${i}</p>`,
    }));
    const page = `<html><head><title>x</title></head><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ items })}</script></body></html>`;
    const started = Date.now();
    try {
      extractContent(page, URL_);
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
