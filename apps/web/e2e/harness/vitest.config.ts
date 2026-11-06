import { defineConfig } from 'vitest/config';

/**
 * TEST-ONLY — unit tests of the e2e harness itself (ports, state upgrade, netstat parsing, multi-app
 * fake GitHub, command line). `pnpm --filter @nuera/web test:harness`. The web's own Vitest config
 * excludes e2e/**: these run apart, without a stack.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/harness/test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    restoreMocks: true,
  },
});
