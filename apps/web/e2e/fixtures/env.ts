import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Shared e2e settings (read by playwright.config.ts, the global setup and the fixtures).
 *
 *   E2E_PORT       port of the `next dev` server under test (default 3102)
 *   E2E_DATABASE   dedicated database, dropped and re-created by the global setup (default nuera_e2e)
 *   E2E_PG_URL     server URL without database (default postgres://nuera:nuera@127.0.0.1:54329)
 */
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3102);
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;
export const E2E_DATABASE = process.env.E2E_DATABASE ?? 'nuera_e2e';
export const E2E_PG_URL = (process.env.E2E_PG_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329').replace(/\/+$/, '');
export const E2E_DATABASE_URL = `${E2E_PG_URL}/${E2E_DATABASE}`;

/** SETUP_TOKEN given to the server under test (test-only value). */
export const E2E_SETUP_TOKEN = 'e2e-jeton-configuration-0123456789';

/** Owner created by the setup flow in e2e runs (test-only credentials). */
export const E2E_OWNER = {
  name: 'Propriétaire E2E',
  email: 'proprietaire@e2e.nuera.test',
  password: 'Riviere-Bleue-2026!',
} as const;

export const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..');
/** Git-ignored folder (root .gitignore: `.playwright/`) holding the owner state between tests. */
export const E2E_STATE_DIR = path.join(WEB_ROOT, '.playwright', E2E_DATABASE);
export const OWNER_STATE_FILE = path.join(E2E_STATE_DIR, 'owner.json');
