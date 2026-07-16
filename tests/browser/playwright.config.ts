import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  timeout: 45_000,
  expect: { timeout: 8_000 },
  // Tests within a file share one booted CMS and run in order; files
  // parallelize across workers (each worker boots its own instances).
  fullyParallel: false,
  workers: 3,
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    viewport: { width: 1360, height: 850 },
    trace: 'retain-on-failure',
  },
});
