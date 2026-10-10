// Applies the saved (or system) colour scheme before first paint so there is no flash of the wrong theme.
// Material UI stores the choice under "mui-mode" ("light", "dark" or "system") and marks the root element with
// data-light or data-dark. Kept as a file (not inline) so the Content-Security-Policy can forbid inline scripts.
try {
  const mode = localStorage.getItem('mui-mode');
  const dark =
    mode === 'dark' ||
    ((mode === 'system' || !mode) && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.removeAttribute('data-light');
  root.removeAttribute('data-dark');
  root.setAttribute(dark ? 'data-dark' : 'data-light', '');
} catch {
  /* storage blocked: Material UI falls back to the system preference */
}
