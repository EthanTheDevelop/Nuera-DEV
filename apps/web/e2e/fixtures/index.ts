import path from 'node:path';
import { test as base } from '@playwright/test';
import { E2E_STATE_DIR } from './env';
import { createOwnerAndSignIn } from './owner';

export * from './env';
export * from './owner';
export { expect } from '@playwright/test';

/**
 * `test` with an authenticated owner: each worker signs in once (creating the owner on a fresh
 * database) and every test starts from that storage state.
 *
 *   import { test, expect } from './fixtures';
 *   test('Accueil', async ({ page }) => { await page.goto('/'); … });
 */
export const test = base.extend<object, { ownerStorageState: string }>({
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
});
