import type { SummaryStreamEvent } from '@digest/shared';
import { describe, expect, it } from 'vitest';
import { eventsFromJson, summarizeStream, SummarizeFailure } from './api';
import { formatDate, formatNumber, minutesSaved, relativeTime } from './format';
import { addHistory, clearHistory, loadHistory } from './history';
import { locateQuote, segmentParagraph } from './quote';
import { SseParser } from './sse';
import { initialState, reducer, stageOf } from './state';
import { buildCurl, markdownFileName, summaryToMarkdown } from './text';
import { displayUrl, normalizeInput } from './url';

describe('normalizeInput', () => {
  const ok = (s: string) => {
    const r = normalizeInput(s);
    return r.ok ? r.url : `ERR:${r.message}`;
  };
  it('adds https and trims', () => {
    expect(ok('  example.com/a b'.replace(' b', ''))).toBe('https://example.com/a');
    expect(ok('example.com')).toBe('https://example.com/');
  });
  it('keeps http and https, drops fragments', () => {
    expect(ok('http://example.com/x#y')).toBe('http://example.com/x');
  });
  it('extracts the first link from pasted text and strips trailing punctuation', () => {
    expect(ok('Read this: https://example.com/post, it is great.')).toBe(
      'https://example.com/post',
    );
    expect(ok('(see https://example.com/a?b=1)')).toBe('https://example.com/a?b=1');
    expect(ok('https://example.com/wiki/Foo_(bar).')).toBe('https://example.com/wiki/Foo_(bar)');
    expect(ok('(see https://en.wikipedia.org/wiki/Python_(programming_language))')).toBe(
      'https://en.wikipedia.org/wiki/Python_(programming_language)',
    );
    expect(ok('https://en.wikipedia.org/wiki/Python_(programming_language)')).toBe(
      'https://en.wikipedia.org/wiki/Python_(programming_language)',
    );
  });
  it('rejects empty, non-web and single-label inputs with a helpful message', () => {
    for (const bad of [
      '',
      '   ',
      'hello world',
      'javascript:alert(1)',
      'mailto:a@b.co',
      'ftp://example.com',
      'localhost',
      'intranet',
      'http://',
    ]) {
      expect(ok(bad), bad).toMatch(/^ERR:/);
    }
  });
  it('accepts host:port as a host, not a scheme', () => {
    expect(ok('example.com:8080/path')).toBe('https://example.com:8080/path');
  });
  it('displayUrl is compact', () => {
    expect(displayUrl('https://www.example.com/')).toBe('example.com');
    expect(displayUrl('https://en.wikipedia.org/wiki/Web_scraping?x=1')).toBe(
      'en.wikipedia.org/wiki/Web_scraping',
    );
  });
});

describe('SseParser', () => {
  it('is invariant to chunking and CRLF', () => {
    const raw =
      'event: a\ndata: {"x":1}\n\n: keep-alive\n\nevent: b\r\ndata: two\r\ndata: lines\r\n\r\n';
    const whole = new SseParser().push(raw);
    expect(whole).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: 'b', data: 'two\nlines' },
    ]);
    for (let size = 1; size < 9; size++) {
      const p = new SseParser();
      const out = (raw.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g')) ?? []).flatMap((c) =>
        p.push(c),
      );
      expect(out).toEqual(whole);
    }
  });
  it('flushes an unterminated last event and ignores comment-only blocks', () => {
    const p = new SseParser();
    expect(p.push(': ping\n\nevent: x\ndata: y')).toEqual([]);
    expect(p.end()).toEqual([{ event: 'x', data: 'y' }]);
  });
});

describe('locateQuote on short and unspaced quotes', () => {
  it('finds Chinese and Japanese quotes that have no spaces', () => {
    const zh = '前一段。网络爬虫是自动访问网页的程序。后一段。';
    const r = locateQuote(zh, '网络爬虫是自动访问网页的程序')!;
    expect(zh.slice(r.start, r.end)).toContain('网络爬虫是自动访问网页的程序');
    const ja = 'ウェブスクレイピングとは、ウェブサイトから情報を抽出する技術である。';
    expect(locateQuote(ja, 'ウェブサイトから情報を抽出する技術である')).toBeDefined();
  });
  it('finds a short English quote but refuses a trivially short one', () => {
    expect(locateQuote('Sales rose 42 percent last year.', '42 percent')).toBeDefined();
    expect(locateQuote('The cat sat.', 'cat')).toBeUndefined();
  });
});

describe('locateQuote / segmentParagraph', () => {
  const src =
    'First paragraph here.\nWeb scrapers, often called "bots", request pages over HTTP; then they parse the markup.\nLast one.';
  it('finds quotes ignoring case and punctuation', () => {
    const r = locateQuote(src, 'web scrapers often called bots request pages over HTTP')!;
    expect(src.slice(r.start, r.end)).toBe(
      'Web scrapers, often called "bots", request pages over HTTP',
    );
  });
  it('falls back to a recognisable piece when the quote is slightly altered', () => {
    const r = locateQuote(src, 'request pages over HTTP and then they quickly parse the markup')!;
    expect(r).toBeDefined();
    expect(src.slice(r.start, r.end).toLowerCase()).toContain('request pages over http');
  });
  it('returns undefined for missing or too-short quotes', () => {
    expect(locateQuote(src, 'completely absent passage of text')).toBeUndefined();
    expect(locateQuote(src, 'web')).toBeUndefined();
  });
  it('handles regex metacharacters and unicode', () => {
    expect(
      locateQuote(
        'Cost is $5.00 (approx.) for naïve café users',
        'cost is 5 00 approx for naïve café',
      ),
    ).toBeDefined();
  });
  it('segments a paragraph around highlight ranges', () => {
    const para = 'aaa BBB ccc';
    expect(segmentParagraph(para, 100, [{ start: 104, end: 107 }])).toEqual([
      { text: 'aaa ' },
      { text: 'BBB', mark: 0 },
      { text: ' ccc' },
    ]);
    expect(segmentParagraph(para, 100, [undefined, { start: 0, end: 5 }])).toEqual([
      { text: para },
    ]);
    expect(segmentParagraph(para, 100, [{ start: 98, end: 102 }])[0]).toEqual({
      text: 'aa',
      mark: 0,
    });
  });
});

describe('format helpers', () => {
  it('formats numbers, dates, savings, relative time', () => {
    expect(formatNumber(4177)).toBe('4,177');
    expect(formatDate('2026-03-04T10:00:00Z')).toBe('4 Mar 2026');
    expect(formatDate('nope')).toBeUndefined();
    expect(minutesSaved(4177, 63)).toBe(18);
    expect(minutesSaved(300, 60)).toBe(0);
    const now = Date.now();
    expect(relativeTime(now - 5_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(relativeTime(now - 26 * 3600_000, now)).toBe('yesterday');
  });
});

describe('history', () => {
  it('stores, dedupes, caps and clears', () => {
    for (let i = 0; i < 9; i++)
      addHistory({ url: `https://e.com/${i}`, title: `t${i}`, site: 'e.com', at: i });
    addHistory({ url: 'https://e.com/5', title: 'again', site: 'e.com', at: 99 });
    const items = loadHistory();
    expect(items).toHaveLength(6);
    expect(items[0]).toMatchObject({ url: 'https://e.com/5', title: 'again' });
    expect(items.filter((x) => x.url === 'https://e.com/5')).toHaveLength(1);
    expect(clearHistory()).toEqual([]);
    expect(loadHistory()).toEqual([]);
  });
  it('survives corrupt or blocked storage', () => {
    window.localStorage.setItem('digest:v1:recent', '{not json');
    expect(loadHistory()).toEqual([]);
    window.localStorage.setItem(
      'digest:v1:recent',
      JSON.stringify([{ url: 1 }, { url: 'u', title: 't', site: 's', at: 1 }]),
    );
    expect(loadHistory()).toHaveLength(1);
    const spy = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error('quota');
    };
    expect(() => addHistory({ url: 'x', title: 'x', site: 'x', at: 1 })).not.toThrow();
    Storage.prototype.setItem = spy;
  });
});

describe('text helpers', () => {
  const page = {
    url: 'https://e.com/a',
    finalUrl: 'https://e.com/a',
    title: 'A title',
    wordCount: 100,
    readingMinutes: 1,
    usedWords: 100,
    truncated: false,
    confidence: 'high',
    extractionMethod: 'readability',
  } as const;
  it('summaryToMarkdown keeps evidence, flags unverified passages and figures', () => {
    const t = summaryToMarkdown(page, 'In short.', [
      { kind: 'bullet', text: 'One', quote: 'q one', grounded: true },
      {
        kind: 'bullet',
        text: 'Two',
        quote: 'q two',
        grounded: false,
        unverifiedFigures: ['40'],
      },
    ]);
    expect(t).toContain('# A title');
    expect(t).toContain('> **In short.**');
    expect(t).toContain('1. One\n   > "q one"');
    expect(t).toContain('> "q two" (not found in the page)');
    expect(t).toContain('> Check: 40 not stated in the page.');
  });
  it('buildCurl produces a pasteable, shell-safe command', () => {
    const c = buildCurl({
      origin: 'https://digest.app',
      url: "https://e.com/it's",
      length: 'short',
      format: 'bullets',
    });
    expect(c).toContain('curl -X POST https://digest.app/api/summarize');
    expect(c).toContain(`it'\\''s`);
  });
});

describe('detailed mode state and text', () => {
  const req = { url: 'https://e.com/', length: 'detailed', format: 'bullets' } as const;
  const page = {
    url: 'u',
    finalUrl: 'https://e.com/a',
    title: 'Title',
    wordCount: 5,
    readingMinutes: 1,
    usedWords: 5,
    truncated: false,
    confidence: 'high',
    extractionMethod: 'readability',
  } as const;
  it('tracks the reading phase and what was understood, and shows "understanding" until then', () => {
    let s = reducer(initialState, { type: 'start', request: req });
    s = reducer(s, { type: 'event', event: { type: 'phase', phase: 'fetching' } });
    expect(stageOf(s)).toBe('fetching');
    s = reducer(s, { type: 'event', event: { type: 'meta', page } });
    s = reducer(s, { type: 'event', event: { type: 'phase', phase: 'understanding' } });
    expect(stageOf(s)).toBe('understanding');
    s = reducer(s, {
      type: 'event',
      event: { type: 'analysis', pageType: 'news', sections: 4, findings: 20 },
    });
    expect(s.analysis).toEqual({ pageType: 'news', sections: 4, findings: 20 });
    expect(stageOf(s)).toBe('writing');
  });
  it('copies a brief grouped under headings, numbering only the takeaways', () => {
    const text = summaryToMarkdown(page, 'The answer.', [
      { kind: 'paragraph', section: 'overview', text: 'What it is.', grounded: false },
      {
        kind: 'bullet',
        section: 'takeaway',
        text: 'First idea.',
        quote: 'a quote here ok',
        grounded: true,
      },
      { kind: 'bullet', section: 'takeaway', text: 'Second idea.', grounded: false },
      {
        kind: 'paragraph',
        section: 'section',
        heading: 'Intro',
        text: 'About the intro.',
        grounded: false,
      },
      { kind: 'bullet', section: 'fact', text: 'A fact.', grounded: false },
    ]);
    expect(text).toContain('## Overview\n\nWhat it is.');
    expect(text).toContain(
      '## Key takeaways\n\n1. First idea.\n   > "a quote here ok"\n2. Second idea.',
    );
    expect(text).toContain('## Section by section\n\n### Intro\n\nAbout the intro.');
    expect(text).toContain('## Key facts\n\n- A fact.');
    expect(text.indexOf('## Overview')).toBeLessThan(text.indexOf('## Key facts'));
    expect(text).not.toMatch(/\n{3,}/);
  });
});

describe('markdownFileName', () => {
  it('makes a short, safe, readable file name from the page title', () => {
    expect(markdownFileName('How Responsible Scrapers Work')).toBe(
      'how-responsible-scrapers-work.md',
    );
    expect(markdownFileName('Café: résumé / 2026?')).toBe('cafe-resume-2026.md');
    expect(markdownFileName('x'.repeat(200)).length).toBeLessThanOrEqual(63);
  });
  it('never returns an empty or path-like name', () => {
    expect(markdownFileName('')).toBe('summary.md');
    expect(markdownFileName('../../etc/passwd')).toBe('etc-passwd.md');
    expect(markdownFileName('日本語')).toBe('summary.md');
  });
});

describe('reducer', () => {
  const req = { url: 'https://e.com/', length: 'medium', format: 'bullets' } as const;
  const page = {
    url: 'u',
    finalUrl: 'u',
    title: 'T',
    wordCount: 500,
    readingMinutes: 2,
    usedWords: 500,
    truncated: false,
    confidence: 'high',
    extractionMethod: 'readability',
  } as const;
  it('walks idle -> working -> done and derives stages from real events', () => {
    let s = reducer(initialState, { type: 'start', request: req });
    expect(s.status).toBe('working');
    expect(stageOf(s)).toBe('fetching');
    s = reducer(s, { type: 'event', event: { type: 'meta', page, sourceText: 'src' } });
    expect(stageOf(s)).toBe('writing');
    s = reducer(s, { type: 'event', event: { type: 'tldr', text: 'x' } });
    s = reducer(s, {
      type: 'event',
      event: { type: 'point', kind: 'bullet', text: 'p', grounded: true },
    });
    expect(stageOf(s)).toBe('streaming');
    s = reducer(s, {
      type: 'event',
      event: {
        type: 'done',
        stats: { summaryWords: 5, compressionRatio: 100, groundedPoints: 1, totalPoints: 1 },
        page: { usedWords: 400, truncated: true },
        meta: {
          provider: 'p',
          model: 'm',
          promptVersion: 'v2',
          fallback: false,
          cached: false,
          timingsMs: { fetch: 1, extract: 1, llm: 1, total: 3 },
        },
      },
    });
    expect(s).toMatchObject({
      status: 'done',
      sourceText: 'src',
      page: { usedWords: 400, truncated: true },
    });
    expect(s.points).toHaveLength(1);
    expect('type' in s.points[0]!).toBe(false);
  });
  it('ignores events after cancel or finish and keeps the request on cancel', () => {
    let s = reducer(initialState, { type: 'start', request: req });
    s = reducer(s, { type: 'cancel' });
    expect(s).toMatchObject({ status: 'idle', cancelled: true, request: req });
    expect(reducer(s, { type: 'event', event: { type: 'tldr', text: 'late' } })).toBe(s);
  });
  it('records failures from events and from the transport', () => {
    let s = reducer(initialState, { type: 'start', request: req });
    s = reducer(s, {
      type: 'event',
      event: {
        type: 'error',
        requestId: 'r1',
        error: { code: 'js_rendered', message: 'm', retryable: false },
      },
    });
    expect(s).toMatchObject({ status: 'error', failure: { code: 'js_rendered', requestId: 'r1' } });
    s = reducer(reducer(initialState, { type: 'start', request: req }), {
      type: 'fail',
      failure: { code: 'network', message: 'n', retryable: true },
    });
    expect(s.status).toBe('error');
  });
  it('ignores a late transport error once the summary is finished', () => {
    let s = reducer(initialState, { type: 'start', request: req });
    s = { ...s, status: 'done' };
    const after = reducer(s, {
      type: 'fail',
      failure: { code: 'connection_lost', message: 'x', retryable: true },
    });
    expect(after.status).toBe('done');
  });
});

describe('summarizeStream', () => {
  const sse = (events: object[], extra = '') =>
    new Response(
      new ReadableStream({
        start(c) {
          const e = new TextEncoder();
          for (const ev of events)
            c.enqueue(
              e.encode(`event: ${(ev as { type: string }).type}\ndata: ${JSON.stringify(ev)}\n\n`),
            );
          if (extra) c.enqueue(e.encode(extra));
          c.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const params = { url: 'https://e.com/', length: 'medium', format: 'bullets' } as const;
  const page = {
    url: 'u',
    finalUrl: 'u',
    title: 'T',
    wordCount: 5,
    readingMinutes: 1,
    usedWords: 5,
    truncated: false,
    confidence: 'high',
    extractionMethod: 'readability',
  };
  const done = {
    type: 'done',
    stats: { summaryWords: 1, compressionRatio: 1, groundedPoints: 0, totalPoints: 0 },
    page: { usedWords: 5, truncated: false },
    meta: {
      provider: 'p',
      model: 'm',
      promptVersion: 'v2',
      fallback: false,
      cached: false,
      timingsMs: { fetch: 1, extract: 1, llm: 1, total: 3 },
    },
  };
  const collect = async (fetchImpl: typeof fetch, signal?: AbortSignal) => {
    const events: SummaryStreamEvent[] = [];
    await summarizeStream(params, (e) => events.push(e), signal, fetchImpl);
    return events;
  };
  const failureOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e instanceof SummarizeFailure ? e.info : e;
    }
  };

  it('delivers events in order and requests the page text', async () => {
    let sent: { body?: string; headers?: HeadersInit } = {};
    const events = await collect(async (_u, init) => {
      sent = {
        ...(init?.body ? { body: String(init.body) } : {}),
        ...(init?.headers ? { headers: init.headers } : {}),
      };
      return sse([
        { type: 'phase', phase: 'fetching' },
        { type: 'meta', page },
        { type: 'tldr', text: 'x' },
        done,
      ]);
    });
    expect(events.map((e) => e.type)).toEqual(['phase', 'meta', 'tldr', 'done']);
    expect(JSON.parse(sent.body!)).toMatchObject({ url: 'https://e.com/', includeText: true });
    expect((sent.headers as Record<string, string>)['accept']).toBe('text/event-stream');
  });
  it('keeps a finished summary when the socket resets after the done event', async () => {
    const enc = new TextEncoder();
    let sent = false;
    const stream = new ReadableStream({
      pull(c) {
        if (!sent) {
          sent = true;
          for (const e of [{ type: 'meta', page }, done])
            c.enqueue(
              enc.encode(`data: ${JSON.stringify(e)}

`),
            );
          return;
        }
        c.error(new TypeError('network error'));
      },
    });
    const events = await collect(
      async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    );
    expect(events.map((e) => e.type)).toEqual(['meta', 'done']);
  });
  it('turns a typed error event into a SummarizeFailure', async () => {
    const f = await failureOf(
      collect(async () =>
        sse([
          { type: 'meta', page },
          {
            type: 'error',
            requestId: 'r',
            error: { code: 'js_rendered', message: 'JS only', retryable: false },
          },
        ]),
      ),
    );
    expect(f).toMatchObject({ code: 'js_rendered', message: 'JS only', requestId: 'r' });
  });
  it('turns HTTP error bodies into failures, with Retry-After', async () => {
    const res = () =>
      new Response(
        JSON.stringify({
          requestId: 'r2',
          error: { code: 'rate_limited', message: 'slow', retryable: true },
        }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '17' } },
      );
    expect(await failureOf(collect(async () => res()))).toMatchObject({
      code: 'rate_limited',
      retryAfterSec: 17,
      retryable: true,
    });
  });
  it('reports non-JSON error pages, network errors and truncated streams distinctly', async () => {
    expect(
      await failureOf(collect(async () => new Response('<html>502</html>', { status: 502 }))),
    ).toMatchObject({ code: 'bad_response' });
    expect(
      await failureOf(
        collect(async () => {
          throw new TypeError('fetch failed');
        }),
      ),
    ).toMatchObject({ code: 'network' });
    expect(await failureOf(collect(async () => sse([{ type: 'meta', page }])))).toMatchObject({
      code: 'connection_lost',
    });
  });
  it('degrades to a one-shot JSON response', async () => {
    const body = {
      requestId: 'r',
      page,
      summary: { tldr: 'T', points: [{ kind: 'bullet', text: 'p', grounded: true }] },
      stats: done.stats,
      meta: done.meta,
    };
    const events = await collect(
      async () =>
        new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }),
    );
    expect(events.map((e) => e.type)).toEqual(['meta', 'tldr', 'point', 'done']);
    expect(eventsFromJson(body as never)).toHaveLength(4);
  });
  it('ignores malformed events but still completes', async () => {
    const events = await collect(async () =>
      sse([{ type: 'meta', page }, done], 'event: x\ndata: {not json}\n\n'),
    );
    expect(events.map((e) => e.type)).toEqual(['meta', 'done']);
  });
  it('rethrows AbortError so callers can tell cancellation from failure', async () => {
    const ac = new AbortController();
    ac.abort();
    const f = await failureOf(
      collect(async (_u, init) => {
        if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return sse([done]);
      }, ac.signal),
    );
    expect((f as DOMException).name).toBe('AbortError');
  });
});
