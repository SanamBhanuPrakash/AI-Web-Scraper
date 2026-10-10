import type { SummaryStreamEvent } from '@digest/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { App } from './App';
import { theme } from './theme';

const page = {
  url: 'https://example.com/post',
  finalUrl: 'https://example.com/post',
  title: 'How scrapers work',
  siteName: 'Example Blog',
  author: 'Ada Lovelace',
  publishedAt: '2026-03-04T10:00:00Z',
  wordCount: 1200,
  readingMinutes: 5,
  usedWords: 1200,
  truncated: false,
  confidence: 'high',
  extractionMethod: 'readability',
} as const;
const SOURCE =
  'Intro paragraph about the web.\nScrapers request a page over HTTP and then parse the markup carefully.\nClosing thoughts here.';
const done: SummaryStreamEvent = {
  type: 'done',
  stats: { summaryWords: 40, compressionRatio: 30, groundedPoints: 1, totalPoints: 2 },
  page: { usedWords: 1200, truncated: false },
  meta: {
    provider: 'gemini',
    model: 'gemini-test',
    promptVersion: 'v2',
    fallback: false,
    cached: false,
    timingsMs: { fetch: 100, extract: 50, llm: 1500, total: 1700 },
  },
};
const events: SummaryStreamEvent[] = [
  { type: 'phase', phase: 'fetching' },
  { type: 'meta', page, sourceText: SOURCE },
  { type: 'tldr', text: 'Scrapers fetch and parse pages.' },
  {
    type: 'point',
    kind: 'bullet',
    text: 'They request pages over HTTP.',
    quote: 'Scrapers request a page over HTTP',
    grounded: true,
  },
  {
    type: 'point',
    kind: 'bullet',
    text: 'They never fail.',
    quote: 'invented evidence that is not there',
    grounded: false,
  },
  done,
];

/** A fetch whose SSE stream the test controls event by event. */
function controllableFetch() {
  const enc = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start: (c) => (ctrl = c) });
  const fetchMock = vi.fn(
    async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  );
  return {
    fetchMock,
    push: (ev: SummaryStreamEvent) =>
      act(async () =>
        ctrl.enqueue(enc.encode(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)),
      ),
    close: () => act(async () => ctrl.close()),
  };
}

const errorResponse = (
  code: string,
  message: string,
  status = 422,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) =>
  new Response(
    JSON.stringify({ requestId: 'req-123', error: { code, message, retryable: false, ...extra } }),
    { status, headers: { 'content-type': 'application/json', ...headers } },
  );

beforeEach(() => {
  window.history.replaceState(null, '', '/');
});
afterEach(() => vi.unstubAllGlobals());

/** Render with the real Material theme, exactly as main.tsx does. */
const renderApp = () =>
  render(
    <ThemeProvider theme={theme} defaultMode="system" modeStorageKey="mui-mode">
      <CssBaseline enableColorScheme />
      <App />
    </ThemeProvider>,
  );

const address = () => screen.getByLabelText('Page address');

describe('first screen', () => {
  it('shows the headline, a labelled form and a real, labelled sample result', () => {
    renderApp();
    expect(
      screen.getByRole('heading', { level: 1, name: /summaries that show their evidence/i }),
    ).toBeInTheDocument();
    expect(address()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /summarize/i })).toBeEnabled();
    expect(screen.getByText(/sample result/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Detailed', pressed: true })).toBeInTheDocument();
    // Detailed has no other settings, so length and format are not offered until Quick is chosen.
    expect(screen.queryByRole('button', { name: 'Bullets' })).toBeNull();
  });

  it('has the landmarks and skip link a keyboard user needs', () => {
    renderApp();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /skip to the result/i })).toHaveAttribute(
      'href',
      '#result',
    );
  });

  it('pre-fills the form from ?url= without running it', () => {
    window.history.replaceState(
      null,
      '',
      '/?url=https%3A%2F%2Fexample.com%2Fa&length=long&format=paragraph',
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderApp();
    expect(address()).toHaveValue('https://example.com/a');
    expect(screen.getByRole('button', { name: 'Long', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Paragraph', pressed: true })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('"/" jumps to the address field unless you are already typing', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.keyboard('/');
    expect(address()).toHaveFocus();
    await user.type(address(), 'a/b');
    expect(address()).toHaveValue('a/b');
  });
});

describe('validation', () => {
  it('explains an invalid address inline, focuses the field and never calls the API', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'not a link at all');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/doesn't look like a web address/i);
    expect(address()).toHaveFocus();
    expect(address()).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock).not.toHaveBeenCalled();
    await user.type(address(), 'x');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); // clears as soon as you edit
  });
});

describe('summarizing', () => {
  it('goes Loading… -> streamed result with evidence, announces it, and records history', async () => {
    const c = controllableFetch();
    vi.stubGlobal('fetch', c.fetchMock);
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole('button', { name: 'Quick' })); // the classic single pass, Medium by default
    expect(screen.getByRole('button', { name: 'Medium', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bullets', pressed: true })).toBeInTheDocument();
    await user.type(address(), 'example.com/post');
    await user.click(screen.getByRole('button', { name: /summarize/i }));

    // Working: literal "Loading…", real step, the button became Cancel (same element, focus kept).
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(screen.getByText('Fetching and reading the page').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(
      JSON.parse(String((c.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)),
    ).toMatchObject({
      url: 'https://example.com/post',
      length: 'medium',
      format: 'bullets',
      includeText: true,
    });

    await c.push(events[0]!);
    await c.push(events[1]!);
    expect(
      await screen.findByRole('heading', { level: 2, name: /how scrapers work/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('Writing the summary').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );

    await c.push(events[2]!);
    await c.push(events[3]!);
    expect(screen.getByText('Scrapers fetch and parse pages.')).toBeInTheDocument();
    expect(screen.getByText('They request pages over HTTP.')).toBeInTheDocument();

    await c.push(events[4]!);
    await c.push(events[5]!);
    await c.close();

    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());
    expect(
      screen.getByText(/1 of 2 cited passages found in the page text/i, {
        selector: '.verify span',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/written by gemini-test in 1\.7 seconds/i)).toBeInTheDocument();
    // Reading is uninterrupted: no quote is on screen until asked for, but unchecked evidence is still marked.
    expect(screen.queryByText(/scrapers request a page over http/i, { selector: 'q' })).toBeNull();
    expect(
      screen.getByRole('button', { name: /point 2 \(not found in the page\)/i }),
    ).toHaveTextContent('Unchecked');

    // Evidence: open the passage in its real context, inline under the point.
    await user.click(screen.getByRole('button', { name: /show the cited passage for point 1$/i }));
    expect(
      screen.getByText(/scrapers request a page over http/i, { selector: 'q' }),
    ).toBeInTheDocument();
    const context = screen
      .getByText(/in the page/i, { selector: '.context__label' })
      .closest('.context') as HTMLElement;
    expect(
      within(context).getByText(/scrapers request a page over http/i, { selector: 'mark' }),
    ).toBeInTheDocument();

    // History and shareable URL.
    expect(JSON.parse(window.localStorage.getItem('digest:v1:recent')!)[0]).toMatchObject({
      url: 'https://example.com/post',
      title: 'How scrapers work',
      site: 'Example Blog',
    });
    expect(window.location.search).toContain('url=https%3A%2F%2Fexample.com%2Fpost');
  });

  it('detailed (the default): reads first, then shows a brief grouped into parts, with evidence on demand', async () => {
    const c = controllableFetch();
    vi.stubGlobal('fetch', c.fetchMock);
    const user = userEvent.setup();
    renderApp();

    // Detailed owns its structure, so it explains itself instead of offering length and format.
    expect(screen.getByText(/reads the whole page, checks every claim/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Paragraph' })).toBeNull();

    await user.type(address(), 'example.com/post');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    expect(
      JSON.parse(String((c.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)),
    ).toMatchObject({ length: 'detailed' });

    const point = (over: object) =>
      ({
        type: 'point',
        kind: 'bullet',
        grounded: false,
        ...over,
      }) as unknown as SummaryStreamEvent;

    await c.push({ type: 'phase', phase: 'fetching' });
    await c.push({ type: 'meta', page, sourceText: SOURCE });
    await c.push({ type: 'phase', phase: 'understanding' });
    // Three real steps: the middle one is active while the page is being read and checked.
    expect(
      screen.getByText('Reading the whole page and checking the notes').closest('li'),
    ).toHaveAttribute('aria-current', 'step');
    await c.push({
      type: 'analysis',
      pageType: 'tutorial',
      audience: 'developers.',
      sections: 3,
      findings: 12,
    });
    expect(
      await screen.findByText(/read 3 sections and verified 12 findings/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Writing the brief').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );

    await c.push({ type: 'phase', phase: 'writing' });
    await c.push({ type: 'tldr', text: 'Scrapers fetch and parse pages.' });
    await c.push(
      point({ kind: 'paragraph', section: 'overview', text: 'A tutorial for developers.' }),
    );
    await c.push(
      point({
        section: 'takeaway',
        text: 'Fetching comes first.',
        quote: 'Scrapers request a page over HTTP',
        grounded: true,
      }),
    );
    await c.push(point({ section: 'takeaway', text: 'Parsing comes second.' }));
    await c.push(
      point({
        kind: 'paragraph',
        section: 'section',
        heading: 'Intro',
        text: 'Explains what the web is.',
        quote: 'Intro paragraph about the web.',
        grounded: true,
      }),
    );
    await c.push(point({ section: 'fact', text: 'Requests use HTTP.' }));
    await c.push(done);
    await c.close();
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    // One heading per part, in order, and what was understood about the page.
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Overview', 'Key takeaways', 'Section by section', 'Key facts']);
    expect(
      screen.getByText(/read in full as a tutorial for developers\. 3 sections, 12 findings/i),
    ).toBeInTheDocument();

    // Takeaways are numbered 1, 2 within their own part; sections show their name above the text.
    const takeaways = document.querySelectorAll('.brief__takeaway .point__n');
    expect([...takeaways].map((n) => n.textContent)).toEqual(['1', '2']);
    expect(document.querySelector('.point__heading')).toHaveTextContent('Intro');
    expect(document.querySelector('.brief__fact .point__n')).toBeNull();

    // Evidence works the same way inside the brief.
    expect(document.querySelectorAll('.evidence')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /show the cited passage for point 1$/i }));
    expect(
      screen.getByText(/scrapers request a page over http/i, { selector: 'q' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show the cited passage for "Intro"/i }));
    expect(document.querySelectorAll('.evidence')).toHaveLength(2);
  });

  it('shows the sections found while reading, then a jump bar and Markdown download for the brief', async () => {
    const c = controllableFetch();
    vi.stubGlobal('fetch', c.fetchMock);
    const scrollTo = vi.fn();
    Element.prototype.scrollIntoView = scrollTo;
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => {
      created.push(b as Blob);
      return 'blob:test';
    });
    URL.revokeObjectURL = vi.fn();
    const clicked: Array<{ download: string; href: string }> = [];
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download, href: this.href });
    });

    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'example.com/post');
    await user.click(screen.getByRole('button', { name: /summarize/i }));

    const point = (over: object) =>
      ({
        type: 'point',
        kind: 'bullet',
        grounded: false,
        ...over,
      }) as unknown as SummaryStreamEvent;
    await c.push({ type: 'meta', page, sourceText: SOURCE });
    await c.push({ type: 'phase', phase: 'understanding' });
    await c.push({
      type: 'analysis',
      pageType: 'tutorial',
      sections: 3,
      findings: 12,
      outline: ['Intro', 'Setup', 'Wrap up'],
    });
    // While the brief is being written, the reader already sees what the page contains.
    const found = await screen.findByRole('list', { name: /sections found on the page/i });
    expect(
      within(found)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Intro', 'Setup', 'Wrap up']);

    await c.push({ type: 'tldr', text: 'Scrapers fetch and parse pages.' });
    await c.push(point({ kind: 'paragraph', section: 'overview', text: 'A tutorial.' }));
    await c.push(point({ section: 'takeaway', text: 'Fetching comes first.' }));
    await c.push(
      point({ kind: 'paragraph', section: 'section', heading: 'Intro', text: 'About the intro.' }),
    );
    await c.push(point({ section: 'fact', text: 'Requests use HTTP.' }));
    await c.push(done);
    await c.close();
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    // Jump bar: one link per part, the first is current, and choosing one scrolls and focuses its heading.
    const nav = screen.getByRole('navigation', { name: /parts of this brief/i });
    const links = within(nav).getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Overview',
      'Key takeaways',
      'Section by section',
      'Key facts',
    ]);
    expect(links[0]).toHaveAttribute('aria-current', 'location');
    await user.click(links[3]!);
    expect(scrollTo).toHaveBeenCalled();
    expect(links[3]).toHaveAttribute('aria-current', 'location');
    expect(screen.getByRole('heading', { level: 3, name: 'Key facts' })).toHaveFocus();

    // Markdown download.
    await user.click(screen.getByRole('button', { name: 'Download .md' }));
    expect(clicked).toEqual([{ download: 'how-scrapers-work.md', href: 'blob:test' }]);
    expect(await created[0]!.text()).toContain('## Key takeaways');
    anchorClick.mockRestore();
  });

  it('a link pasted anywhere lands in the address field, but ordinary text and pasting into a field do not', async () => {
    renderApp();
    const paste = (text: string, target: Element = document.body) => {
      const ev = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
        clipboardData: { getData: () => string };
      };
      ev.clipboardData = { getData: () => text };
      act(() => {
        target.dispatchEvent(ev);
      });
      return ev;
    };
    paste('just some words');
    expect(address()).toHaveValue('');
    const ev = paste('Read this: https://example.com/article, it is great.');
    expect(ev.defaultPrevented).toBe(true);
    expect(address()).toHaveValue('https://example.com/article');
    expect(address()).toHaveFocus();
    // Pasting inside the field is the browser's own job.
    const inField = paste('https://other.example/page', address());
    expect(inField.defaultPrevented).toBe(false);
    expect(address()).toHaveValue('https://example.com/article');
  });

  it('warns about an unstated figure and can show or hide all evidence at once', async () => {
    const c = controllableFetch();
    vi.stubGlobal('fetch', c.fetchMock);
    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'example.com/post');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    const withFigure = {
      ...(events[3] as object),
      text: 'They cut load time by 40 percent.',
      unverifiedFigures: ['40'],
    } as unknown as SummaryStreamEvent;
    for (const e of [events[0]!, events[1]!, events[2]!, withFigure, events[4]!, events[5]!])
      await c.push(e);
    await c.close();

    expect(
      await screen.findByText(/check this figure: 40 is not stated in the page/i),
    ).toBeVisible();

    // Evidence is closed by default, and one button opens or closes all of it.
    expect(document.querySelectorAll('.evidence')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Show all evidence' }));
    expect(document.querySelectorAll('.evidence')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Hide all evidence' }));
    await waitFor(() => expect(document.querySelectorAll('.evidence')).toHaveLength(0));
  });

  it('moves focus to the result title when the summary completes', async () => {
    const c = controllableFetch();
    vi.stubGlobal('fetch', c.fetchMock);
    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'https://example.com/post');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    for (const ev of events) await c.push(ev);
    await c.close();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 2, name: /how scrapers work/i })).toHaveFocus(),
    );
  });

  it('can be cancelled with the button or Escape, and shows the sample again', async () => {
    const c = controllableFetch();
    vi.stubGlobal('fetch', c.fetchMock);
    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'https://example.com/post');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    await screen.findByText('Loading…');
    await user.keyboard('{Escape}');
    expect(await screen.findByText(/sample result/i)).toBeInTheDocument();
    expect(screen.getByText(/last request was cancelled/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /summarize/i })).toBeInTheDocument();
    await c.push(events[1]!); // late event from the aborted run must not resurrect it
    expect(screen.queryByRole('heading', { name: /how scrapers work/i })).not.toBeInTheDocument();
  });

  it('starting a second request replaces the first (no mixed results)', async () => {
    const first = controllableFetch();
    const second = controllableFetch();
    const f = vi
      .fn()
      .mockImplementationOnce(first.fetchMock)
      .mockImplementationOnce(second.fetchMock);
    vi.stubGlobal('fetch', f);
    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'https://example.com/post');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    await screen.findByText('Loading…');
    // Use an example link while working is not possible (disabled), so cancel then re-run.
    // A click right after starting is ignored on purpose (double-click guard), so wait it out.
    await new Promise((r) => setTimeout(r, 500));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    await second.push(events[1]!);
    expect(
      await screen.findByRole('heading', { level: 2, name: /how scrapers work/i }),
    ).toBeInTheDocument();
    await first.push({ type: 'meta', page: { ...page, title: 'STALE RESULT' } });
    expect(screen.queryByText('STALE RESULT')).not.toBeInTheDocument();
  });
});

describe('failures', () => {
  it('shows a specific, actionable error slip for a page that needs JavaScript', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        errorResponse('js_rendered', 'This page builds its content with JavaScript.'),
      ),
    );
    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'https://spa.example.com/');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    const slip = await screen.findByRole('alert', {}, { timeout: 3000 });
    expect(
      within(slip).getByRole('heading', { name: /this page needs javascript/i }),
    ).toBeInTheDocument();
    expect(within(slip).getByText(/builds its content with javascript/i)).toBeInTheDocument();
    expect(within(slip).getByRole('button', { name: /try another link/i })).toBeInTheDocument();
    expect(within(slip).queryByRole('button', { name: /^try again/i })).not.toBeInTheDocument(); // not retryable
    await user.click(within(slip).getByText(/details for support/i));
    expect(within(slip).getByText('req-123')).toBeInTheDocument();
    await user.click(within(slip).getByRole('button', { name: /try another link/i }));
    expect(address()).toHaveFocus();
  });

  it('offers a countdown retry when rate limited', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        errorResponse(
          'rate_limited',
          'Slow down.',
          429,
          { retryable: true, retryAfterSec: 3 },
          { 'retry-after': '3' },
        ),
      ),
    );
    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'https://example.com/post');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(retry).toBeDisabled();
    expect(retry).toHaveTextContent(/try again in \d+s/i);
  });

  it('reports a network failure without leaking technical errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'https://example.com/post');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    const slip = await screen.findByRole('alert');
    expect(within(slip).getByRole('heading')).toHaveTextContent(/can't reach the service/i);
    expect(slip).not.toHaveTextContent(/Failed to fetch|TypeError/);
    expect(within(slip).getByRole('button', { name: /try again/i })).toBeEnabled();
  });

  it('shows an interrupted stream as a retryable error', async () => {
    const c = controllableFetch();
    vi.stubGlobal('fetch', c.fetchMock);
    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'https://example.com/post');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    await c.push(events[1]!);
    await c.close(); // ends without a terminal event
    expect(await screen.findByRole('heading', { name: /connection dropped/i })).toBeInTheDocument();
  });
});

describe('rail', () => {
  it('runs an example in one click and lists recent summaries', async () => {
    const c = controllableFetch();
    vi.stubGlobal('fetch', c.fetchMock);
    const user = userEvent.setup();
    renderApp();
    await user.click(
      screen.getByRole('button', { name: /en\.wikipedia\.org\/wiki\/Web_scraping/i }),
    );
    await screen.findByText('Loading…');
    expect(
      JSON.parse(String((c.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))
        .url,
    ).toBe('https://en.wikipedia.org/wiki/Web_scraping');
  });

  it('shows and clears recent items', async () => {
    window.localStorage.setItem(
      'digest:v1:recent',
      JSON.stringify([
        {
          url: 'https://example.com/a',
          title: 'Earlier page',
          site: 'example.com',
          at: Date.now() - 3 * 60_000,
        },
      ]),
    );
    const user = userEvent.setup();
    renderApp();
    expect(screen.getByText('Earlier page')).toBeInTheDocument();
    expect(screen.getByText(/3 minutes ago/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText('Earlier page')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('digest:v1:recent')).toBeNull();
  });

  it('toggles the theme and remembers it', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: /switch to dark theme/i }));
    expect(document.documentElement).toHaveAttribute('data-dark');
    expect(window.localStorage.getItem('mui-mode')).toBe('dark');
    expect(screen.getByRole('button', { name: /switch to light theme/i })).toBeInTheDocument();
  });
});

describe('address field actions', () => {
  it('Clear empties the field and returns focus to it', async () => {
    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'https://example.com/a');
    await user.click(screen.getByRole('button', { name: 'Clear address' }));
    expect(address()).toHaveValue('');
    expect(address()).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Paste from clipboard' })).toBeInTheDocument();
  });

  it('Paste reads the clipboard into the field, trimmed', async () => {
    const user = userEvent.setup();
    renderApp();
    // user-event installs its own clipboard stub, so define ours afterwards.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => '  https://example.com/pasted  \n',
        writeText: async () => undefined,
      },
    });
    await user.click(screen.getByRole('button', { name: 'Paste from clipboard' }));
    await waitFor(() => expect(address()).toHaveValue('https://example.com/pasted'));
  });

  it('Paste does nothing harmful when clipboard access is denied', async () => {
    const user = userEvent.setup();
    renderApp();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => {
          throw new DOMException('denied', 'NotAllowedError');
        },
      },
    });
    await user.click(screen.getByRole('button', { name: 'Paste from clipboard' }));
    expect(address()).toHaveValue('');
  });
});

describe('summary language', () => {
  it('defaults to the page language and sends the chosen language to the API and the URL', async () => {
    const c = controllableFetch();
    vi.stubGlobal('fetch', c.fetchMock);
    const user = userEvent.setup();
    renderApp();
    const select = screen.getByLabelText('Summary language') as HTMLSelectElement;
    expect(select.value).toBe('');
    await user.selectOptions(select, 'hi');
    await user.type(address(), 'https://example.com/post');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    await screen.findByText('Loading…');
    const body = JSON.parse(
      String((c.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(body.language).toBe('hi');
    expect(window.location.search).toContain('lang=hi');
  });

  it('omits language entirely when "Same as the page" is selected', async () => {
    const c = controllableFetch();
    vi.stubGlobal('fetch', c.fetchMock);
    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'https://example.com/post');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    await screen.findByText('Loading…');
    const body = JSON.parse(
      String((c.fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect('language' in body).toBe(false);
  });

  it('is restored from ?lang=', () => {
    window.history.replaceState(null, '', '/?lang=es');
    renderApp();
    expect((screen.getByLabelText('Summary language') as HTMLSelectElement).value).toBe('es');
  });

  it('ignores unknown ?lang= values', () => {
    window.history.replaceState(null, '', '/?lang=zzz');
    renderApp();
    expect((screen.getByLabelText('Summary language') as HTMLSelectElement).value).toBe('');
  });
});

describe('right-to-left and mixed-script content', () => {
  it('marks user-derived text for automatic direction so Arabic and Hebrew pages read correctly', async () => {
    const c = controllableFetch();
    vi.stubGlobal('fetch', c.fetchMock);
    const user = userEvent.setup();
    renderApp();
    await user.type(address(), 'https://example.com/ar');
    await user.click(screen.getByRole('button', { name: /summarize/i }));
    for (const ev of events) await c.push(ev);
    await c.close();
    const title = await screen.findByRole('heading', { level: 2, name: /how scrapers work/i });
    expect(title).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('Scrapers fetch and parse pages.')).toHaveAttribute('dir', 'auto');
    expect(screen.getByText('They request pages over HTTP.')).toHaveAttribute('dir', 'auto');
  });
});
