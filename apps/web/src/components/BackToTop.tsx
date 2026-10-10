import ArrowUpwardIcon from '@mui/icons-material/ArrowUpwardRounded';
import Fab from '@mui/material/Fab';
import Zoom from '@mui/material/Zoom';
import { useEffect, useState } from 'react';

/**
 * How far the page must be scrolled before the button appears: about a third of the window height, never less than
 * 240 px, so it shows up as soon as the form has moved out of the way on any screen size. Once visible it stays until
 * the person is back within 80 px of that line, so it does not flicker at the edge.
 */
const MIN_PX = 240;
const HYSTERESIS_PX = 80;
export const showAfter = (windowHeight: number): number =>
  Math.max(MIN_PX, Math.round(windowHeight * 0.35));

/**
 * Round "back to top" button, bottom right. It appears only after scrolling, so it never covers the first screen,
 * and it is hidden in print. Moving focus to the headline afterwards keeps keyboard and screen-reader users from
 * being left on a button that has just disappeared.
 */
export function BackToTop({ onArrive }: { onArrive: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let frame = 0;
    const update = (): void => {
      frame = 0;
      const line = showAfter(window.innerHeight);
      setVisible((was) => window.scrollY > (was ? line - HYSTERESIS_PX : line));
    };
    const onScroll = (): void => {
      if (frame === 0) frame = requestAnimationFrame(update); // at most once per frame
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  const go = (): void => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    onArrive();
  };

  return (
    <Zoom in={visible} unmountOnExit>
      <Fab
        size="medium"
        color="primary"
        aria-label="Back to top"
        title="Back to top"
        className="back-to-top no-print"
        onClick={go}
        sx={{
          position: 'fixed',
          right: { xs: 16, sm: 24 },
          bottom: { xs: 16, sm: 24 },
          // Clear of the iPhone home indicator.
          mb: 'env(safe-area-inset-bottom)',
          zIndex: (t) => t.zIndex.speedDial,
        }}
      >
        <ArrowUpwardIcon />
      </Fab>
    </Zoom>
  );
}
