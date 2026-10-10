import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { useMemo } from 'react';
import { segmentParagraph, type Range } from '../lib/quote';

export interface SourcePanelProps {
  id: string;
  text: string;
  truncated: boolean;
  /** One entry per evidence quote, in point order (undefined when the quote could not be located). */
  ranges: Array<Range | undefined>;
  site: string;
}

/** The extracted page text with every cited passage highlighted, for readers who want to browse the source. */
export function SourcePanel({ id, text, truncated, ranges, site }: SourcePanelProps) {
  const paragraphs = useMemo(() => {
    let offset = 0;
    return text.split('\n').map((p) => {
      const start = offset;
      offset += p.length + 1;
      return { p, start };
    });
  }, [text]);

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
          Page text from {site}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {truncated
            ? 'Shortened for length. Highlights show cited passages.'
            : 'Highlights show cited passages.'}
        </Typography>
      </Box>
      <Box
        className="source"
        tabIndex={0}
        role="region"
        aria-label="Extracted page text"
        dir="auto"
        sx={(t) => ({
          maxHeight: '22rem',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          p: 2,
          borderRadius: `${t.shape.borderRadius}px`,
          bgcolor: 'var(--mui-palette-surfaceContainer)',
          ...t.typography.readingSmall,
          color: 'text.secondary',
          '& p + p': { mt: 1.5 },
          '& p': { m: 0 },
          '& mark': {
            bgcolor: 'var(--mui-palette-evidence)',
            color: 'text.primary',
            px: '0.1em',
            borderRadius: '4px',
            boxDecorationBreak: 'clone',
          },
        })}
      >
        {paragraphs.map(({ p, start }, i) =>
          p.trim() === '' ? null : (
            <p key={i}>
              {segmentParagraph(p, start, ranges).map((seg, j) =>
                seg.mark === undefined ? seg.text : <mark key={j}>{seg.text}</mark>,
              )}
            </p>
          ),
        )}
      </Box>
    </Box>
  );
}
