import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const api = {
  '/api': { target: process.env['API_URL'] ?? 'http://127.0.0.1:8787', changeOrigin: false },
};

/**
 * The production security headers live in vercel.json (single source of truth). The preview server, which
 * the browser tests run against, applies the very same headers, so a Content-Security-Policy violation fails a
 * test locally instead of surprising us after deploy.
 */
function productionHeaders(): Record<string, string> {
  try {
    const cfg = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as {
      headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
    };
    const all = cfg.headers?.find((h) => h.source === '/(.*)')?.headers ?? [];
    return Object.fromEntries(all.map((h) => [h.key, h.value]));
  } catch {
    return {};
  }
}

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: api },
  preview: { port: 4173, proxy: api, headers: productionHeaders() },
  // The app is a single screen built on React and Material UI (about 174 kB gzip); splitting it would add requests for no gain.
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 700 },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
