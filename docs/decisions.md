# Decision record

Short architecture decision records. Each states the context, the choice, what was rejected, and the consequence.

## 1. TypeScript end to end, one monorepo

**Context.** The brief allows any stack. The free hosting constraint and the dev machine matter: Node was the only runtime installed, Fly.io no longer has a free tier, Render's free tier sleeps for about a minute, and Vercel cannot host a JVM server.
**Decision.** TypeScript everywhere, npm workspaces: `apps/api`, `apps/web`, `packages/shared`.
**Rejected.** Java/Spring Boot + Angular (needs a sleeping Render container, two deployables, no JDK installed); Go or Rust backend (second language, duplicated contracts, beta runtime on Vercel); Python (not installed, duplicated types); Next.js (viable, but blurs the frontend/backend split the brief asks to document).
**Consequence.** One shared set of types and error codes, one toolchain, one deploy, one URL.

## 2. One Vercel project, same-origin API

**Decision.** Static SPA plus a Hono app exported from `api/[...path].ts`. The catch-all file name keeps original URLs, so no rewrites.
**Consequence.** No CORS, no cold-start sleep, generous limits (300 s, 2 GB). `vercel.json` carries the build, headers and `supportsCancellation`.

## 3. SSRF defence at connect time

**Context.** A service that fetches arbitrary URLs is an SSRF target. Validating a hostname and then connecting leaves a DNS-rebinding window, and validators that parse URLs differently from the HTTP client have caused real CVEs.
**Decision.** Resolve all DNS records inside the socket's own `lookup`, reject if any is non-public, and connect to that answer. IP literals are validated up front. Redirects are manual and re-validated per hop. The validator and the client share one WHATWG `URL` object.
**Consequence.** No check/use gap. Covered by a 40+ case table, property tests against an independent oracle, parser-differential cases, and hostile-server integration tests.

## 4. The permissive test policy is a constructor argument, never configuration

**Decision.** Tests inject a permissive URL policy through `createApp`/`createSafeFetcher` arguments. There is no environment variable that can weaken the production policy.
**Consequence.** Production behaviour cannot be loosened by misconfiguration.

## 5. Gemini first, Groq as fallback, size-aware order

**Context.** Verified live: Gemini 2.5 models are closed to new accounts; Gemini 3.5 Flash Lite works but has variable latency (1.4 to 7 s); Groq's qwen model answers in about 0.2 s but its free tier allows only about 8k tokens per minute.
**Decision.** Thin REST adapters behind one interface (no vendor SDKs). Fallback only before the first token. Pages that fit Groq's small budget go to Groq first; longer pages go to Gemini first.
**Consequence.** About 1 s for typical articles, large context for long ones, no spliced answers. Model ids are environment-configurable because providers retire models.

## 6. Grounded summaries: verify quotes mechanically

**Context.** Hallucinated or misattributed evidence is the main failure of LLM summaries.
**Decision.** Ask for a verbatim quote per point and verify it against the text the model saw (verbatim, near-verbatim, or in order with asides skipped). Unverified points are kept but labelled.
**Rejected.** Dropping unverified points (silently deletes legitimate paraphrases); an LLM judge (cost, latency, another thing to trust).
**Consequence.** A user can see exactly what was checked. Honest limit: it proves the quote exists, not that the point is true.

## 6b. Line protocol instead of JSON for model output

**Decision.** `TLDR:` and `POINT: text | QUOTE: "..."` lines.
**Why.** Streams naturally (each line is complete on its own), degrades gracefully when a model misformats, and cannot produce markup that reaches the UI.

## 7. Stateless service, optional Redis

**Decision.** No database. In-memory cache and limiter by default; Upstash REST adapters make them global, with fail-over to memory (never fail open).
**Consequence.** Nothing to provision for a reviewer; honest documentation that the in-memory limiter is best-effort on serverless.

## 8. Material UI with a custom Material 3 theme

**Context.** The owner asked for Material UI, Google Fonts, and a designer-level, non-generic result.
**Decision.** MUI v7, CSS variables colour schemes, custom tonal palette and shape scale, a serif reading tier, a tonal button variant, M3 motion curves. Roboto Flex and Source Serif 4, self-hosted via Fontsource. Material icons only.
**Consequence.** Recognisable Material behaviour (ripples, state layers, focus) with a specific identity (evidence ring, passage-in-context). Emotion injects styles at runtime, so the CSP allows inline styles; scripts stay `'self'` only.

## 9. Evidence expands in place

**Decision.** Clicking a quote reveals the surrounding paragraph with the passage highlighted directly under the point, instead of scrolling to a text panel far below.
**Why.** Measured in screenshots: a distant panel looked like the click did nothing.

## 10. Plain-text pipeline end to end

**Decision.** Extracted text and model output are plain text; the UI renders them through React as text. There is no HTML sink and a lint rule forbids `dangerouslySetInnerHTML`.

## 11. Hostile markup is rejected before parsing

**Context.** Measured: parsing 60,000 nested elements took 150 s in the DOM library.
**Decision.** A linear pre-check on tag count and nesting depth (tolerant of unclosed `<p>` and `<li>`), plus depth, node, and container caps in the extractor.
**Consequence.** A 2 MB page can no longer pin a function for minutes.

## 12. Walls and interstitials are detected, not summarized

**Decision.** Classify bot challenges, consent and sign-in walls, soft 404s; follow one validated meta refresh; refuse YouTube/X/Instagram-style sites up front with a specific message.
**Why.** Summarizing a cookie banner confidently is worse than saying "this page needs sign-in".

## 13. No robots.txt enforcement for one user-initiated fetch

**Decision.** Honest `DigestBot` user agent, one request per action, no crawling; robots.txt is not consulted (same stance as link-preview services). Documented in the README.
**Revisit if** the service ever fetches in bulk or on a schedule.

## 14. Privacy by construction

**Decision.** Logs contain the target host, never the path, query or page text. Summaries are not stored server-side beyond a 1 h cache keyed by hash. History lives in the browser. The UI states that page text is sent to the AI provider.

## 15. Third-party agent skills are installed project-scoped after review

**Decision.** Reviewed before installing; rejected anything that runs hooks, downloads binaries, fetches mutable remote instructions, or uploads project code.

## 16. Summary quality is measured, and evidence stays out of the reading line

**Context.** The first prompt said what not to do (invent, obey the page) but not what a good summary is. Measured on 8 real pages it produced filler openers ("The article discusses..."), vague points with few names or numbers, 12 to 17 word points when 25 to 35 were allowed ("at most N words" makes models terse), and 4 to 6 word quote fragments that did not back the claim. In paragraph mode a quote block after every paragraph broke the reading flow.

**Decision.**

1. Prompt v3 states what good looks like: the TLDR is the answer, not a description of the page; concrete detail over generalities; name the steps and factors instead of saying "several"; order by importance and cover the whole page; attribute opinions; adapt to the kind of page (tutorial, news, paper, docs, essay, product, index); choose the quote from the sentence that states the claim (8 to 25 words); target lengths ("about N") instead of ceilings.
2. A deterministic **figure check**: every number of two or more digits in a point must occur in the page. Mismatches are returned as `unverifiedFigures` and shown as a plain warning on that point. Quote grounding proves a passage exists; this catches the other common failure, a wrong number next to a real quote.
3. `npm run eval -w @digest/api` runs 8 fixed real pages and reports grounded share, invented figures, filler openers, vague wording, concrete-detail share and repetition, and saves the full text for reading. Changes to the prompt are judged against it.
4. The Gemini input budget rises from 60k to 150k characters so long essays are summarized from beginning to end, not head and tail.
5. UI: the summary is clean prose or bullets. Each point ends with a small inline "Source" marker that opens the quote and its place in the page; "Show all evidence" opens everything. Unverified evidence is marked "Unchecked" even when closed, because that is trust information.

**Result (same 8 pages, v2 to v3).** Filler openers 5 to 0 of 40; points with a concrete name or number 32% to 65%; average point length 12 to 17 words up to 17 to 28; all 40 cited passages found; no invented figures.

**Limits.** The metrics are heuristics, not a judge of truth. The figure check ignores single digits and number words. Quote verification still proves presence, not that the claim is correct.

## 17. Detailed briefs are read first, verified in code, then written from the notes

**Context.** A single call that reads a page and writes the summary at once has to understand, select, order and phrase in one breath. Measured weaknesses even after prompt v3: little coverage of the middle of long pages (head and tail budgeting), thin handling of code-heavy pages, repetition when forced to fill a fixed number of lines, and evidence that the model re-types and sometimes gets slightly wrong.

**Decision.** `length: detailed` runs two passes.

1. **Read.** The whole page (parts of at most 120k characters, up to 4, in parallel) goes to a large-context model with a JSON-only prompt. It returns the page type, purpose, audience, thesis, an outline of the page's real sections, and 25 to 40 findings, each with an importance score and an exact quote. Pass 1 is routed away from small-context "fast" providers (`needsLargeContext`).
2. **Verify in code.** A finding survives only if its quote occurs in the page and every figure in its statement occurs in the page; near-duplicates merge; at most 40 are kept, most important first, in page order.
3. **Write.** A second call sees only the verified notes (not the page) and writes TLDR, overview, takeaways, a section-by-section walk through the page, facts, caveats and next steps, citing note ids. The evidence for a line is the note's stored quote, not text the writer typed. The number of lines requested scales with the number of notes, and a line that restates an earlier one is dropped.
4. If the notes are unusable, fall back to a single `long` pass (`meta.mode: standard`) instead of failing.

**Why not alternatives.**

- _One bigger prompt with "think step by step":_ no checkable intermediate, no way to verify what the model understood, and no control over repetition.
- _Map-reduce on every page:_ slower and more quota for pages that fit in one request. Parts are only used when the page is too long.
- _A stronger model for reading:_ `gemini-3.5-flash` took 28 s and returned a 503 on the free tier; flash-lite reads a typical page in 3 to 10 s with the same structure.
- _Giving the writer the page too:_ doubles the input tokens and lets the writer cite text nobody verified.

**Measured (8 real pages, flash-lite).** All 8 ran in deep mode in 4.8 to 16.3 s. 143 of 143 cited passages verified, no invented figures, evidence from 6.9 of 10 tenths of each page on average (the one-paragraph abstract is naturally low). A 23,000-word page was read in two parallel parts in 12 s.

**Costs and limits.** Two or more model calls per request and 10 to 20 s of latency, so Quick remains. Notes are only as good as the reader's attention: the verifier removes false findings but cannot add missed ones. The brief is about the page, not the world.
