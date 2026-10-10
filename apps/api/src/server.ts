import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadEnv } from './lib/env.js';
import { createLogger } from './lib/logger.js';

// Local development entry point. In production the same `createApp` is mounted by api/index.ts on Vercel.
const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const app = createApp({ env, logger });

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info('api listening', { port: info.port });
});
