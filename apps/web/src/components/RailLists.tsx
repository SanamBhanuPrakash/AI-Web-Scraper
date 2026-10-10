import HistoryIcon from '@mui/icons-material/HistoryRounded';
import LinkIcon from '@mui/icons-material/LinkRounded';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import useMediaQuery from '@mui/material/useMediaQuery';
import Typography from '@mui/material/Typography';
import { relativeTime } from '../lib/format';
import type { HistoryItem } from '../lib/history';
import { displayUrl } from '../lib/url';

/** One-click demos: pages that are known to work with the pipeline. */
export const EXAMPLES: ReadonlyArray<{ url: string; note: string }> = [
  { url: 'https://en.wikipedia.org/wiki/Web_scraping', note: 'Encyclopedia article' },
  { url: 'https://www.paulgraham.com/greatwork.html', note: 'Long essay' },
  {
    url: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview',
    note: 'Technical documentation',
  },
];

interface RowProps {
  primary: string;
  secondary: string;
  onClick: () => void;
  disabled: boolean;
  icon: 'link' | 'history';
}

function Row({ primary, secondary, onClick, disabled, icon }: RowProps) {
  return (
    <ListItem disablePadding>
      <ListItemButton onClick={onClick} disabled={disabled}>
        <ListItemIcon sx={{ minWidth: 40, color: 'text.secondary' }}>
          {icon === 'link' ? <LinkIcon /> : <HistoryIcon />}
        </ListItemIcon>
        <ListItemText
          primary={primary}
          secondary={secondary}
          slotProps={{
            primary: { sx: { overflowWrap: 'anywhere', fontSize: '0.9375rem' } },
            secondary: { sx: { fontSize: '0.8125rem' } },
          }}
        />
      </ListItemButton>
    </ListItem>
  );
}

export function Examples({
  onPick,
  disabled,
}: {
  onPick: (url: string) => void;
  disabled: boolean;
}) {
  return (
    <Box component="section" aria-labelledby="examples-h" sx={{ mt: 5 }}>
      <Typography id="examples-h" component="h2" variant="subtitle2" color="text.secondary">
        Try one of these
      </Typography>
      <List sx={{ mx: -1 }}>
        {EXAMPLES.map((e) => (
          <Row
            key={e.url}
            primary={displayUrl(e.url)}
            secondary={e.note}
            icon="link"
            disabled={disabled}
            onClick={() => onPick(e.url)}
          />
        ))}
      </List>
    </Box>
  );
}

export function Recent({
  items,
  onPick,
  onClear,
  disabled,
}: {
  items: HistoryItem[];
  onPick: (url: string) => void;
  onClear: () => void;
  disabled: boolean;
}) {
  // Phones show the three most recent only, so the list does not push the result far down the page.
  const phone = useMediaQuery('(max-width:599.95px)');
  if (items.length === 0) return null;
  return (
    <Box component="section" aria-labelledby="recent-h" sx={{ mt: 4 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography id="recent-h" component="h2" variant="subtitle2" color="text.secondary">
          Recent in this browser
        </Typography>
        <Button
          size="small"
          color="inherit"
          onClick={onClear}
          sx={{ color: 'text.secondary', minHeight: 44 }}
        >
          Clear
        </Button>
      </Box>
      <List sx={{ mx: -1 }}>
        {items.slice(0, phone ? 3 : 6).map((h) => (
          <Row
            key={h.url}
            primary={h.title}
            secondary={`${h.site}, ${relativeTime(h.at)}`}
            icon="history"
            disabled={disabled}
            onClick={() => onPick(h.url)}
          />
        ))}
      </List>
    </Box>
  );
}
