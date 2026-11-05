import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { E2E_BASE_URL, E2E_DATABASE, E2E_DATABASE_URL, E2E_PG_URL, E2E_STATE_DIR, REPO_ROOT } from './env';

/**
 * Fresh database for every run: drop + create E2E_DATABASE, apply packages/db/drizzle migrations,
 * forget the owner state of the previous run. Playwright starts the web server BEFORE this
 * function (its /api/health answers 200 even without a database) and the server reconnects by
 * itself. Then the auth pages are requested once so that `next dev` compiles them before the
 * first test (a cold compile can take tens of seconds on the development machine).
 */
const WARM_UP_PATHS = [
  '/api/health',
  '/connexion',
  '/connexion/deux-facteurs',
  '/configuration',
  '/configuration/double-facteur',
  '/configuration/codes-de-secours',
  '/configuration/cle-d-acces',
];

async function warmUp(): Promise<void> {
  for (const pathname of WARM_UP_PATHS) {
    try {
      await fetch(`${E2E_BASE_URL}${pathname}`, { redirect: 'manual', signal: AbortSignal.timeout(300_000) });
    } catch (error) {
      console.warn(`[e2e] préchauffage ${pathname} :`, error instanceof Error ? error.message : error);
    }
  }
}

export default async function globalSetup(): Promise<void> {
  const env = { ...process.env, NUERA_PG_ADMIN_URL: `${E2E_PG_URL}/postgres`, DATABASE_URL: E2E_DATABASE_URL };
  execFileSync(process.execPath, [path.join(REPO_ROOT, 'scripts', 'create-db.mjs'), E2E_DATABASE, '--reset'], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });
  execFileSync(
    process.execPath,
    [
      path.join(REPO_ROOT, 'packages', 'db', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(REPO_ROOT, 'packages', 'db', 'src', 'cli', 'migrate.ts'),
    ],
    { cwd: path.join(REPO_ROOT, 'packages', 'db'), env, stdio: 'inherit' },
  );
  rmSync(E2E_STATE_DIR, { recursive: true, force: true });
  await warmUp();
}
