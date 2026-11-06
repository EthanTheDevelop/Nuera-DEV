import { defineConfig, devices } from '@playwright/test';
import { E2E_ACCOUNTS, E2E_BASE_URL, E2E_STACK } from './e2e/fixtures/env';
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
/** Upgrade rehearsal (mise-a-niveau.spec.ts): only with E2E_UPGRADE=1, on a stack migrated from an older database. */
const UPGRADE = process.env.E2E_UPGRADE === '1';
const HARNESS_TESTS = /harness[\\/]test[\\/]/;

/**
 * End-to-end tests (Playwright, Chromium only) against a local TEST stack (apps/web/e2e/harness:
 * web `next dev` + one runner per server + fake GitHub + fake Claude CLI + real git repositories).
 *
 *   pnpm --filter @nuera/web e2e                                   # stack « e2e » (web 3102), 2 accounts
 *   node apps/web/e2e/harness/stack.mjs e2e --name w6 -- projects.spec.ts    # any stack, any shell
 *
 * - global setup: `stack up` for E2E_STACK (reused when it already runs). A stack created by this
 *   run (or E2E_PRISTINE=1) starts without owner, so that the « configuration » project creates it
 *   through /configuration;
 * - project « configuration » (desktop): the @configuration test of auth.spec.ts (skipped when the
 *   owner already exists);
 * - project « stack » (setup, e2e/stack.setup.ts): owner + GitHub source ensured; with E2E_ACCOUNTS ≥ 2
 *   (default for `e2e`), server « VPS-4 » registered, account B invited and activated, B's GitHub
 *   source; E2E_SEED / E2E_SEED_B scenarios;
 * - projects « desktop » (1440×1000) and « mobile » (390×844, touch) depend on both. The specs tagged
 *   @comptes (two accounts, several browser contexts — phones included) run in « desktop » only and
 *   skip themselves when the stack has a single account;
 * - one worker: every test shares the stack, its accounts and its servers.
 * Environment variables: e2e/fixtures/env.ts and apps/web/e2e/harness/README.md.
 * Authenticated tests: `import { test, expect } from './fixtures'`.
 */
export default defineConfig({
  testDir: './e2e',
  // Vitest unit tests of the harness (`test:harness`) live under e2e/harness/test.
  testIgnore: HARNESS_TESTS,
  // One folder per stack: Playwright empties its outputDir at start, and two lots can run their
  // suites at the same time in the same checkout.
  outputDir: `./test-results/${E2E_STACK}`,
  globalSetup: './e2e/fixtures/global-setup.ts',
  globalTeardown: './e2e/fixtures/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // First compilations of `next dev` can be slow; two runners on a slow Windows machine even more.
  timeout: E2E_ACCOUNTS >= 2 ? 270_000 : 180_000,
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
    // Then: owner ensured, GitHub sources connected through the real routes, other accounts, seeds.
    {
      name: 'stack',
      testMatch: /stack\.setup\.ts$/,
      dependencies: ['configuration'],
      timeout: 75 * 60_000,
      use: desktopUse,
    },
    {
      name: 'desktop',
      dependencies: ['stack'],
      grepInvert: /@configuration/,
      testIgnore: [/mise-a-niveau\.spec\.ts$/, HARNESS_TESTS],
      use: desktopUse,
    },
    {
      name: 'mobile',
      dependencies: ['stack'],
      grepInvert: /@configuration|@comptes/,
      testIgnore: [/mise-a-niveau\.spec\.ts$/, HARNESS_TESTS],
      use: mobileUse,
    },
    ...(UPGRADE
      ? [
          {
            name: 'mise-a-niveau',
            testMatch: /mise-a-niveau\.spec\.ts$/,
            dependencies: ['stack'],
            use: desktopUse,
          },
        ]
      : []),
  ],
});
