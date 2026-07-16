import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Black-box tests boot real instances; keep files isolated but sequential
    // enough to avoid port/db races.
    pool: 'forks',
    maxConcurrency: 4,
  },
});
