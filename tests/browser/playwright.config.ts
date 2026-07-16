import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // Each test boots its own CMS (in-memory Postgres + a ~300KB admin bundle).
  // Run serially so heavy concurrent boots can't induce load-timeouts — a
  // browser E2E suite should be deterministic, not fast. One retry absorbs
  // any residual transient (edodo mount timing, etc.).
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    viewport: { width: 1360, height: 850 },
    trace: 'retain-on-failure',
  },
});
