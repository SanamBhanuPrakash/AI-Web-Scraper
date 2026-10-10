import CheckCircleIcon from '@mui/icons-material/CheckCircleRounded';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUncheckedRounded';
import Box from '@mui/material/Box';
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
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), deep ? 15000 : 8000);
    return () => window.clearTimeout(t);
  }, [deep]);

  const STEPS = deep ? DEEP_STEPS : CLASSIC_STEPS;
  const current = stage === 'streaming' ? 'writing' : stage;
  const active = Math.max(
    0,
    STEPS.findIndex((s) => s.key === current),
  );
  return (
    <Box className="progress" sx={{ mt: 1 }}>
      <Typography variant="h5" component="p" className="progress__title">
        Loading…
      </Typography>
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
