import { test as setup } from '@playwright/test';
import { E2E_ACCOUNTS, E2E_ACCOUNT_KEYS, E2E_SEED, E2E_SEED_B, E2E_STACK } from './fixtures/env';

/**
 * Project « stack » (playwright.config.ts): runs after « configuration » and before every
 * desktop / mobile spec. Ensures the owner (created by /configuration when the stack started
 * without one) and its GitHub source; with E2E_ACCOUNTS ≥ 2, registers server « VPS-4 » through the
 * administration, starts its runner (restricted database role), invites account B and activates it
 * through /invitation/<jeton> (mandatory 2FA), connects B's own GitHub source; then runs the seed
 * scenarios: E2E_SEED for A (default `all`), E2E_SEED_B for B (default projects, sessions,
 * notifications) — idempotent, only what is missing is re-created.
 */
setup('pile de test : comptes, serveurs, GitHub et données', async () => {
  setup.setTimeout(75 * 60_000);
  const { up, seed } = await import('./harness/stack');
  const log = (line: string) => console.log(`[pile ${E2E_STACK}] ${line}`);
  await up({ name: E2E_STACK, accounts: E2E_ACCOUNTS, log });
  if (E2E_SEED.length) await seed(E2E_STACK, E2E_SEED, { log });
  for (const key of E2E_ACCOUNT_KEYS.slice(1)) if (E2E_SEED_B.length) await seed(E2E_STACK, E2E_SEED_B, { log, account: key });
});
