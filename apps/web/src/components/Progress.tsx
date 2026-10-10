import CheckCircleIcon from '@mui/icons-material/CheckCircleRounded';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUncheckedRounded';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import type { PageAnalysis, Stage } from '../lib/state';

const CLASSIC_STEPS = [
  { key: 'fetching', label: 'Fetching and reading the page' },
  { key: 'writing', label: 'Writing the summary' },
] as const;
/** Detailed mode: the page is read in full and the notes are checked before anything is written. */
const DEEP_STEPS = [
  { key: 'fetching', label: 'Fetching the page' },
  { key: 'understanding', label: 'Reading the whole page and checking the notes' },
  { key: 'writing', label: 'Writing the brief' },
] as const;

/**
 * The literal "Loading…" state. The steps follow real server events (page extracted, first text
 * arrived), not timers, so what is shown is what is happening.
 */
export function Progress({
  stage,
  deep = false,
  analysis,
}: {
  stage: Stage;
  deep?: boolean;
  analysis?: PageAnalysis | undefined;
}) {
  const [slow, setSlow] = useState(false);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), deep ? 15000 : 8000);
    // A visible clock only for the long Detailed wait, so a slow request reads as work, not as a hang.
    const tick = deep ? window.setInterval(() => setSeconds((n) => n + 1), 1000) : undefined;
    return () => {
      window.clearTimeout(t);
      if (tick !== undefined) window.clearInterval(tick);
    };
  }, [deep]);

  const STEPS = deep ? DEEP_STEPS : CLASSIC_STEPS;
  const current = stage === 'streaming' ? 'writing' : stage;
  const active = Math.max(
    0,
    STEPS.findIndex((s) => s.key === current),
  );
  return (
    <Box className="progress" sx={{ mt: 1 }}>
      <Box
        sx={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 2 }}
      >
        <Typography variant="h5" component="p" className="progress__title">
          Loading…
        </Typography>
        {deep && seconds >= 3 && (
          <Typography
            variant="body2"
            color="text.secondary"
            aria-hidden="true"
            className="progress__clock"
            sx={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {seconds} s
          </Typography>
        )}
      </Box>
      <Box component="ol" sx={{ listStyle: 'none', p: 0, m: 0, mt: 2, display: 'grid', gap: 1.5 }}>
        {STEPS.map((s, i) => {
          const state = i < active ? 'done' : i === active ? 'active' : 'pending';
          return (
            <Box
              component="li"
              key={s.key}
              className="step"
              data-state={state}
              aria-current={state === 'active' ? 'step' : undefined}
              sx={{
                display: 'grid',
                gridTemplateColumns: '28px minmax(0, 1fr)',
                columnGap: 1.5,
                alignItems: 'center',
              }}
            >
              {state === 'done' ? (
                <CheckCircleIcon color="primary" aria-hidden />
              ) : (
                <RadioButtonUncheckedIcon
                  aria-hidden
                  sx={{ color: state === 'active' ? 'primary.main' : 'text.disabled' }}
                />
              )}
              <Typography
                variant="body1"
                sx={{
                  fontWeight: state === 'active' ? 600 : 400,
                  color: state === 'pending' ? 'text.secondary' : 'text.primary',
                }}
              >
                {s.label}
              </Typography>
              {s.key === 'understanding' && state === 'done' && analysis && (
                <Typography variant="body2" color="text.secondary" sx={{ gridColumn: 2 }}>
                  Read {analysis.sections} sections and verified {analysis.findings} findings
                  against the page.
                </Typography>
              )}
              {s.key === 'understanding' && state === 'done' && analysis?.outline && (
                <Box
                  component="ul"
                  aria-label="Sections found on the page"
                  className="progress__outline"
                  sx={{
                    gridColumn: 2,
                    listStyle: 'none',
                    p: 0,
                    m: 0,
                    mt: 0.5,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 0.75,
                  }}
                >
                  {analysis.outline.slice(0, 8).map((h) => (
                    <Box component="li" key={h} sx={{ minWidth: 0 }}>
                      <Chip size="small" variant="outlined" label={h} sx={{ maxWidth: '100%' }} />
                    </Box>
                  ))}
                  {analysis.outline.length > 8 && (
                    <Box component="li">
                      <Chip
                        size="small"
                        variant="outlined"
                        label={`+${analysis.outline.length - 8} more`}
                      />
                    </Box>
                  )}
                </Box>
              )}
              {state === 'active' && <LinearProgress aria-hidden sx={{ gridColumn: 2, mt: 1 }} />}
            </Box>
          );
        })}
      </Box>
      {slow && (
        <Typography
          variant="body2"
          color="text.secondary"
          className="progress__slow"
          sx={{ mt: 2 }}
        >
          Still working. Long pages and busy periods take a little longer.
        </Typography>
      )}
    </Box>
  );
}
