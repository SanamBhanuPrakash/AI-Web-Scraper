import type { PageInfo, SummaryMeta, SummaryPoint, SummaryStats } from '@digest/shared';
import CheckIcon from '@mui/icons-material/CheckRounded';
import CheckCircleIcon from '@mui/icons-material/CheckCircleRounded';
import CopyIcon from '@mui/icons-material/ContentCopyRounded';
import DownloadIcon from '@mui/icons-material/FileDownloadOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNewRounded';
import ShareIcon from '@mui/icons-material/IosShareRounded';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Fade from '@mui/material/Fade';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { visuallyHidden } from '@mui/utils';
import {
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { copyText } from '../lib/clipboard';
import { formatDate, formatNumber, minutesSaved } from '../lib/format';
import { contextAround, locateQuote, type Range } from '../lib/quote';
import type { PageAnalysis } from '../lib/state';
import { BRIEF_GROUPS, markdownFileName, summaryToMarkdown } from '../lib/text';
import { SHAPE } from '../theme';
import { ApiPanel } from './ApiPanel';
import { JumpBar } from './JumpBar';
import { SourcePanel } from './SourcePanel';

export interface SheetData {
  page: PageInfo;
  tldr?: string | undefined;
  points: SummaryPoint[];
  stats?: SummaryStats | undefined;
  meta?: SummaryMeta | undefined;
  /** Detailed mode: what the page was understood to be. */
  analysis?: PageAnalysis | undefined;
  sourceText?: string | undefined;
  sourceTruncated?: boolean | undefined;
}

export interface SheetProps {
  data: SheetData;
  /** Request that produced this result (enables the "Use the API" panel). Absent for the sample. */
  request?: { url: string; length: string; format: string; language?: string | undefined };
  /** True while the summary is still arriving: new items grow into place. */
  live?: boolean;
  banner?: ReactNode;
  /** Rendered below the content while waiting for more (progress and skeleton). */
  bottom?: ReactNode;
}

const READING_WIDTH = '62ch';

function Notices({ page }: { page: PageInfo }) {
  const notes: string[] = [];
  if (page.extractionMethod === 'salvage')
    notes.push(
      'The page text came from data embedded in the page, not from its visible content, so it may be incomplete.',
    );
  else if (page.confidence === 'low')
    notes.push('Very little readable text was found on this page. Treat the summary with care.');
  else if (page.confidence === 'medium')
    notes.push('Text extraction was partial on this page, so the summary may miss parts.');
  if (page.truncated) {
    notes.push(
      `This page is long. The summary covers the opening and closing parts, about ${formatNumber(page.usedWords)} of ${formatNumber(page.wordCount)} words.`,
    );
  }
  return (
    <>
      {notes.map((n) => (
        <Alert
          key={n}
          className="notice"
          role="note"
          severity="info"
          icon={<InfoOutlinedIcon fontSize="inherit" />}
          sx={{ mt: 2.5, maxWidth: READING_WIDTH }}
        >
          {n}
        </Alert>
      ))}
    </>
  );
}

/** How much of the cited evidence was found in the page. A real measurement, drawn as a ring that fills in. */
function EvidenceRing({ found, quoted }: { found: number; quoted: number }) {
  const target = quoted === 0 ? 0 : (found / quoted) * 100;
  const [value, setValue] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setValue(target)); // animates from empty on arrival
    return () => cancelAnimationFrame(id);
  }, [target]);
  const complete = found === quoted && quoted > 0;
  return (
    <Box aria-hidden="true" sx={{ position: 'relative', display: 'inline-flex', flex: 'none' }}>
      <CircularProgress
        variant="determinate"
        value={100}
        size={44}
        thickness={4}
        sx={{ color: 'var(--mui-palette-outlineVariant)', position: 'absolute' }}
      />
      <CircularProgress
        variant="determinate"
        value={value}
        size={44}
        thickness={4}
        sx={{
          color: complete ? 'primary.main' : 'text.secondary',
          '& .MuiCircularProgress-circle': {
            strokeLinecap: 'round',
            transition: (t) =>
              t.transitions.create('stroke-dashoffset', {
                duration: 700,
                easing: t.transitions.easing.easeOut,
              }),
          },
        }}
      />
      <Box
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          color: complete ? 'primary.main' : 'text.secondary',
        }}
      >
        {complete ? <CheckIcon fontSize="small" /> : <HelpOutlineIcon fontSize="small" />}
      </Box>
    </Box>
  );
}

/** The cited passage in its real surroundings, revealed in place under the point that cites it. */
function PassageContext({
  text,
  range,
  quote,
}: {
  text: string;
  range: Range | undefined;
  quote: string;
}) {
  const lang = useContext(PageLang);
  const box = {
    mt: 1,
    p: 2,
    borderRadius: `${SHAPE.medium}px`,
    bgcolor: 'var(--mui-palette-surfaceContainerHigh)',
    maxWidth: READING_WIDTH,
    '& mark': {
      bgcolor: 'var(--mui-palette-evidenceStrong)',
      color: 'text.primary',
      px: '0.1em',
      borderRadius: '4px',
      boxDecorationBreak: 'clone' as const,
    },
  };
  if (!range) {
    return (
      <Box className="context" sx={box}>
        <Typography
          className="context__label"
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', fontWeight: 600, mb: 0.5 }}
        >
          Position in the page
        </Typography>
        <Typography
          variant="readingSmall"
          component="p"
          dir="auto"
          {...(lang ? { lang } : {})}
          sx={{ m: 0 }}
        >
          This passage is confirmed in the page, but its exact position could not be marked. Use
          "Show page text" to browse the source.
          <br />
          <q>{quote}</q>
        </Typography>
      </Box>
    );
  }
  const c = contextAround(text, range);
  return (
    <Box className="context" sx={box}>
      <Typography
        className="context__label"
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', fontWeight: 600, mb: 0.5 }}
      >
        In the page
      </Typography>
      <Typography
        variant="readingSmall"
        component="p"
        dir="auto"
        {...(lang ? { lang } : {})}
        color="text.secondary"
        sx={{ m: 0 }}
      >
        {c.leadEllipsis && '… '}
        {c.before}
        <mark>{c.match}</mark>
        {c.after}
        {c.tailEllipsis && ' …'}
      </Typography>
    </Box>
  );
}

interface PointProps {
  index: number;
  /** Number shown in the margin. Absent means the point is not numbered (paragraphs, facts, caveats). */
  number?: number | undefined;
  /** Short atomic lines (facts, caveats, next steps) are set a little smaller and tighter. */
  compact?: boolean | undefined;
  point: SummaryPoint;
  sourceText: string | undefined;
  range: Range | undefined;
  open: boolean;
  onToggle: () => void;
  contextId: string;
  live: boolean;
}

const PAGE_KIND: Record<string, string> = {
  tutorial: 'a tutorial',
  news: 'a news article',
  research: 'a research paper',
  documentation: 'documentation',
  essay: 'an essay',
  product: 'a product page',
  reference: 'a reference page',
  listing: 'a listing page',
};

/** "a tutorial", "documentation", "a page": the kind of page, ready to follow "as". */
function withArticle(kind: string): string {
  return PAGE_KIND[kind] ?? 'a page';
}

/** Save text as a file through a temporary link (works under the strict CSP: no network, no inline script). */
function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Language of the page text, so quoted passages are announced and quoted in the right language. */
const PageLang = createContext<string | undefined>(undefined);

function QuoteRow({ point }: { point: SummaryPoint }) {
  const lang = useContext(PageLang);
  return (
    <Box
      className="evidence__quote"
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        py: 0.75,
        pl: 1.5,
        pr: 1,
        borderLeft: 3,
        borderLeftStyle: point.grounded ? 'solid' : 'dashed',
        borderColor: point.grounded ? 'primary.main' : 'var(--mui-palette-outline)',
        borderRadius: `0 ${SHAPE.medium}px ${SHAPE.medium}px 0`,
        color: 'text.secondary',
        transition: (t) => t.transitions.create('background-color'),
      }}
    >
      {point.grounded && (
        <CheckCircleIcon
          fontSize="small"
          color="primary"
          aria-hidden
          sx={{ mt: '0.2em', flex: 'none' }}
        />
      )}
      {point.grounded && <span style={visuallyHidden as never}>Found in the page: </span>}
      <Typography
        variant="readingSmall"
        component="q"
        dir="auto"
        {...(lang ? { lang } : {})}
        sx={{ fontSize: '0.9375rem' }}
      >
        {point.quote}
      </Typography>
    </Box>
  );
}

/**
 * Inline citation marker at the end of a point. It sits in the line of text so the summary reads without
 * interruption; the quote and its place in the page open only when asked. Unverified evidence stays visible
 * (dashed, "Unchecked") because that is trust information, not detail.
 */
function EvidenceMarker({
  grounded,
  open,
  onClick,
  controls,
  label,
}: {
  grounded: boolean;
  open: boolean;
  onClick: () => void;
  controls: string;
  label: string;
}) {
  return (
    <ButtonBase
      className="evidence__btn"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={`${open ? 'Hide' : 'Show'} the cited passage for ${label}${grounded ? '' : ' (not found in the page)'}`}
      onClick={onClick}
      sx={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        ml: 1,
        px: 1,
        height: 24,
        verticalAlign: '0.1em',
        borderRadius: 999,
        border: 1,
        borderStyle: grounded ? 'solid' : 'dashed',
        borderColor: grounded ? 'transparent' : 'var(--mui-palette-outline)',
        bgcolor: open
          ? 'var(--mui-palette-evidenceStrong)'
          : grounded
            ? 'var(--mui-palette-evidence)'
            : 'transparent',
        color: grounded ? 'primary.main' : 'text.secondary',
        font: 'inherit',
        fontFamily: (t) => t.typography.fontFamily,
        fontSize: '0.75rem',
        fontWeight: 600,
        letterSpacing: '0.01em',
        lineHeight: 1,
        transition: (t) => t.transitions.create('background-color', { duration: 160 }),
        '&:hover': { bgcolor: 'var(--mui-palette-evidenceStrong)' },
        // A 24px chip is right for inline text; the invisible padding keeps the touch target comfortable.
        '&::after': { content: '""', position: 'absolute', inset: '-10px -6px' },
      }}
    >
      {grounded ? <CheckIcon sx={{ fontSize: 15 }} /> : <HelpOutlineIcon sx={{ fontSize: 15 }} />}
      {grounded ? 'Source' : 'Unchecked'}
    </ButtonBase>
  );
}

function Point({
  number,
  compact,
  point,
  sourceText,
  range,
  open,
  onToggle,
  contextId,
  live,
}: PointProps) {
  const checkable = point.grounded && !!sourceText && !!point.quote;
  const numbered = number !== undefined;
  const label = numbered
    ? `point ${number}`
    : `"${(point.heading ?? point.text).split(' ').slice(0, 7).join(' ')}"`;
  const figures = point.unverifiedFigures;
  return (
    <Collapse
      component="li"
      in
      appear={live}
      timeout={live ? 380 : 0}
      className="point"
      sx={{ listStyle: 'none' }}
    >
      <Fade in appear={live} timeout={live ? 480 : 0}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: numbered ? '2rem minmax(0, 1fr)' : 'minmax(0, 1fr)',
            columnGap: 1.5,
            pb: numbered ? 3.5 : compact ? 2.25 : 3,
          }}
        >
          {numbered && (
            <Typography
              aria-hidden="true"
              color="text.secondary"
              className="point__n"
              sx={{ pt: '0.55em', fontVariantNumeric: 'tabular-nums' }}
            >
              {number}
            </Typography>
          )}
          <Box>
            {point.heading && (
              <Typography
                variant="subtitle2"
                component="p"
                dir="auto"
                className="point__heading"
                sx={{ mb: 0.5, color: 'text.secondary', maxWidth: READING_WIDTH }}
              >
                {point.heading}
              </Typography>
            )}
            <Typography
              variant={compact ? 'readingSmall' : 'reading'}
              component="p"
              dir="auto"
              className="point__text"
              sx={{ m: 0, maxWidth: READING_WIDTH }}
            >
              {point.text}
              {point.quote && (
                <EvidenceMarker
                  grounded={point.grounded}
                  open={open}
                  onClick={onToggle}
                  controls={contextId}
                  label={label}
                />
              )}
            </Typography>
            {figures && figures.length > 0 && (
              <Stack
                direction="row"
                alignItems="center"
                spacing={0.75}
                className="point__figures"
                sx={{ mt: 0.75, color: 'warning.main', maxWidth: READING_WIDTH }}
              >
                <HelpOutlineIcon fontSize="small" aria-hidden />
                <Typography variant="caption" sx={{ fontWeight: 600 }}>
                  Check {figures.length === 1 ? 'this figure' : 'these figures'}:{' '}
                  {figures.join(', ')} {figures.length === 1 ? 'is' : 'are'} not stated in the page.
                </Typography>
              </Stack>
            )}
            {point.quote && (
              <Collapse in={open} unmountOnExit timeout={300}>
                <Box
                  id={contextId}
                  className="evidence"
                  data-found={point.grounded ? 'true' : 'false'}
                  sx={{ mt: 1.5, maxWidth: READING_WIDTH }}
                >
                  {!point.grounded && (
                    <Stack
                      direction="row"
                      alignItems="center"
                      spacing={0.5}
                      sx={{ color: 'text.secondary', mb: 0.5 }}
                    >
                      <HelpOutlineIcon fontSize="small" aria-hidden />
                      <Typography variant="caption" sx={{ fontWeight: 600 }}>
                        Not found in the page
                      </Typography>
                    </Stack>
                  )}
                  <QuoteRow point={point} />
                  {checkable && (
                    <PassageContext text={sourceText} range={range} quote={point.quote} />
                  )}
                </Box>
              </Collapse>
            )}
          </Box>
        </Box>
      </Fade>
    </Collapse>
  );
}

/** The result, laid out as a document: who said it, the short version, then each point with its evidence. */
export const Sheet = forwardRef<HTMLHeadingElement, SheetProps>(function Sheet(
  { data, request, live, banner, bottom },
  titleRef,
) {
  const { page, tldr, points, stats, meta, sourceText, analysis } = data;
  const uid = useId();
  const sourceId = `${uid}-source`;
  const apiId = `${uid}-api`;

  const [showSource, setShowSource] = useState(false);
  const [showApi, setShowApi] = useState(false);
  const [openPoints, setOpenPoints] = useState<ReadonlySet<number>>(new Set());
  const [copied, setCopied] = useState<'' | 'summary' | 'link'>('');

  const ranges = useMemo(
    () =>
      points.map((p) =>
        sourceText && p.quote && p.grounded ? locateQuote(sourceText, p.quote) : undefined,
      ),
    [points, sourceText],
  );

  const briefLayout = points.some((p) => p.section !== undefined);
  const renderPoint = (p: SummaryPoint, i: number, number: number | undefined, compact = false) => (
    <Point
      key={i}
      index={i}
      number={number}
      compact={compact}
      point={p}
      sourceText={sourceText}
      range={ranges[i]}
      open={openPoints.has(i)}
      onToggle={() =>
        setOpenPoints((cur) => {
          const next = new Set(cur);
          if (!next.delete(i)) next.add(i);
          return next;
        })
      }
      contextId={`${uid}-ctx-${i}`}
      live={isLive}
    />
  );

  const jumpItems = BRIEF_GROUPS.filter((g) => points.some((p) => p.section === g.section)).map(
    (g) => ({ id: `${uid}-s-${g.section}`, headingId: `${uid}-g-${g.section}`, title: g.title }),
  );

  const quoted = points.filter((p) => p.quote).length;
  const found = points.filter((p) => p.quote && p.grounded).length;
  const done = !!stats;
  const site = page.siteName ?? hostOf(page.finalUrl);
  const summaryLang = request?.language || page.lang || undefined;
  const date = formatDate(page.publishedAt);
  const saved = stats ? minutesSaved(page.wordCount, stats.summaryWords) : 0;
  const isLive = !!live;
  const citedIndexes = points.flatMap((p, i) => (p.quote ? [i] : []));
  const allOpen = citedIndexes.length > 0 && citedIndexes.every((i) => openPoints.has(i));

  const flash = (what: 'summary' | 'link') => {
    setCopied(what);
    window.setTimeout(() => setCopied(''), 2000);
  };
  const shareLink = async () => {
    const url = window.location.href;
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: page.title, url });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return; // the user closed the share sheet
        /* unavailable: fall back to copying the link */
      }
    }
    if (await copyText(url)) flash('link');
  };

  return (
    <PageLang.Provider value={page.lang}>
      <Paper
        component="article"
        variant="outlined"
        className="sheet"
        data-live={isLive ? 'true' : undefined}
        aria-busy={isLive ? 'true' : undefined}
        sx={{
          minWidth: 0,
          p: { xs: 3, sm: 5 },
          borderRadius: `${SHAPE.large}px`,
          bgcolor: 'var(--mui-palette-surfaceContainerLow)',
          borderColor: 'divider',
        }}
      >
        {banner}

        <Typography variant="subtitle2" className="site" noWrap dir="auto">
          {site}
        </Typography>
        <Stack
          direction="row"
          useFlexGap
          className="meta"
          sx={{
            flexWrap: 'wrap',
            gap: '4px 16px',
            mt: 0.5,
            color: 'text.secondary',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {page.author && (
            <Typography variant="body2" dir="auto">
              {page.author}
            </Typography>
          )}
          {date && <Typography variant="body2">{date}</Typography>}
          <Typography variant="body2">{page.readingMinutes} min read</Typography>
          <Typography variant="body2">{formatNumber(page.wordCount)} words</Typography>
        </Stack>

        <Typography
          variant="readingTitle"
          component="h2"
          tabIndex={-1}
          ref={titleRef}
          className="title"
          dir="auto"
          {...(page.lang ? { lang: page.lang } : {})}
          sx={{ mt: 2, '&:focus-visible': { outlineOffset: 6 } }}
        >
          <Link
            href={page.finalUrl}
            target="_blank"
            rel="noopener noreferrer"
            color="inherit"
            underline="hover"
            sx={{ '&:hover': { textDecorationColor: 'var(--mui-palette-primary-main)' } }}
          >
            {page.title}
          </Link>
        </Typography>

        <Notices page={page} />

        {tldr && (
          <Fade in appear={isLive} timeout={isLive ? 480 : 0}>
            <Typography
              variant="readingLarge"
              component="p"
              dir="auto"
              className="tldr"
              {...(summaryLang ? { lang: summaryLang } : {})}
              sx={{ mt: 3, maxWidth: READING_WIDTH }}
            >
              {tldr}
            </Typography>
          </Fade>
        )}

        {analysis && done && (
          <Typography
            variant="caption"
            color="text.secondary"
            className="understood"
            sx={{ display: 'block', mt: 1.5, maxWidth: READING_WIDTH }}
          >
            Read in full as {withArticle(analysis.pageType)}
            {analysis.audience ? ' for ' + analysis.audience.replace(/\.$/, '') : ''}.{' '}
            {analysis.sections} sections, {analysis.findings} findings checked against the page.
          </Typography>
        )}

        {done && quoted > 0 && (
          <Stack
            direction="row"
            alignItems="center"
            spacing={1.5}
            className="verify"
            data-partial={found < quoted ? 'true' : undefined}
            sx={{ mt: 4, pt: 3, borderTop: 1, borderColor: 'divider', color: 'text.secondary' }}
          >
            <EvidenceRing found={found} quoted={quoted} />
            <Typography variant="body2" component="span">
              {found} of {quoted} cited passages found in the page text.
              {found < quoted &&
                ' The rest could not be matched, so treat those points as unchecked.'}
            </Typography>
            <Button
              size="small"
              color="inherit"
              className="evidence__all"
              onClick={() => setOpenPoints(allOpen ? new Set() : new Set(citedIndexes))}
              sx={{ ml: 'auto !important', flex: 'none', minHeight: 36 }}
            >
              {allOpen ? 'Hide all evidence' : 'Show all evidence'}
            </Button>
          </Stack>
        )}
        {done && quoted === 0 && points.length > 0 && (
          <Stack
            direction="row"
            alignItems="center"
            spacing={1.5}
            className="verify"
            data-partial="true"
            sx={{ mt: 4, pt: 3, borderTop: 1, borderColor: 'divider', color: 'text.secondary' }}
          >
            <EvidenceRing found={0} quoted={0} />
            <Typography variant="body2" component="span">
              This summary cites no passages, so it cannot be checked against the page.
            </Typography>
          </Stack>
        )}

        {done && briefLayout && jumpItems.length >= 3 && <JumpBar items={jumpItems} />}

        {points.length > 0 &&
          (briefLayout ? (
            <Box className="brief" {...(summaryLang ? { lang: summaryLang } : {})}>
              {BRIEF_GROUPS.map((g) => {
                const items = points.flatMap((p, i) => (p.section === g.section ? [{ p, i }] : []));
                if (items.length === 0) return null;
                const headingId = `${uid}-g-${g.section}`;
                const compact =
                  g.section === 'fact' || g.section === 'caveat' || g.section === 'next';
                return (
                  <Box
                    key={g.section}
                    id={`${uid}-s-${g.section}`}
                    component="section"
                    aria-labelledby={headingId}
                    className={`brief__${g.section}`}
                    sx={{ mt: 4.5, scrollMarginTop: { xs: 128, sm: 136 } }}
                  >
                    <Typography
                      id={headingId}
                      tabIndex={-1}
                      variant="h6"
                      component="h3"
                      sx={{ mb: 1.5, outline: 'none' }}
                    >
                      {g.title}
                    </Typography>
                    <Box component="ol" className="points" sx={{ listStyle: 'none', p: 0, m: 0 }}>
                      {items.map(({ p, i }, n) =>
                        renderPoint(p, i, g.numbered ? n + 1 : undefined, compact),
                      )}
                    </Box>
                  </Box>
                );
              })}
            </Box>
          ) : (
            <Box
              component="ol"
              className="points"
              {...(summaryLang ? { lang: summaryLang } : {})}
              sx={{ listStyle: 'none', p: 0, m: 0, mt: 3 }}
            >
              {points.map((p, i) => renderPoint(p, i, p.kind === 'bullet' ? i + 1 : undefined))}
            </Box>
          ))}

        {bottom}

        {done && stats && (
          <Box
            className="stats"
            sx={{
              mt: 2,
              pt: 3,
              borderTop: 1,
              borderColor: 'divider',
              display: 'grid',
              gap: 0.5,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <Typography variant="body2" color="text.secondary" component="span">
              From {formatNumber(page.wordCount)} words to {formatNumber(stats.summaryWords)}, about{' '}
              {formatNumber(stats.compressionRatio)} times shorter.
              {saved > 0 && ` Saves roughly ${saved} minutes of reading.`}
            </Typography>
            {meta && (
              <Typography
                variant="caption"
                component="small"
                color="text.secondary"
                sx={{ opacity: 0.85 }}
              >
                Written by {meta.model} in {(meta.timingsMs.total / 1000).toFixed(1)} seconds
                {meta.cached ? ', served from cache' : ''}
                {meta.fallback ? ', using the backup model' : ''}.
              </Typography>
            )}
          </Box>
        )}

        {done && (
          <Stack
            direction="row"
            useFlexGap
            className="tools no-print"
            sx={{ flexWrap: 'wrap', gap: 1, mt: 3 }}
          >
            <Button
              variant={copied === 'summary' ? 'tonal' : 'outlined'}
              color="inherit"
              size="small"
              startIcon={copied === 'summary' ? <CheckIcon /> : <CopyIcon />}
              onClick={async () => {
                if (await copyText(summaryToMarkdown(page, tldr, points))) flash('summary');
              }}
            >
              {copied === 'summary' ? 'Copied' : 'Copy summary'}
            </Button>
            <Button
              variant="outlined"
              color="inherit"
              size="small"
              startIcon={<DownloadIcon />}
              onClick={() =>
                downloadText(markdownFileName(page.title), summaryToMarkdown(page, tldr, points))
              }
            >
              Download .md
            </Button>
            <Box component="span" role="status" sx={visuallyHidden}>
              {copied === 'summary'
                ? 'Summary copied to the clipboard'
                : copied === 'link'
                  ? 'Link copied to the clipboard'
                  : ''}
            </Box>
            {sourceText && (
              <Button
                variant={showSource ? 'tonal' : 'outlined'}
                color="inherit"
                size="small"
                aria-expanded={showSource}
                aria-controls={sourceId}
                onClick={() => setShowSource((v) => !v)}
              >
                {showSource ? 'Hide page text' : 'Show page text'}
              </Button>
            )}
            {request && (
              <Button
                variant={showApi ? 'tonal' : 'outlined'}
                color="inherit"
                size="small"
                aria-expanded={showApi}
                aria-controls={apiId}
                onClick={() => setShowApi((v) => !v)}
              >
                Use the API
              </Button>
            )}
            {request && (
              <Button
                variant={copied === 'link' ? 'tonal' : 'outlined'}
                color="inherit"
                size="small"
                startIcon={copied === 'link' ? <CheckIcon /> : <ShareIcon />}
                onClick={shareLink}
              >
                {copied === 'link' ? 'Link copied' : 'Share'}
              </Button>
            )}
            <Button
              component="a"
              href={page.finalUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="outlined"
              color="inherit"
              size="small"
              endIcon={<OpenInNewIcon />}
            >
              Open original
            </Button>
          </Stack>
        )}

        {done && sourceText && (
          <Collapse in={showSource} unmountOnExit timeout={320}>
            <SourcePanel
              id={sourceId}
              text={sourceText}
              truncated={data.sourceTruncated === true}
              ranges={ranges}
              site={site}
            />
          </Collapse>
        )}
        {done && request && (
          <Collapse in={showApi} unmountOnExit timeout={320}>
            <ApiPanel id={apiId} {...request} />
          </Collapse>
        )}
      </Paper>
    </PageLang.Provider>
  );
});
