import path from 'node:path';
import { test as base } from '@playwright/test';
import type { SessionStatusValue } from '@nuera/shared/runner';
import { E2E_STATE_DIR } from './env';
import { createOwnerAndSignIn } from './owner';
import { cliHelpers, seedStack, stackRunnerApi, stackState, waitForSessionStatus, type CliHelpers, type RunnerApi, type SeededData, type SessionDto, type StackState, type WaitForSessionOptions } from './stack';

export * from './env';
export * from './owner';
export * from './stack';
export { expect } from '@playwright/test';

export interface StackFixtures {
  /** state.json of the stack under test (urls, ports, owner, repos, `seeded` ids), read once per test. */
  stack: StackState;
  /** Typed calls to the stack's runner: `await runnerApi('getSession', { params: { sessionId } })`. */
  runnerApi: RunnerApi;
  /** Idempotent seed scenarios: `await seed('sessions')` → the up-to-date `seeded` block. */
  seed: (...scenarios: string[]) => Promise<SeededData>;
  /** `await waitForSessionStatus(id, 'waiting_input')` (or an array of statuses). */
  waitForSessionStatus: (sessionId: string, status: SessionStatusValue | SessionStatusValue[], options?: WaitForSessionOptions) => Promise<SessionDto>;
  /** Helpers to drive and answer the TEST-ONLY fake Claude CLI. */
  cli: CliHelpers;
}

/**
 * `test` with an authenticated owner: each worker signs in once (password + TOTP through
 * /connexion) and every test starts from that storage state; plus the stack fixtures above.
 *
 *   import { test, expect } from './fixtures';
 *   test('Accueil', async ({ page, stack }) => { await page.goto('/'); … });
 */
export const test = base.extend<StackFixtures, { ownerStorageState: string }>({
  ownerStorageState: [
    async ({ browser }, use, workerInfo) => {
      const file = path.join(E2E_STATE_DIR, `storage-${workerInfo.project.name}-${workerInfo.workerIndex}.json`);
      const context = await browser.newContext({ baseURL: workerInfo.project.use.baseURL });
      const page = await context.newPage();
      await createOwnerAndSignIn(page);
      await context.storageState({ path: file });
      await context.close();
      await use(file);
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
});
