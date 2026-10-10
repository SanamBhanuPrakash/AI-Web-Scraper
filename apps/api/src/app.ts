import { Hono } from 'hono';
import type { Env } from './lib/env.js';
import { toApiError } from './lib/errors.js';
import type { Logger } from './lib/logger.js';

export interface AppDeps {
  env: Env;
  logger: Logger;
}

/** Web-standard Hono app: runs unchanged on Vercel, Node, or any fetch-compatible runtime. */
export function createApp(deps: AppDeps) {
  const app = new Hono<{ Variables: { requestId: string } }>();

  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    c.header('Cache-Control', 'no-store');
    await next();
  });

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      providers: {
        gemini: Boolean(deps.env.GEMINI_API_KEY),
        groq: Boolean(deps.env.GROQ_API_KEY),
        mock: deps.env.DIGEST_MOCK_LLM,
      },
    }),
  );

  app.notFound((c) =>
    c.json(
      {
        requestId: c.get('requestId'),
        error: { code: 'invalid_request' as const, message: 'Not found.', retryable: false },
      },
      404,
    ),
  );

  app.onError((err, c) => {
    const requestId = c.get('requestId') ?? 'unknown';
    const { status, body } = toApiError(err, requestId);
    deps.logger.error('unhandled', { requestId, errorCode: body.error.code, err: err instanceof Error ? err.message : String(err) });
    return c.json(body, status as 500);
  });

  return app;
}
