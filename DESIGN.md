# Digest design system

Read this before touching `apps/web`. It exists so the interface stays one coherent idea instead of drifting into defaults.

## Design read

A single-purpose reading tool for curious professionals and reviewers. **Material Design 3** expressed through **Material UI (MUI v7)** with a custom theme, so it feels like a native Google-ecosystem product rather than a template: tonal colour roles, state layers and ripples, the M3 shape scale, emphasized easing. The layout is the M3 _list-detail_ pattern: a sticky control pane on the left, the result "sheet" on the right (stacked on phones).

Fonts are Google Fonts, self-hosted through Fontsource (no third-party requests): **Roboto Flex** for the interface and **Source Serif 4** for the reading content (title, short summary, points, quotes), because the product is long-form reading.

## Visual thesis

**The summary is a document you can check, not a chat answer.** Every point carries the exact passage it came from and a plain statement of whether that passage was found in the page. The product's one authored moment is that evidence: a quote under each point, a ring that fills to show how much of the evidence was found, and a click that expands the passage in its real paragraph, highlighted. Everything else stays quiet so this reads as the point.

## What this is not

No gradient hero, no glass, no glow, no icon-tile grids, no card inside a card, no fake metrics or logos, no decorative dots, no emoji, no scroll cues, no section-number labels, no eyebrow above every heading, no em or en dashes in copy (enforced by `npm run hygiene`). The first-screen sample is a real captured result and is labelled as a sample.

## Where Material is customised (so it is not the default look)

1. **Reading type tier.** Four extra typography variants (`readingTitle`, `readingLarge`, `reading`, `readingSmall`) in Source Serif 4. UI chrome stays in Roboto Flex.
2. **Tonal button.** A `tonal` Button variant (secondary-container fill) for expanded and confirmed states.
3. **Shape scale by role:** buttons and segmented controls are full pills; inputs, quotes, list rows and alerts use 12 px; the result sheet uses 28 px. Nothing else.
4. **Motion.** M3 emphasized curves and short durations (see Motion).
5. **Tonal surfaces.** `surfaceContainerLow/Container/High` and `outline/outlineVariant` roles are exposed as `--mui-palette-*` variables; elevation is expressed by tone, not shadow.

## Tokens (source of truth: `src/theme.ts`)

Both schemes come from one teal-green seed. Contrast was checked by the automated axe audits in light and dark.

| Role                                  | Light                 | Dark                  |
| ------------------------------------- | --------------------- | --------------------- |
| background / paper                    | `#f3f6f4` / `#fafcfa` | `#0f1513` / `#141a18` |
| text primary / secondary              | `#171d1b` / `#3f4945` | `#dee4e0` / `#bfc9c3` |
| primary (actions, verified evidence)  | `#0c6b58`             | `#82d5be`             |
| secondary container (selected, tonal) | `#cce8de`             | `#334b43`             |
| error / error container               | `#ba1a1a` / `#ffdad6` | `#ffb4ab` / `#93000a` |
| outline / outline variant             | `#6f7975` / `#bfc9c3` | `#89938e` / `#3f4945` |
| evidence highlight                    | primary at 14% / 30%  | primary at 18% / 38%  |

One accent only. Error red is a state, never decoration. No pure white or black.

Type scale: display (h1) 32 to 44 px fluid, 24, 18, body 17 and 15 px, caption 13 px; reading sizes 19 px (points), 21 px (short summary), 16 px (source text, quotes 15 px), title 26 to 35 px fluid. Measure capped at 62ch. Numbers are tabular. Headings use `text-wrap: balance`, text blocks `text-wrap: pretty`. `dir="auto"` on user content so right-to-left pages read correctly.

## Components and states

Every component ships all the states it can have: idle, hover, focus-visible, pressed (ripple), disabled, loading, error, empty, success.

- **Address field:** MUI outlined `TextField`, label always floated so the placeholder shows, link icon, Clear or Paste action, inline error as an alert tied by `aria-describedby`.
- **Depth:** the first choice, a two-option segmented control, **Quick | Detailed** (Detailed is the default and has no other settings). Choosing Quick reveals Length and Format with a `Collapse`; choosing Detailed again hides them and restores the last Quick length next time. The hint under the control says what each does and how long it takes.
- **Primary action:** one persistent contained `Button`. While working it becomes an outlined Cancel (same element, so keyboard focus stays).
- **Segmented controls:** exclusive `ToggleButtonGroup` with the Material check mark on the selected option.
- **Sheet:** 28 px tonal surface. Site and meta, serif title (link to the original), notices only when true, short summary, evidence ring and statement, then either points (numbered for bullets) or, for a detailed brief, parts under h3 headings (Overview, Key takeaways, Section by section, Key facts, Caveats, What to do next) with an understanding line, stats, actions, optional page text and API panels.
- **Evidence:** reading comes first. Each point ends with a small inline pill ("Source", check icon) that sits in the line of text. It opens, with `Collapse`, the quote and the paragraph around it with the passage highlighted. "Show all evidence" opens every one. Unverified evidence is never hidden: its pill is dashed and reads "Unchecked", and opening it says "Not found in the page". A point whose figures are not in the page gets a one-line warning under it. Paragraph summaries have no number column, so they read as continuous prose. The pill is 24 px high with an invisible larger hit area (the one deliberate exception to the 44 px target rule, because it lives inside a line of text).
- **Loading:** the literal word "Loading…", two real steps (three in Detailed: fetching, reading the whole page and checking the notes, writing the brief) driven by server events, a `LinearProgress`, then skeleton lines until the first text arrives. Points then grow into place.
- **Errors:** MUI `Alert` (error, outlined) with a title, the specific message, one clear action (retry with countdown, or try another link), and collapsible support details with the request id.

## Small conveniences

- **Back to top:** a round primary button, bottom right, shown after scrolling about a third of the window height (never less than 240 px) with an 80 px hysteresis so it never flickers. It scrolls home, then moves focus to the headline so keyboard and screen-reader users are not left on a button that vanished. Hidden in print; clear of the iPhone home indicator.
- **Remembered choices:** depth, length, format and language are stored in this browser. A link's own `?length=` and `?lang=` always win; corrupted or unknown stored values are ignored.
- **Paste anywhere:** a link pasted outside a field fills the address field; ordinary text and pastes into fields are left alone.

## Motion

Purpose first. Used for: a point arriving (`Collapse` height plus `Fade`, 380 to 480 ms, emphasized easing), expanding a passage or a panel (`Collapse`, 300 ms), the evidence ring filling (700 ms), the app bar taking a tonal colour on scroll, the theme icon rotating, press feedback (ripple and a 0.94 scale on icon buttons), a crossfade between sample, loading, result and error. Nothing animates on keyboard shortcuts. `prefers-reduced-motion` collapses every duration to near zero globally.

## Accessibility contract

WCAG 2.2 AA. Everything reachable and operable by keyboard; visible focus; targets at least 44 px; one `h1`; landmarks (`header`, `main`, `footer`); a polite live region announces progress and results and an alert region announces errors; focus moves to the result title when a summary completes; colour is never the only signal (evidence status has an icon and words); the result scrolls into view if it is off screen; works at 200% zoom and 320 px. Automated axe audits run in both themes for the first screen, a fully expanded result and the error state.

## Copy rules

Plain, specific, functional. No filler verbs, no mock-poetic labels, no dashes as punctuation, one label per intent. Errors say what happened and what to do next.

## Review checklist (run before every UI change ships)

1. Could this screen be pasted into an unrelated product unchanged? If yes, make it more specific.
2. Is every colour, border, shadow, and animation doing a job?
3. Are all states present, including worst-case data (very long titles, no author, 100 words, 100k words, non-Latin and right-to-left text)?
4. Is it correct in both themes, at 320 px, and with reduced motion?
5. Did the automated accessibility checks and the keyboard-only run pass?
