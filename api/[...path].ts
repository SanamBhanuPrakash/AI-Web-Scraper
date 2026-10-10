// Vercel Function entry (Node runtime, Fluid compute). The catch-all file name makes every /api/* path
// reach this handler with its ORIGINAL URL, so the Hono app's own routes match unchanged.
// The same `createApp` runs locally through apps/api/src/server.ts.
import { createApp } from '../apps/api/src/app.js';
import { assertLlmConfigured, loadEnv } from '../apps/api/src/lib/env.js';
import { createLogger } from '../apps/api/src/lib/logger.js';
import { buildRouter } from '../apps/api/src/llm/providers.js';

const env = loadEnv();
assertLlmConfigured(env);
const logger = createLogger(env.LOG_LEVEL);
const app = createApp({ env, logger, router: buildRouter(env, logger) });

export default {
  fetch: (request: Request): Response | Promise<Response> => app.fetch(request),
};
