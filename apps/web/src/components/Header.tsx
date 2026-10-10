import CodeIcon from '@mui/icons-material/CodeRounded';
import DarkModeIcon from '@mui/icons-material/DarkModeOutlined';
import LightModeIcon from '@mui/icons-material/LightModeOutlined';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import IconButton from '@mui/material/IconButton';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import useScrollTrigger from '@mui/material/useScrollTrigger';
import { useColorScheme } from '@mui/material/styles';
import { useCallback } from 'react';

/** Switches between light and dark and remembers it (Material UI stores it under "mui-mode"). */
function useColorToggle() {
  const { mode, systemMode, setMode } = useColorScheme();
  const effective = mode === 'system' ? (systemMode ?? 'light') : (mode ?? 'light');
  const toggle = useCallback(() => {
    const root = document.documentElement;
    root.classList.add('theme-fade'); // fade colours only for this deliberate switch
    window.setTimeout(() => root.classList.remove('theme-fade'), 320);
    setMode(effective === 'dark' ? 'light' : 'dark');
  }, [effective, setMode]);
  return { effective, toggle };
}

/** Small top app bar. It sits flat on the page and takes a tonal surface colour once you scroll (Material 3). */
export function Header() {
  const scrolled = useScrollTrigger({ disableHysteresis: true, threshold: 8 });
  const { effective, toggle } = useColorToggle();
  const next = effective === 'dark' ? 'light' : 'dark';

  return (
    <AppBar
      component="header"
      position="sticky"
      color="transparent"
      elevation={0}
      className="no-print"
      sx={{
        backgroundColor: scrolled ? 'var(--mui-palette-surfaceContainer)' : 'transparent',
        backgroundImage: 'none',
        color: 'text.primary',
        transition: (t) =>
          t.transitions.create('background-color', { duration: t.transitions.duration.standard }),
      }}
    >
      <Container maxWidth="lg" disableGutters sx={{ px: { xs: 2, sm: 3 } }}>
        <Toolbar disableGutters sx={{ minHeight: { xs: 64, sm: 72 }, gap: 1 }}>
          <Typography
            component="a"
            href="/"
            variant="h6"
            aria-label="Digest, home"
            sx={{ color: 'inherit', textDecoration: 'none', borderRadius: 1, px: 0.5 }}
          >
            Digest
            <Box component="span" aria-hidden="true" sx={{ color: 'primary.main' }}>
              .
            </Box>
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Button
            component="a"
            href="/api/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
            color="inherit"
            size="small"
            startIcon={<CodeIcon />}
            sx={{ color: 'text.secondary' }}
          >
            API
          </Button>
          <Tooltip title={`Switch to ${next} theme`}>
            <IconButton onClick={toggle} aria-label={`Switch to ${next} theme`} color="inherit">
              <Box
                sx={{
                  display: 'grid',
                  transition: (t) =>
                    t.transitions.create('transform', {
                      duration: t.transitions.duration.complex,
                      easing: t.transitions.easing.easeInOut,
                    }),
                  transform: effective === 'dark' ? 'rotate(180deg)' : 'none',
                }}
              >
                {effective === 'dark' ? <LightModeIcon /> : <DarkModeIcon />}
              </Box>
            </IconButton>
          </Tooltip>
        </Toolbar>
      </Container>
    </AppBar>
  );
}
