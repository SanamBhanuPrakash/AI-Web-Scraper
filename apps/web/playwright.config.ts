import { defineConfig } from '@playwright/test';

// Locally on Windows/macOS you can reuse an installed browser: PW_CHANNEL=msedge (or chrome).
// In CI run `npx playwright install --with-deps chromium` and leave PW_CHANNEL unset.
const channel = process.env['PW_CHANNEL'];

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env['CI'] ? 2 : 4,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['list']] : 'list',
  use: {
    // The UI is reached as "localhost" while the fixture site is 127.0.0.1: the API refuses to fetch its own hostname.
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    ...(channel ? { channel } : {}),
  },
  webServer: [
    {
      command: 'npm run e2e-server -w @digest/api',
      cwd: '../..',
      url: 'http://127.0.0.1:8790/api/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 60_000,
    },
    {
      command: 'npm run build && npm run preview',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: { API_URL: 'http://127.0.0.1:8790' },
    },
  ],
});
