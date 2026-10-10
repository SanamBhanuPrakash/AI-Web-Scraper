import { describe, expect, it } from 'vitest';
import { figureSet, unverifiedFigures } from '../src/llm/figures.js';
import { createMockProvider } from '../src/llm/mock.js';
import { buildPrompt, LENGTH_PRESETS } from '../src/llm/prompt.js';
import { LlmRouter } from '../src/llm/router.js';
import { summarizeScraped, type StreamEvent } from '../src/llm/summarize.js';
import type { ScrapeResult } from '../src/pipeline/scrape.js';

/** Summary quality guards: invented figures are flagged, and the prompt keeps the rules that make summaries good. */

describe('figure check', () => {
  const source = figureSet(
    'Revenue grew 14% to $1,600 million in 2023. The model has 175.5 billion parameters. Version 3.5.',
  );
  it('accepts figures that appear in the page, whatever the separators', () => {
    expect(unverifiedFigures('Revenue grew 14% in 2023 to 1600 million.', source)).toEqual([]);
    expect(unverifiedFigures('It has 175.5 billion parameters.', source)).toEqual([]);
    expect(unverifiedFigures('Revenue was $1.600 million.', source)).toEqual([]);
  });
  it('flags figures the page never states', () => {
    expect(unverifiedFigures('Revenue grew 40% in 2024.', source)).toEqual(['40', '2024']);
  });
  it('ignores single digits, which are often counts the model derived', () => {
    expect(unverifiedFigures('There are 3 steps and 7 options.', source)).toEqual([]);
  });
  it('does not repeat a figure and trims sentence punctuation', () => {
    expect(unverifiedFigures('It reached 99. Then 99 again, and 99.', source)).toEqual(['99']);
  });
});

describe('summarizeScraped flags invented figures on the point that contains them', () => {
  const body =
    'Acme Corp reported that revenue grew 14 percent in 2023, driven by cloud subscriptions and a new analytics product. ' +
    'The company also said it will hire 300 engineers over the next two years to expand its research group.';
  const scraped: ScrapeResult = {
    page: {
      url: 'https://example.com/a',
      finalUrl: 'https://example.com/a',
      title: 'Acme',
      wordCount: 40,
      readingMinutes: 1,
      usedWords: 40,
      truncated: false,
      confidence: 'high',
      extractionMethod: 'readability',
    },
    fullText: body,
    promptText: body,
    timingsMs: { fetch: 1, extract: 1 },
  };
  it('marks a wrong number but leaves a correct one alone', async () => {
    const provider = {
      ...createMockProvider({
        script: () =>
          'TLDR: Acme grew.\n' +
          'POINT: Revenue grew 40 percent in 2023. | QUOTE: "revenue grew 14 percent in 2023, driven by cloud subscriptions"\n' +
          'POINT: Acme will hire 300 engineers. | QUOTE: "it will hire 300 engineers over the next two years"\n',
      }),
    };
    const router = new LlmRouter({ providers: [provider] });
    const events: StreamEvent[] = [];
    for await (const e of summarizeScraped({ router }, scraped, {
      length: 'short',
      format: 'bullets',
    }))
      events.push(e);
    const points = events.filter((e) => e.type === 'point') as Array<
      Extract<StreamEvent, { type: 'point' }>
    >;
    expect(points[0]!.unverifiedFigures).toEqual(['40']);
    expect(points[1]!.unverifiedFigures).toBeUndefined();
  });
});

describe('prompt v3 quality rules', () => {
  const base = { pageText: 'x', title: 't', format: 'bullets', length: 'medium' } as const;
  const system = buildPrompt(base, 'n').system;
  it('asks for the answer first, specifics, and no filler openers', () => {
    expect(system).toContain('The TLDR is the answer');
    expect(system).toMatch(/Never begin with "The article"/);
    expect(system).toMatch(/Name things instead of gesturing/);
  });
  it('adapts to the kind of page', () => {
    for (const kind of [
      'Tutorial or how-to',
      'News or report',
      'Research paper',
      'Opinion or essay',
    ])
      expect(system).toContain(kind);
  });
  it('asks for evidence that backs the claim, not a fragment', () => {
    expect(system).toMatch(/8 to 25 words/);
    expect(system).toMatch(/Never quote a heading/);
  });
  it('sets target lengths (about N, not at most N) for every preset', () => {
    for (const length of ['short', 'medium', 'long'] as const) {
      const p = buildPrompt({ ...base, length }, 'n').system;
      expect(p).toContain(`about ${LENGTH_PRESETS[length].itemWords} words`);
      expect(p).not.toMatch(/at most \d+ words/);
    }
  });
  it('paragraph mode asks for connected prose, not a list', () => {
    const p = buildPrompt({ ...base, format: 'paragraph' }, 'n').system;
    expect(p).toMatch(/flowing prose, not a list/);
  });
});
