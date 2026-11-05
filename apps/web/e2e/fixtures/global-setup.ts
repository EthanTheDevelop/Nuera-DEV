import { existsSync } from 'node:fs';
import { E2E_DATABASE, E2E_PORTS, E2E_PRISTINE, E2E_RESET, E2E_STACK, E2E_STATE_FILE } from './env';

/**
 * Brings the test stack E2E_STACK up (database migrated, fake GitHub, runner, `next dev`), or
 * reuses it when it already runs. A stack created now (first run, E2E_RESET=1) or E2E_PRISTINE=1
 * starts WITHOUT owner: the « configuration » project then creates it through /configuration, and
 * the « stack » setup project (e2e/stack.setup.ts) connects GitHub and runs the seed scenarios.
 */
export default async function globalSetup(): Promise<void> {
  const { up } = await import('../harness/stack');
  const fresh = E2E_RESET || !existsSync(E2E_STATE_FILE);
  const log = (line: string) => console.log(`[pile ${E2E_STACK}] ${line}`);
  await up({
    name: E2E_STACK,
    webPort: E2E_PORTS.web,
    runnerPort: E2E_PORTS.runner,
    hookPort: E2E_PORTS.hook,
    githubPort: E2E_PORTS.github,
    db: E2E_DATABASE,
    reset: E2E_RESET,
    pristine: E2E_PRISTINE || fresh,
    warm: ['/configuration', '/configuration/double-facteur', '/configuration/codes-de-secours', '/configuration/cle-d-acces', '/deconnexion'],
    log,
  });
}
