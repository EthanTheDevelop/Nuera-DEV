import { test as setup } from '@playwright/test';
import { E2E_SEED, E2E_STACK } from './fixtures/env';

/**
 * Project « stack » (playwright.config.ts): runs after « configuration » and before every
 * desktop / mobile spec. Ensures the owner (created by /configuration when the stack started
 * without one), connects the GitHub App through the real routes against the fake GitHub, then
 * runs the E2E_SEED scenarios (default `all`, idempotent: only what is missing is re-created).
 */
setup('pile de test : propriétaire, GitHub et données', async () => {
  setup.setTimeout(45 * 60_000);
  const { up, seed } = await import('./harness/stack');
  const log = (line: string) => console.log(`[pile ${E2E_STACK}] ${line}`);
  await up({ name: E2E_STACK, log });
  if (E2E_SEED.length) await seed(E2E_STACK, E2E_SEED, { log });
});
