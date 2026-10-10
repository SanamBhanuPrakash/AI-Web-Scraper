import ArrowForwardIcon from '@mui/icons-material/ArrowForwardRounded';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutlineRounded';
import Alert from '@mui/material/Alert';
import AlertTitle from '@mui/material/AlertTitle';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { useEffect, useState } from 'react';
import type { FailureInfo } from '../lib/api';
import { FAILURE_TITLE, NEEDS_NEW_LINK } from '../lib/errors-copy';

function useCountdown(seconds: number | undefined): number {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    setLeft(seconds ?? 0);
    if (!seconds) return;
    const t = window.setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => window.clearInterval(t);
  }, [seconds]);
  return left;
}

export interface ErrorSlipProps {
  failure: FailureInfo;
  onRetry: () => void;
  onNewLink: () => void;
}

/** A failure should say what happened, what to do next, and give support something to quote. */
export function ErrorSlip({ failure, onRetry, onNewLink }: ErrorSlipProps) {
  const wait = useCountdown(failure.retryAfterSec);
  const newLink = NEEDS_NEW_LINK.has(failure.code);

  return (
    <Alert
      severity="error"
      variant="outlined"
      icon={<ErrorOutlineIcon fontSize="inherit" />}
      sx={{ borderRadius: 3, p: { xs: 2, sm: 3 }, '& .MuiAlert-message': { width: '100%' } }}
    >
      <AlertTitle component="h2" sx={{ fontSize: '1.25rem', fontWeight: 600 }}>
        {FAILURE_TITLE[failure.code]}
      </AlertTitle>
      <Typography sx={{ maxWidth: '62ch' }}>{failure.message}</Typography>
      <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1.5, mt: 3 }}>
        {failure.retryable && (
          <Button
            variant="contained"
            onClick={onRetry}
            disabled={wait > 0}
            endIcon={wait === 0 ? <ArrowForwardIcon /> : undefined}
          >
            Try again
            {/* Hidden from assistive tech so the countdown does not re-announce the alert every second. */}
            {wait > 0 && <span aria-hidden="true">{` in ${wait}s`}</span>}
          </Button>
        )}
        <Button
          variant={failure.retryable ? 'outlined' : 'contained'}
          color={failure.retryable ? 'inherit' : 'primary'}
          onClick={onNewLink}
        >
          {newLink ? 'Try another link' : 'Edit the address'}
        </Button>
      </Stack>
      <Box component="details" sx={{ mt: 2, color: 'text.secondary', fontSize: '0.8125rem' }}>
        <summary style={{ cursor: 'pointer', minHeight: 32 }}>Details for support</summary>
        <Box
          component="dl"
          sx={{
            mt: 1,
            mb: 0,
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: 0.5,
            columnGap: 2,
            fontFamily: 'ui-monospace, Menlo, Consolas, monospace',
          }}
        >
          <dt>code</dt>
          <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{failure.code}</dd>
          {failure.requestId && (
            <>
              <dt>request</dt>
              <dd style={{ margin: 0, overflowWrap: 'anywhere' }}>{failure.requestId}</dd>
            </>
          )}
        </Box>
      </Box>
    </Alert>
  );
}
