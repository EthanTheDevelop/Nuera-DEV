import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Real processes (git, PTY, fake CLI) on a slow Windows dev machine: generous timeouts,
    // one file at a time (shared database, PTY start-up).
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
    globalSetup: ['test/global-setup.ts'],
  },
});
