import CheckIcon from '@mui/icons-material/CheckRounded';
import CopyIcon from '@mui/icons-material/ContentCopyRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import { useState } from 'react';
import { copyText } from '../lib/clipboard';
import { buildCurl } from '../lib/text';

/** The exact request behind this result, so the backend can be evaluated without the UI. */
export function ApiPanel({
  id,
  url,
  length,
  format,
  language,
}: {
  id: string;
  url: string;
  length: string;
  format: string;
  language?: string | undefined;
}) {
  const [copied, setCopied] = useState(false);
  const curl = buildCurl({ origin: window.location.origin, url, length, format, language });
  return (
    <Box id={id} className="panel" sx={{ mt: 3, pt: 3, borderTop: 1, borderColor: 'divider' }}>
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 1,
          mb: 1.5,
        }}
      >
        <Typography variant="subtitle1" component="h3">
          Use the API
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Same request this page just made.
        </Typography>
      </Box>
      <Box
        component="pre"
        className="code"
        tabIndex={0}
        aria-label="curl command"
        sx={{
          m: 0,
          p: 2,
          borderRadius: 3,
          overflowX: 'auto',
          bgcolor: 'var(--mui-palette-surfaceContainer)',
          fontSize: '0.8125rem',
          lineHeight: 1.65,
          color: 'text.primary',
        }}
      >
        <code>{curl}</code>
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, mt: 1.5 }}>
        <Button
          variant="outlined"
          size="small"
          startIcon={copied ? <CheckIcon /> : <CopyIcon />}
          onClick={async () => {
            if (await copyText(curl)) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy command'}
        </Button>
        <Link href="/api/openapi.json" target="_blank" rel="noopener noreferrer" variant="body2">
          OpenAPI description
        </Link>
      </Box>
    </Box>
  );
}
