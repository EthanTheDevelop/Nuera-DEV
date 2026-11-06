import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Every suite creates and migrates its own databases on the local PostgreSQL (`pnpm db:local`):
    // generous timeouts on a slow Windows dev machine, one file at a time (shared cluster, roles).
    testTimeout: 120_000,
    hookTimeout: 300_000,
    fileParallelism: false,
    pool: 'forks',
  },
});
