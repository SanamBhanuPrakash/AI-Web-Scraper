import { ERROR_CODES, FORMATS, LENGTHS } from '@digest/shared';

/** Machine-readable API description (F-27), generated from the same constants the code uses. */
export function buildOpenApi(version: string) {
  const errorCodes = Object.keys(ERROR_CODES);
  const errorBody = {
    type: 'object',
    required: ['requestId', 'error'],
    properties: {
      requestId: { type: 'string', format: 'uuid' },
      error: {
        type: 'object',
        required: ['code', 'message', 'retryable'],
        properties: {
          code: { type: 'string', enum: errorCodes },
          message: { type: 'string' },
          retryable: { type: 'boolean' },
          retryAfterSec: { type: 'integer', minimum: 1 },
        },
      },
    },
  } as const;
  const point = {
    type: 'object',
    required: ['kind', 'text', 'grounded'],
    properties: {
      kind: { type: 'string', enum: ['bullet', 'paragraph'] },
      text: { type: 'string' },
      quote: {
        type: 'string',
        description: 'Passage copied from the page that supports the point.',
      },
      grounded: {
        type: 'boolean',
        description: 'True when the quote was found verbatim in the page text.',
      },
      section: {
        type: 'string',
        enum: ['overview', 'takeaway', 'section', 'fact', 'caveat', 'next'],
        description:
          'Part of a detailed brief this point belongs to. Absent for short, medium and long.',
      },
      heading: {
        type: 'string',
        description: 'Name of the page section that a `section` point summarizes.',
      },
      unverifiedFigures: {
        type: 'array',
        items: { type: 'string' },
        description: 'Numbers written in the point that the page never states (likely invented).',
      },
    },
  } as const;

  return {
    openapi: '3.1.0',
    info: {
      title: 'Digest API',
      version,
      description:
        'Summarize a public web page. The server fetches the URL with SSRF protection, extracts the main text, and asks a free-tier LLM for a short summary in which every point can carry a verified evidence quote.',
    },
    paths: {
      '/api/summarize': {
        post: {
          summary: 'Summarize a web page',
          description:
            'Send `Accept: text/event-stream` to receive Server-Sent Events (`phase`, `meta`, `tldr`, `point`, `done`, `error`). Otherwise a single JSON document is returned.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['url'],
                  properties: {
                    url: {
                      type: 'string',
                      maxLength: 2048,
                      example: 'https://en.wikipedia.org/wiki/Web_scraping',
                    },
                    length: {
                      type: 'string',
                      enum: [...LENGTHS],
                      default: 'medium',
                      description:
                        '`detailed` reads the whole page first, verifies the notes against it, then writes a structured brief (overview, takeaways, section by section, facts, caveats, next steps). It takes about 10 to 20 seconds and ignores `format`.',
                    },
                    format: { type: 'string', enum: [...FORMATS], default: 'bullets' },
                    includeText: {
                      type: 'boolean',
                      default: false,
                      description:
                        'Also return the extracted page text (`sourceText`) so evidence quotes can be located.',
                    },
                    language: {
                      type: 'string',
                      description:
                        'BCP-47 tag for the summary language; default is the page language.',
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Summary (JSON) or an event stream.',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['requestId', 'page', 'summary', 'stats', 'meta'],
                    properties: {
                      requestId: { type: 'string' },
                      page: {
                        type: 'object',
                        description:
                          'Title, site, author, dates, word counts, confidence, truncation.',
                      },
                      summary: {
                        type: 'object',
                        properties: {
                          tldr: { type: 'string' },
                          points: { type: 'array', items: point },
                        },
                      },
                      stats: { type: 'object' },
                      meta: { type: 'object' },
                    },
                  },
                },
                'text/event-stream': { schema: { type: 'string' } },
              },
            },
            default: {
              description:
                'Error. `error.code` is one of the documented codes; HTTP status follows the code.',
              content: { 'application/json': { schema: errorBody } },
            },
          },
        },
      },
      '/api/health': {
        get: {
          summary: 'Liveness and configured providers',
          responses: { '200': { description: 'OK' } },
        },
      },
    },
    'x-error-codes': Object.fromEntries(
      Object.entries(ERROR_CODES).map(([k, v]) => [
        k,
        { status: v.status, retryable: v.retryable },
      ]),
    ),
  };
}
