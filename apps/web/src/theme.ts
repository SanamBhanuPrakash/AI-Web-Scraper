import { createTheme, type ThemeOptions } from '@mui/material/styles';
import type { CSSProperties } from 'react';

/**
 * Digest's Material 3 theme. Tonal colour roles (primary, secondary container, surface containers, outline)
 * come from one teal-green seed. The default Material look is deliberately changed in four places:
 * a serif "reading" type tier for the content, a tonal button variant, the M3 emphasized motion curves,
 * and a shape scale (8 / 12 / 28 / full) applied by role. See DESIGN.md.
 */

// ---- Custom tokens exposed as CSS variables (theme.vars.palette.*) ----
interface Tonal {
  primaryContainer: string;
  onPrimaryContainer: string;
  secondaryContainer: string;
  onSecondaryContainer: string;
  errorContainer: string;
  onErrorContainer: string;
  surfaceContainerLow: string;
  surfaceContainer: string;
  surfaceContainerHigh: string;
  outline: string;
  outlineVariant: string;
  /** Highlight for passages cited as evidence. */
  evidence: string;
  evidenceStrong: string;
}

declare module '@mui/material/styles' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Palette extends Tonal {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface PaletteOptions extends Partial<Tonal> {}
  interface TypographyVariants {
    readingTitle: CSSProperties;
    readingLarge: CSSProperties;
    reading: CSSProperties;
    readingSmall: CSSProperties;
  }
  interface TypographyVariantsOptions {
    readingTitle?: CSSProperties;
    readingLarge?: CSSProperties;
    reading?: CSSProperties;
    readingSmall?: CSSProperties;
  }
}
declare module '@mui/material/Typography' {
  interface TypographyPropsVariantOverrides {
    readingTitle: true;
    readingLarge: true;
    reading: true;
    readingSmall: true;
  }
}
declare module '@mui/material/Button' {
  interface ButtonPropsVariantOverrides {
    tonal: true;
  }
}

const FONT_UI =
  "'Roboto Flex Variable', 'Roboto Flex', Roboto, system-ui, -apple-system, 'Segoe UI', sans-serif";
const FONT_READ = "'Source Serif 4 Variable', 'Source Serif 4', Georgia, 'Times New Roman', serif";
const FONT_MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace";

// Material 3 motion: emphasized curves, durations that stay under ~400ms for UI.
const EASING = {
  easeInOut: 'cubic-bezier(0.2, 0, 0, 1)',
  easeOut: 'cubic-bezier(0.05, 0.7, 0.1, 1)',
  easeIn: 'cubic-bezier(0.3, 0, 0.8, 0.15)',
  sharp: 'cubic-bezier(0.3, 0, 1, 1)',
};

export const SHAPE = { small: 8, medium: 12, large: 28 } as const;

const options: ThemeOptions = {
  cssVariables: { colorSchemeSelector: 'data' },
  colorSchemes: {
    light: {
      palette: {
        primary: { main: '#0c6b58', contrastText: '#ffffff' },
        secondary: { main: '#4a635b', contrastText: '#ffffff' },
        error: { main: '#ba1a1a', contrastText: '#ffffff' },
        background: { default: '#f3f6f4', paper: '#fafcfa' },
        text: { primary: '#171d1b', secondary: '#3f4945', disabled: '#6f7975' },
        divider: '#bfc9c3',
        primaryContainer: '#b8eedb',
        onPrimaryContainer: '#00201a',
        secondaryContainer: '#cce8de',
        onSecondaryContainer: '#07201a',
        errorContainer: '#ffdad6',
        onErrorContainer: '#410002',
        surfaceContainerLow: '#f0f4f2',
        surfaceContainer: '#eaefec',
        surfaceContainerHigh: '#e2e8e5',
        outline: '#6f7975',
        outlineVariant: '#bfc9c3',
        evidence: 'rgb(12 107 88 / 0.14)',
        evidenceStrong: 'rgb(12 107 88 / 0.3)',
      },
    },
    dark: {
      palette: {
        primary: { main: '#82d5be', contrastText: '#00382d' },
        secondary: { main: '#b1ccc2', contrastText: '#1c352d' },
        error: { main: '#ffb4ab', contrastText: '#690005' },
        background: { default: '#0f1513', paper: '#141a18' },
        text: { primary: '#dee4e0', secondary: '#bfc9c3', disabled: '#89938e' },
        divider: '#3f4945',
        primaryContainer: '#00513f',
        onPrimaryContainer: '#9ef2da',
        secondaryContainer: '#334b43',
        onSecondaryContainer: '#cde8de',
        errorContainer: '#93000a',
        onErrorContainer: '#ffdad6',
        surfaceContainerLow: '#171d1a',
        surfaceContainer: '#1b211e',
        surfaceContainerHigh: '#252b28',
        outline: '#89938e',
        outlineVariant: '#3f4945',
        evidence: 'rgb(130 213 190 / 0.18)',
        evidenceStrong: 'rgb(130 213 190 / 0.38)',
      },
    },
  },
  shape: { borderRadius: SHAPE.medium },
  transitions: {
    easing: EASING,
    duration: {
      shortest: 120,
      shorter: 160,
      short: 200,
      standard: 280,
      complex: 320,
      enteringScreen: 280,
      leavingScreen: 180,
    },
  },
  typography: {
    fontFamily: FONT_UI,
    fontSize: 16,
    htmlFontSize: 16,
    h1: {
      fontWeight: 560,
      fontSize: 'clamp(2rem, 1rem + 2.2vw, 2.75rem)',
      lineHeight: 1.06,
      letterSpacing: '-0.03em',
    },
    h2: { fontWeight: 560, fontSize: '1.5rem', lineHeight: 1.25, letterSpacing: '-0.01em' },
    h3: { fontWeight: 560, fontSize: '1.125rem', lineHeight: 1.3 },
    h5: { fontWeight: 560, fontSize: '1.5rem', lineHeight: 1.25, letterSpacing: '-0.01em' },
    h6: { fontWeight: 650, fontSize: '1.25rem', letterSpacing: '-0.015em' },
    subtitle1: { fontWeight: 560, fontSize: '1rem', lineHeight: 1.5 },
    subtitle2: {
      fontWeight: 560,
      fontSize: '0.9375rem',
      lineHeight: 1.45,
      letterSpacing: '0.005em',
    },
    body1: { fontSize: '1.0625rem', lineHeight: 1.55 },
    body2: { fontSize: '0.9375rem', lineHeight: 1.5 },
    caption: { fontSize: '0.8125rem', lineHeight: 1.45, letterSpacing: '0.01em' },
    button: { textTransform: 'none', fontWeight: 600, letterSpacing: '0.005em', fontSize: '1rem' },
    // The content itself is long-form reading: serif, optical sizing on, generous leading.
    readingTitle: {
      fontFamily: FONT_READ,
      fontWeight: 620,
      fontSize: 'clamp(1.6rem, 1.1rem + 1.6vw, 2.2rem)',
      lineHeight: 1.16,
      letterSpacing: '-0.012em',
      fontOpticalSizing: 'auto',
      overflowWrap: 'anywhere',
    },
    readingLarge: {
      fontFamily: FONT_READ,
      fontWeight: 430,
      fontSize: '1.3125rem',
      lineHeight: 1.5,
      fontOpticalSizing: 'auto',
      overflowWrap: 'anywhere',
    },
    reading: {
      fontFamily: FONT_READ,
      fontWeight: 430,
      fontSize: '1.1875rem',
      lineHeight: 1.55,
      fontOpticalSizing: 'auto',
      overflowWrap: 'anywhere',
    },
    readingSmall: {
      fontFamily: FONT_READ,
      fontWeight: 430,
      fontSize: '1rem',
      lineHeight: 1.6,
      fontOpticalSizing: 'auto',
      overflowWrap: 'anywhere',
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: (theme) => ({
        // Larger than the sticky app bar, so keyboard focus is never scrolled underneath it.
        html: { WebkitTextSizeAdjust: '100%', scrollPaddingTop: '88px' },
        'input::placeholder': { opacity: '0.75 !important' },
        body: {
          fontFeatureSettings: "'ss01'",
          WebkitFontSmoothing: 'antialiased',
          MozOsxFontSmoothing: 'grayscale',
          textRendering: 'optimizeLegibility',
          minHeight: '100dvh',
        },
        'h1, h2, h3': { textWrap: 'balance' },
        'p, li, blockquote': { textWrap: 'pretty' },
        '::selection': { background: theme.vars.palette.evidenceStrong },
        // Colours fade only when the theme is switched on purpose, never on first paint.
        'html.theme-fade, html.theme-fade *, html.theme-fade *::before, html.theme-fade *::after': {
          transition:
            'background-color 200ms ease, color 200ms ease, border-color 200ms ease !important',
        },
        '@media (prefers-reduced-motion: reduce)': {
          '*, *::before, *::after': {
            animationDuration: '0.01ms !important',
            animationIterationCount: '1 !important',
            transitionDuration: '0.01ms !important',
            scrollBehavior: 'auto !important',
          },
        },
        'code, pre': { fontFamily: FONT_MONO },
        '@media print': {
          body: { background: '#fff', color: '#000' },
          '.no-print': { display: 'none !important' },
          // Print is always dark text on white, whatever theme is on screen, and uses the full width.
          '.layout': { display: 'block !important' },
          '.sheet': { background: '#fff !important', border: 'none !important' },
          '.sheet, .sheet *': { color: '#000 !important' },
        },
      }),
    },
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { borderRadius: 999, minHeight: 40, paddingInline: 24 },
        sizeLarge: { minHeight: 52, fontSize: '1.0625rem' },
        sizeSmall: { minHeight: 36, paddingInline: 16, fontSize: '0.9375rem' },
        outlined: ({ theme }) => ({ borderColor: theme.vars.palette.outline }),
      },
      variants: [
        {
          // Material 3 "tonal" button: secondary-container fill, no outline.
          props: { variant: 'tonal' },
          style: ({ theme }) => ({
            backgroundColor: theme.vars.palette.secondaryContainer,
            color: theme.vars.palette.onSecondaryContainer,
            '&:hover': {
              backgroundColor: theme.vars.palette.secondaryContainer,
              filter: 'brightness(0.97)',
            },
          }),
        },
      ],
    },
    MuiIconButton: { styleOverrides: { root: { '&:active': { transform: 'scale(0.94)' } } } },
    MuiOutlinedInput: {
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: SHAPE.medium,
          backgroundColor: theme.vars.palette.background.paper,
          '& .MuiOutlinedInput-notchedOutline': { borderColor: theme.vars.palette.outline },
        }),
        input: { fontSize: '1.0625rem' },
      },
    },
    MuiPaper: { styleOverrides: { root: { backgroundImage: 'none' } } },
    MuiToggleButtonGroup: {
      styleOverrides: {
        root: ({ theme }) => ({
          borderRadius: 999,
          border: `1px solid ${theme.vars.palette.outline}`,
          overflow: 'hidden',
          backgroundColor: theme.vars.palette.background.paper,
        }),
        grouped: {
          border: 0,
          borderRadius: 0,
          '&:not(:first-of-type)': {
            borderLeft: '1px solid var(--mui-palette-outline)',
            marginLeft: 0,
          },
        },
      },
    },
    MuiToggleButton: {
      styleOverrides: {
        root: ({ theme }) => ({
          textTransform: 'none',
          minHeight: 44,
          paddingInline: 16,
          fontWeight: 520,
          fontSize: '0.9375rem',
          color: theme.vars.palette.text.secondary,
          '&.Mui-selected': {
            backgroundColor: theme.vars.palette.secondaryContainer,
            color: theme.vars.palette.onSecondaryContainer,
            fontWeight: 600,
          },
          '&.Mui-selected:hover': {
            backgroundColor: theme.vars.palette.secondaryContainer,
            filter: 'brightness(0.97)',
          },
          '&.Mui-focusVisible': {
            outline: `2px solid ${theme.vars.palette.primary.main}`,
            outlineOffset: -3,
          },
        }),
      },
    },
    MuiListItemButton: { styleOverrides: { root: { borderRadius: SHAPE.medium, minHeight: 56 } } },
    MuiAlert: {
      styleOverrides: {
        root: { borderRadius: SHAPE.medium, alignItems: 'flex-start' },
        standardInfo: ({ theme }) => ({
          backgroundColor: theme.vars.palette.surfaceContainerHigh,
          color: theme.vars.palette.text.primary,
          '& .MuiAlert-icon': { color: theme.vars.palette.text.secondary },
        }),
        outlinedError: ({ theme }) => ({
          backgroundColor: theme.vars.palette.errorContainer,
          color: theme.vars.palette.onErrorContainer,
          borderColor: theme.vars.palette.error.main,
          '& .MuiAlert-icon': { color: theme.vars.palette.error.main },
        }),
      },
    },
    MuiLinearProgress: { styleOverrides: { root: { height: 4, borderRadius: 2 } } },
    MuiTooltip: {
      styleOverrides: { tooltip: { borderRadius: SHAPE.small, fontSize: '0.8125rem' } },
    },
    MuiSkeleton: {
      defaultProps: { animation: 'wave' },
      styleOverrides: { root: { borderRadius: SHAPE.small } },
    },
  },
};

export const theme = createTheme(options);
