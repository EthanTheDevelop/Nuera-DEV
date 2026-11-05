import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_DATABASE_URL, E2E_PORT, E2E_SETUP_TOKEN } from './e2e/fixtures/env';

const desktopUse = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } };

/**
 * End-to-end tests (Playwright, Chromium only).
 *
 *   pnpm --filter @nuera/web e2e                          # port 3102, database nuera_e2e
 *   E2E_PORT=3105 E2E_DATABASE=nuera_x_e2e pnpm --filter @nuera/web e2e
 *
 * - global setup: drops/re-creates E2E_DATABASE, applies the migrations, warms the auth pages up;
 * - project "configuration" (desktop) creates the owner first; "desktop" (1440×1000) and "mobile"
 *   (390×844, iPhone-like Chromium) depend on it;
 * - web server: `next dev` on E2E_PORT with its own build dir (.next-e2e-<port>), that database,
 *   APP_URL = the test origin, a test SETUP_TOKEN, relaxed in-memory rate limits (dev only);
 * - one worker: the tests share one database and its single owner (e2e/fixtures/owner.ts).
 * Authenticated tests: `import { test, expect } from './fixtures'`.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  globalSetup: './e2e/fixtures/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // First compilations of `next dev` can be slow on the development machine.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: E2E_BASE_URL,
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    navigationTimeout: 120_000,
    actionTimeout: 30_000,
  },
  projects: [
    // Runs first on the fresh database: the owner setup through /configuration (tests tagged
    // @configuration in auth.spec.ts). Every other test then finds the owner and its state file.
    {
      name: 'configuration',
      testMatch: /auth\.spec\.ts$/,
      grep: /@configuration/,
      use: desktopUse,
    },
    {
      name: 'desktop',
      dependencies: ['configuration'],
      grepInvert: /@configuration/,
      use: desktopUse,
    },
    {
      name: 'mobile',
      dependencies: ['configuration'],
      grepInvert: /@configuration/,
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        userAgent: devices['iPhone 13'].userAgent,
      },
    },
  ],
  webServer: {
    command: `pnpm exec next dev --port ${E2E_PORT}`,
    url: `${E2E_BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 600_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NEXT_DIST_DIR: `.next-e2e-${E2E_PORT}`,
      DATABASE_URL: E2E_DATABASE_URL,
      APP_URL: E2E_BASE_URL,
      SETUP_TOKEN: E2E_SETUP_TOKEN,
      NUERA_RATE_LIMIT_FACTOR: '50',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
