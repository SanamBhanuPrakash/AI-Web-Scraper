import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import { useEffect, useState } from 'react';

export interface JumpItem {
  /** Id of the section element to scroll to. */
  id: string;
  /** Id of its heading, which receives focus so screen readers land on the new part. */
  headingId: string;
  title: string;
}

const prefersReducedMotion = (): boolean =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * "Jump to" bar for a long brief. It sticks under the app bar while you read, marks the part you are in
 * (scroll position, not guesses), and moves focus to the heading you jump to.
 */
export function JumpBar({ items }: { items: JumpItem[] }) {
  const [active, setActive] = useState(items[0]?.id);
  const key = items.map((i) => i.id).join('|');

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const els = items
      .map((i) => document.getElementById(i.id))
      .filter((e): e is HTMLElement => e !== null);
    if (els.length === 0) return;
    // A part counts as "current" once its top passes under the sticky bars, until the next one does.
    const obs = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: '-140px 0px -55% 0px' },
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
    // `items` is derived from `key`; depending on the key keeps the observer stable between renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const go = (item: JumpItem): void => {
    const el = document.getElementById(item.id);
    if (!el) return;
    el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    document.getElementById(item.headingId)?.focus({ preventScroll: true });
    setActive(item.id);
  };

  return (
    <Box
      component="nav"
      aria-label="Parts of this brief"
      className="jump no-print"
      sx={{
        position: 'sticky',
        top: { xs: 64, sm: 72 },
        zIndex: 2,
        mt: 3,
        mx: { xs: -1.5, sm: -2 },
        px: { xs: 1.5, sm: 2 },
        py: 1,
        display: 'flex',
        gap: 1,
        overflowX: 'auto',
        scrollbarWidth: 'none',
        '&::-webkit-scrollbar': { display: 'none' },
        bgcolor: 'var(--mui-palette-surfaceContainerLow)',
        borderBottom: 1,
        borderColor: 'divider',
      }}
    >
      {items.map((item) => {
        const current = active === item.id;
        return (
          <Chip
            key={item.id}
            component="a"
            href={`#${item.id}`}
            clickable
            label={item.title}
            variant={current ? 'filled' : 'outlined'}
            aria-current={current ? 'location' : undefined}
            onClick={(e: React.MouseEvent) => {
              e.preventDefault();
              go(item);
            }}
            sx={{
              flex: 'none',
              fontWeight: current ? 600 : 400,
              ...(current
                ? {
                    bgcolor: 'var(--mui-palette-secondaryContainer)',
                    color: 'var(--mui-palette-onSecondaryContainer)',
                  }
                : {}),
            }}
          />
        );
      })}
    </Box>
  );
}
