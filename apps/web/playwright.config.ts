import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_STACK } from './e2e/fixtures/env';
import { chromiumLaunchOptions } from './e2e/harness/chromium';

const launchOptions = chromiumLaunchOptions();
const desktopUse = { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, launchOptions };
const mobileUse = {
  browserName: 'chromium' as const,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent: devices['iPhone 13'].userAgent,
  launchOptions,
};

/**
 * End-to-end tests (Playwright, Chromium only) against a local TEST stack (apps/web/e2e/harness:
 * web `next dev` + runner + fake GitHub + fake Claude CLI + real git repositories).
 *
 *   pnpm --filter @nuera/web e2e                                   # stack « e2e » (web 3102)
 *   E2E_STACK=projets E2E_WEB_PORT=3301 pnpm --filter @nuera/web e2e projets.spec.ts
 *
 * - global setup: `stack up` for E2E_STACK (reused when it already runs). A stack created by this
 *   run (or E2E_PRISTINE=1) starts without owner, so that the « configuration » project creates it
 *   through /configuration;
 * - project « configuration » (desktop): the @configuration test of auth.spec.ts (skipped when the
 *   owner already exists);
 * - project « stack » (setup, e2e/stack.setup.ts): owner + GitHub App ensured, E2E_SEED scenarios;
 * - projects « desktop » (1440×1000) and « mobile » (390×844, touch) depend on both;
 * - one worker: every test shares the stack and its single owner.
 * Environment variables: e2e/fixtures/env.ts and apps/web/e2e/harness/README.md.
 * Authenticated tests: `import { test, expect } from './fixtures'`.
 */
export default defineConfig({
  testDir: './e2e',
  // One folder per stack: Playwright empties its outputDir at start, and two lots can run their
  // suites at the same time in the same checkout.
  outputDir: `./test-results/${E2E_STACK}`,
  globalSetup: './e2e/fixtures/global-setup.ts',
  globalTeardown: './e2e/fixtures/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // First compilations of `next dev` can be slow.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: `playwright-report/${E2E_STACK}` }]] : [['list']],
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
    // First, on a stack without owner: the owner setup through /configuration.
    {
      name: 'configuration',
      testMatch: /auth\.spec\.ts$/,
      grep: /@configuration/,
      use: desktopUse,
    },
    // Then: owner ensured, GitHub App connected through the real routes, seed scenarios.
    {
      name: 'stack',
      testMatch: /stack\.setup\.ts$/,
      dependencies: ['configuration'],
      timeout: 45 * 60_000,
      use: desktopUse,
    },
    {
      name: 'desktop',
      dependencies: ['stack'],
      grepInvert: /@configuration/,
      use: desktopUse,
    },
    {
      name: 'mobile',
      dependencies: ['stack'],
      grepInvert: /@configuration/,
      use: mobileUse,
    },
  ],
});
