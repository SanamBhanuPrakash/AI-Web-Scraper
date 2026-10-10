import type { SummarizeResponse } from '@digest/shared';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Divider from '@mui/material/Divider';
import Fade from '@mui/material/Fade';
import Link from '@mui/material/Link';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { visuallyHidden } from '@mui/utils';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ErrorSlip } from './components/ErrorSlip';
import { Header } from './components/Header';
import { Progress } from './components/Progress';
import { Examples, Recent } from './components/RailLists';
import { Sheet, type SheetData } from './components/Sheet';
import { UrlForm } from './components/UrlForm';
import { useSummarize } from './hooks/useSummarize';
import type { Format, Length } from './lib/api';
import { formatDate } from './lib/format';
import { addHistory, clearHistory, loadHistory } from './lib/history';
import { LANGUAGE_VALUES } from './lib/languages';
import { stageOf } from './lib/state';
import { displayUrl, normalizeInput } from './lib/url';
import { SHAPE } from './theme';
import sampleJson from './sample.json';

const sample = sampleJson as unknown as SummarizeResponse & { capturedAt: string };
const SAMPLE_DATA: SheetData = {
  page: sample.page,
  tldr: sample.summary.tldr,
  analysis: sample.analysis,
  points: sample.summary.points,
  stats: sample.stats,
  meta: sample.meta,
  sourceText: sample.sourceText,
  sourceTruncated: true,
};

const LENGTHS: Length[] = ['short', 'medium', 'long', 'detailed'];
const FORMATS: Format[] = ['bullets', 'paragraph'];

function readParams(): { url: string; length: Length; format: Format; language: string } {
  const q = new URLSearchParams(window.location.search);
  const length = q.get('length');
  const format = q.get('format');
  const lang = q.get('lang') ?? '';
  return {
    url: q.get('url') ?? '',
    length: LENGTHS.includes(length as Length) ? (length as Length) : 'detailed',
    format: FORMATS.includes(format as Format) ? (format as Format) : 'bullets',
    language: LANGUAGE_VALUES.has(lang) ? lang : '',
  };
}

/** Keep the address bar shareable: `?url=...` pre-fills the form (it never auto-runs). */
function syncQuery(url: string, length: Length, format: Format, language: string): void {
  const q = new URLSearchParams({ url });
  if (length !== 'detailed') q.set('length', length);
  if (format !== 'bullets') q.set('format', format);
  if (language) q.set('lang', language);
  try {
    window.history.replaceState(null, '', `?${q.toString()}`);
  } catch {
    /* sandboxed or blocked: sharing the link is a nicety, not required */
  }
}

/**
 * After starting a summary, make sure the result is on screen. On a short window the control pane can be scrolled
 * so the result sits above the fold; on a phone it sits below the form. Only scroll when it is not already visible.
 */
/** Distance from the top of the screen at which a result is aligned on a phone (app bar height plus a gap). */
const RESULT_TOP = 80;

function revealResult(): void {
  const el = document.getElementById('result');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  // On a phone the form is long, so the result always goes to the top of the screen. On a wide screen it only
  // scrolls when the result is not already in view.
  const narrow = window.matchMedia('(max-width: 899.95px)').matches;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior = reduce ? 'auto' : 'smooth';
  if (narrow) {
    // Aim just under the app bar. Called again as the result grows, because the page is too short to scroll
    // that far at the moment of submitting.
    if (Math.abs(rect.top - RESULT_TOP) > 24)
      window.scrollTo({ top: window.scrollY + rect.top - RESULT_TOP, behavior });
    return;
  }
  if (rect.top >= 0 && rect.top < window.innerHeight * 0.7) return;
  el.scrollIntoView({ behavior, block: 'start' });
}

export function App() {
  const initial = useMemo(readParams, []);
  const { state, run, cancel } = useSummarize();
  const [value, setValue] = useState(initial.url);
  const [length, setLength] = useState<Length>(initial.length);
  const [format, setFormat] = useState<Format>(initial.format);
  const [language, setLanguage] = useState(initial.language);
  const [formError, setFormError] = useState<string | null>(null);
  const [recent, setRecent] = useState(loadHistory);
  const [announcement, setAnnouncement] = useState('');

  const inputRef = useRef<HTMLInputElement>(null);
  /** True once the person scrolls during a run: from then on the page never moves by itself. */
  const userMoved = useRef(false);
  useEffect(() => {
    const mark = () => {
      userMoved.current = true;
    };
    window.addEventListener('wheel', mark, { passive: true });
    window.addEventListener('touchmove', mark, { passive: true });
    return () => {
      window.removeEventListener('wheel', mark);
      window.removeEventListener('touchmove', mark);
    };
  }, []);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const working = state.status === 'working';

  const start = useCallback(
    (raw: string) => {
      const checked = normalizeInput(raw);
      if (!checked.ok) {
        setFormError(checked.message);
        inputRef.current?.focus();
        return;
      }
      setFormError(null);
      setValue(checked.url);
      syncQuery(checked.url, length, format, language);
      userMoved.current = false;
      revealResult();
      run({ url: checked.url, length, format, ...(language ? { language } : {}) });
    },
    [run, length, format, language],
  );

  const pick = (url: string) => {
    setValue(url);
    start(url);
  };

  // Record finished summaries, announce progress, and move focus to the result for keyboard and screen-reader users.
  const lastDone = useRef<string | null>(null);
  useEffect(() => {
    if (state.status === 'error' && state.failure)
      setAnnouncement(`Could not summarize. ${state.failure.message}`);
    else if (state.status === 'working') setAnnouncement('Loading. Fetching and reading the page.');
    else if (state.status === 'idle' && state.cancelled) setAnnouncement('Cancelled.');
    else if (state.status === 'done' && state.page) {
      const quoted = state.points.filter((p) => p.quote).length;
      const found = state.points.filter((p) => p.quote && p.grounded).length;
      setAnnouncement(
        `Summary ready. ${found} of ${quoted} cited passages found in the page text.`,
      );
      if (lastDone.current !== state.page.finalUrl + state.page.title) {
        lastDone.current = state.page.finalUrl + state.page.title;
        setRecent(
          addHistory({
            url: state.request?.url ?? state.page.url,
            title: state.page.title,
            site: state.page.siteName ?? displayUrl(state.page.finalUrl),
            at: Date.now(),
          }),
        );
        const active = document.activeElement;
        const userIsBusy =
          active instanceof HTMLInputElement ||
          active instanceof HTMLSelectElement ||
          (!!active &&
            !!document.getElementById('result')?.contains(active) &&
            active !== document.getElementById('result'));
        if (!userIsBusy) titleRef.current?.focus({ preventScroll: false });
      }
    }
  }, [state.status, state.cancelled, state.page, state.points, state.request, state.failure]);

  // Keep the result in place as it grows (first content, then the finished brief), unless the person scrolled.
  const hasPage = !!state.page;
  useEffect(() => {
    if (state.status === 'idle' || state.status === 'error' || userMoved.current) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(revealResult);
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [state.status, hasPage]);

  // Paste a link anywhere on the page: it lands in the address field (it never starts a request by itself).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      const editable =
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable);
      if (editable || working) return;
      const text = e.clipboardData?.getData('text')?.trim() ?? '';
      if (!/https?:\/\//i.test(text)) return; // ordinary text: leave the paste alone
      const checked = normalizeInput(text);
      if (!checked.ok) return;
      e.preventDefault();
      setValue(checked.url);
      setFormError(null);
      inputRef.current?.focus();
      setAnnouncement('Link pasted. Press Enter to summarize.');
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [working]);

  // Keyboard: "/" jumps to the address field, Escape cancels. Neither animates (they are repeated actions).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (e.key === 'Escape' && working) {
        cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [working, cancel]);

  const newLink = () => {
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  let result;
  let resultKey: string;
  if (state.status === 'error' && state.failure) {
    resultKey = 'error';
    result = (
      <ErrorSlip
        failure={state.failure}
        onRetry={() => {
          if (!state.request) return;
          // The retry button is about to unmount; keep keyboard focus inside the result region.
          document.getElementById('result')?.focus({ preventScroll: true });
          run(state.request);
        }}
        onNewLink={newLink}
      />
    );
  } else if (state.status === 'working') {
    const stage = stageOf(state);
    // Same key as the finished result, so the page is not remounted (and an open passage kept) when streaming ends.
    resultKey = state.page ? `result:${state.page.finalUrl}` : 'loading';
    const status = (
      <>
        <Progress
          stage={stage}
          deep={state.request?.length === 'detailed'}
          analysis={state.analysis}
        />
        {!state.tldr && (
          <Box className="skeleton" aria-hidden="true" sx={{ mt: 4 }}>
            <Skeleton variant="text" width="92%" height={28} />
            <Skeleton variant="text" width="78%" height={28} />
            <Skeleton variant="text" width="64%" height={28} />
          </Box>
        )}
      </>
    );
    result = state.page ? (
      <Sheet
        data={{
          page: state.page,
          tldr: state.tldr,
          points: state.points,
          analysis: state.analysis,
          sourceText: state.sourceText,
          sourceTruncated: state.sourceTruncated,
        }}
        live
        bottom={status}
      />
    ) : (
      <Box
        component="article"
        aria-busy="true"
        className="sheet"
        sx={{
          p: { xs: 3, sm: 5 },
          borderRadius: `${SHAPE.large}px`,
          border: 1,
          borderColor: 'divider',
          bgcolor: 'var(--mui-palette-surfaceContainerLow)',
        }}
      >
        {status}
      </Box>
    );
  } else if (state.status === 'done' && state.page) {
    resultKey = `result:${state.page.finalUrl}`;
    result = (
      <Sheet
        ref={titleRef}
        data={{
          page: state.page,
          tldr: state.tldr,
          points: state.points,
          stats: state.stats,
          meta: state.meta,
          analysis: state.analysis,
          sourceText: state.sourceText,
          sourceTruncated: state.sourceTruncated,
        }}
        {...(state.request ? { request: state.request } : {})}
      />
    );
  } else {
    resultKey = 'sample';
    result = (
      <Sheet
        data={SAMPLE_DATA}
        banner={
          <>
            <Typography
              variant="caption"
              className="sheet__banner"
              component="p"
              color="text.secondary"
              sx={{ m: 0 }}
            >
              <strong>Sample result.</strong> Real output for {displayUrl(sample.page.url)},
              captured {formatDate(sample.capturedAt)}. The page text is shortened here.
              {state.cancelled && ' The last request was cancelled.'}
            </Typography>
            <Divider sx={{ my: 2.5 }} />
          </>
        }
      />
    );
  }

  return (
    <Box sx={{ minHeight: '100dvh', bgcolor: 'background.default', color: 'text.primary' }}>
      <Link
        href="#result"
        className="no-print"
        sx={{
          position: 'absolute',
          left: 16,
          top: 12,
          zIndex: (t) => t.zIndex.tooltip,
          px: 2,
          py: 1.25,
          bgcolor: 'text.primary',
          color: 'background.default',
          borderRadius: 2,
          transform: 'translateY(-200%)',
          '&:focus-visible': { transform: 'none' },
        }}
      >
        Skip to the result
      </Link>
      <Header />
      <Container
        maxWidth="lg"
        component="main"
        sx={{ px: { xs: 2, sm: 3 }, pt: { xs: 2, md: 5 }, pb: { xs: 6, md: 9 } }}
      >
        <Box
          className="layout"
          sx={{
            display: 'grid',
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 5fr) minmax(0, 7fr)' },
            gap: { xs: 5, md: 8 },
            alignItems: 'start',
          }}
        >
          <Box
            component="section"
            aria-labelledby="headline"
            className="rail no-print"
            sx={{
              // Pinned only when the whole pane fits; on short windows it scrolls so Summarize is never stranded.
              '@media (min-width: 900px) and (min-height: 860px)': { position: 'sticky', top: 96 },
            }}
          >
            <Typography id="headline" component="h1" variant="h1">
              Summaries that show their evidence.
            </Typography>
            <Typography color="text.secondary" sx={{ mt: 2, maxWidth: '38ch' }}>
              Paste a public link. Each point cites a passage you can check in the page text.
            </Typography>
            <UrlForm
              value={value}
              onValue={(v) => {
                setValue(v);
                if (formError) setFormError(null);
              }}
              length={length}
              onLength={setLength}
              format={format}
              onFormat={setFormat}
              language={language}
              onLanguage={setLanguage}
              working={working}
              error={formError}
              onSubmit={() => start(value)}
              onCancel={cancel}
              inputRef={inputRef}
            />
            <Examples onPick={pick} disabled={working} />
            <Recent
              items={recent}
              onPick={pick}
              onClear={() => setRecent(clearHistory())}
              disabled={working}
            />
          </Box>
          <Box
            component="section"
            id="result"
            aria-label="Result"
            tabIndex={-1}
            sx={{ minWidth: 0, outline: 'none', scrollMarginTop: { xs: 80, md: 96 } }}
          >
            <Fade key={resultKey} in appear timeout={{ enter: 260 }}>
              <div>{result}</div>
            </Fade>
          </Box>
        </Box>
      </Container>
      <Container
        maxWidth="lg"
        component="footer"
        className="no-print"
        sx={{ px: { xs: 2, sm: 3 }, pb: 5 }}
      >
        <Divider sx={{ mb: 3 }} />
        <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 2 }}>
          <Typography variant="caption" color="text.secondary" sx={{ maxWidth: '60ch' }}>
            The text of each page you submit is sent to an AI provider (Google Gemini or Groq) to
            write the summary. Recent summaries stay in this browser only.
          </Typography>
          <Link
            href="/api/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
            variant="caption"
            color="text.secondary"
          >
            API description
          </Link>
        </Box>
      </Container>
      <Box role="status" aria-live="polite" sx={visuallyHidden}>
        {announcement}
      </Box>
    </Box>
  );
}
