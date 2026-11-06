import { existsSync } from 'node:fs';
import path from 'node:path';
import { devices, test as base, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { SessionStatusValue } from '@nuera/shared/runner';
import type { StackKey } from '../harness/config';
import { E2E_ACCOUNTS, E2E_STATE_DIR, accountStateFile } from './env';
import { createOwnerAndSignIn, signInAs } from './owner';
import {
  cliHelpers,
  seedStack,
  stackRunnerApi,
  stackState,
  waitForSessionStatus,
  type CliHelpers,
  type RunnerApi,
  type SeededData,
  type SessionDto,
  type StackState,
  type WaitForSessionOptions,
} from './stack';

export * from './admin';
export * from './env';
export * from './owner';
export * from './paths';
export * from './stack';
export { expect } from '@playwright/test';

/** Another account of the stack, signed in in its own browser context (its own cookies). */
export interface AccountSession {
  key: StackKey;
  context: BrowserContext;
  page: Page;
  /** Runner of that account's server. */
  runnerApi: RunnerApi;
  /** Fake CLI helpers acting for that account (its server, its projects, its user id). */
  cli: CliHelpers;
}

export interface StackFixtures {
  /** state.json of the stack under test (urls, ports, accounts, runners, repos, `seeded` ids), read once per test. */
  stack: StackState;
  /** Typed calls to the runner of account A's server: `await runnerApi('getSession', { params: { sessionId } })`. */
  runnerApi: RunnerApi;
  /** Idempotent seed scenarios: `await seed('sessions')` → the up-to-date `seeded` block (`seed('projects', { account: 'b' })`). */
  seed: (...scenarios: Array<string | { account: StackKey }>) => Promise<SeededData>;
  /** `await waitForSessionStatus(id, 'waiting_input')` (or an array of statuses; `{ account: 'b' }` for B's server). */
  waitForSessionStatus: (sessionId: string, status: SessionStatusValue | SessionStatusValue[], options?: WaitForSessionOptions) => Promise<SessionDto>;
  /** Helpers to drive and answer the TEST-ONLY fake Claude CLI (account A). */
  cli: CliHelpers;
  /**
   * Opens account `key` (signed in once per worker) in a NEW browser context — desktop, or phone with
   * `{ mobile: true }`. Closed at the end of the test. Skips the test when the stack lacks the account.
   */
  as: (key: StackKey, options?: { mobile?: boolean }) => Promise<AccountSession>;
  /** Signs `page` in as account `key` (password + TOTP through /connexion). */
  loginAs: (page: Page, key: StackKey) => Promise<void>;
}

interface WorkerFixtures {
  ownerStorageState: string;
  /** Storage state of account `key` for this worker (signed in on first use, again with `refresh`). */
  accountStorageState: (key: StackKey, options?: { refresh?: boolean }) => Promise<string>;
}

const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: devices['iPhone 13'].userAgent };

/** Skips the current test (or describe) when the stack holds fewer than `count` accounts. */
export function requireAccounts(count: number): void {
  base.skip(E2E_ACCOUNTS < count, `pile à ${E2E_ACCOUNTS} compte(s) : ce parcours en demande ${count} (E2E_ACCOUNTS=${count}).`);
}

async function signedInStorage(browser: Browser, baseURL: string | undefined, file: string, signIn: (page: Page) => Promise<unknown>): Promise<string> {
  // Explicitly signed out: inside the test runner, browser.newContext() inherits the project's storage state.
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    await signIn(page);
    await context.storageState({ path: file });
  } finally {
    await context.close();
  }
  return file;
}

/**
 * `test` with an authenticated owner (account A): each worker signs in once (password + TOTP through
 * /connexion) and every test starts from that storage state; plus the stack fixtures above.
 *
 *   import { test, expect } from './fixtures';
 *   test('Accueil', async ({ page, stack }) => { await page.goto('/'); … });
 *   test('Isolation', async ({ as }) => { const b = await as('b'); await b.page.goto('/projets'); … });
 */
export const test = base.extend<StackFixtures, WorkerFixtures>({
  ownerStorageState: [
    async ({ browser }, use, workerInfo) => {
      const file = path.join(E2E_STATE_DIR, `storage-${workerInfo.project.name}-${workerInfo.workerIndex}.json`);
      await use(await signedInStorage(browser, workerInfo.project.use.baseURL, file, (page) => createOwnerAndSignIn(page)));
    },
    { scope: 'worker' },
  ],
  accountStorageState: [
    async ({ browser, ownerStorageState }, use, workerInfo) => {
      const cache = new Map<StackKey, Promise<string>>();
      await use((key, options = {}) => {
        if (key === 'a') return Promise.resolve(ownerStorageState);
        let pending = options.refresh ? undefined : cache.get(key);
        if (!pending) {
          const file = path.join(E2E_STATE_DIR, `storage-${workerInfo.project.name}-${workerInfo.workerIndex}-${key}.json`);
          pending = signedInStorage(browser, workerInfo.project.use.baseURL, file, (page) => signInAs(page, key));
          cache.set(key, pending);
        }
        return pending;
      });
    },
    { scope: 'worker' },
  ],
  storageState: async ({ ownerStorageState }, use) => {
    await use(ownerStorageState);
  },
  // oxlint-disable-next-line no-empty-pattern
  stack: async ({}, use) => {
    await use(await stackState());
  },
  // oxlint-disable-next-line no-empty-pattern
  runnerApi: async ({}, use) => {
    await use(await stackRunnerApi());
  },
  // oxlint-disable-next-line no-empty-pattern
  seed: async ({}, use) => {
    await use(seedStack);
  },
  // oxlint-disable-next-line no-empty-pattern
  waitForSessionStatus: async ({}, use) => {
    await use(waitForSessionStatus);
  },
  // oxlint-disable-next-line no-empty-pattern
  cli: async ({}, use) => {
    await use(cliHelpers());
  },
  as: async ({ browser, accountStorageState, baseURL, locale, timezoneId }, use) => {
    const opened: BrowserContext[] = [];
    await use(async (key, options = {}) => {
      base.skip(key !== 'a' && !existsSync(accountStateFile(key)), `compte « ${key} » absent de la pile (E2E_ACCOUNTS=${E2E_ACCOUNTS}).`);
      const open = async (storageState: string) => browser.newContext({ baseURL, locale, timezoneId, storageState, ...(options.mobile ? MOBILE : { viewport: { width: 1440, height: 1000 } }) });
      let context = await open(await accountStorageState(key));
      // An access closed meanwhile (sign-out, 2FA reset, disable/enable by the administration): sign in again.
      if ((await context.request.get('/api/notifications/counts')).status() === 401) {
        await context.close();
        context = await open(await accountStorageState(key, { refresh: true }));
      }
      opened.push(context);
      const page = await context.newPage();
      return { key, context, page, runnerApi: await stackRunnerApi(key), cli: cliHelpers(key) };
    });
    for (const context of opened) await context.close().catch(() => undefined);
  },
  // oxlint-disable-next-line no-empty-pattern
  loginAs: async ({}, use) => {
    await use(async (page, key) => {
      await signInAs(page, key);
    });
  },
});
