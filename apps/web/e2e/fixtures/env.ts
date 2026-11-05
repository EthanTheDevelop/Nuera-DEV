import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_WEB_PORTS, TEST_SETUP_TOKEN, assertStackName, defaultDatabaseName, layoutFor, ownerIdentity, portsFor, urlsFor, type StackPorts } from '../harness/config';
import { REPO_ROOT as HARNESS_REPO_ROOT, WEB_ROOT as HARNESS_WEB_ROOT } from '../harness/paths';

/**
 * Shared e2e settings (read by playwright.config.ts, the global setup and the fixtures). The tests
 * run against a local test stack (apps/web/e2e/harness, see its README):
 *
 *   E2E_STACK         stack name (default `e2e`) → `.data/stacks/<name>/`
 *   E2E_WEB_PORT      web port (alias: E2E_PORT; default: the stack's state.json, else 3102 for `e2e`)
 *   E2E_RUNNER_PORT / E2E_HOOK_PORT / E2E_GITHUB_PORT   default: web + 1000 / + 1001 / + 1002
 *   E2E_DATABASE      database (default `nuera_<stack>`)
 *   E2E_PG_URL        PostgreSQL server without database (default postgres://nuera:nuera@127.0.0.1:54329)
 *   E2E_RESET=1       recreate the stack (database, clones, owner) before the run
 *   E2E_PRISTINE=1    with a (re)created stack: no owner, the `configuration` project creates it
 *   E2E_SEED          seed scenarios run by the global setup (default `all`; `none` to skip)
 *   E2E_DOWN=1        stop the stack after the run (it is kept running by default)
 */

interface RecordedStack {
  ports?: StackPorts;
  database?: { name?: string };
}

export const E2E_STACK = assertStackName(process.env.E2E_STACK?.trim() || 'e2e');
const layout = layoutFor(E2E_STACK);

function recordedStack(): RecordedStack | null {
  if (!existsSync(layout.stateFile)) return null;
  try {
    return JSON.parse(readFileSync(layout.stateFile, 'utf8')) as RecordedStack;
  } catch {
    return null;
  }
}

function envPort(name: string): number | undefined {
  const value = process.env[name]?.trim();
  return value ? Number(value) : undefined;
}

function resolvePorts(): StackPorts {
  const recorded = recordedStack()?.ports;
  const explicitWeb = envPort('E2E_WEB_PORT') ?? envPort('E2E_PORT');
  const overrides = { runner: envPort('E2E_RUNNER_PORT'), hook: envPort('E2E_HOOK_PORT'), github: envPort('E2E_GITHUB_PORT') };
  const anyEnv = explicitWeb !== undefined || Object.values(overrides).some((value) => value !== undefined);
  if (!anyEnv && recorded) return recorded;
  const web = explicitWeb ?? recorded?.web ?? DEFAULT_WEB_PORTS[E2E_STACK];
  if (!web) {
    throw new Error(`Pile « ${E2E_STACK} » inconnue : précisez E2E_WEB_PORT (ou lancez d'abord stack.mjs up --name ${E2E_STACK} --web-port <port>).`);
  }
  return portsFor(web, {
    runner: overrides.runner ?? (explicitWeb === undefined ? recorded?.runner : undefined),
    hook: overrides.hook ?? (explicitWeb === undefined ? recorded?.hook : undefined),
    github: overrides.github ?? (explicitWeb === undefined ? recorded?.github : undefined),
  });
}

export const E2E_PORTS = resolvePorts();
export const E2E_URLS = urlsFor(E2E_PORTS);
/** Port of the web app under test. */
export const E2E_PORT = E2E_PORTS.web;
export const E2E_BASE_URL = E2E_URLS.web;
export const E2E_DATABASE = process.env.E2E_DATABASE?.trim() || recordedStack()?.database?.name || defaultDatabaseName(E2E_STACK);
export const E2E_PG_URL = (process.env.E2E_PG_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329').replace(/\/+$/, '');
export const E2E_DATABASE_URL = `${E2E_PG_URL}/${E2E_DATABASE}`;

export const E2E_RESET = process.env.E2E_RESET === '1';
export const E2E_PRISTINE = process.env.E2E_PRISTINE === '1';
export const E2E_DOWN = process.env.E2E_DOWN === '1';
/** Seed scenarios of the global setup (`all` by default, `none` = nothing). */
export const E2E_SEED = (process.env.E2E_SEED?.trim() || 'all')
  .split(/[\s,]+/)
  .filter(Boolean)
  .filter((item) => item !== 'none');

/** SETUP_TOKEN given to the server under test (test-only value). */
export const E2E_SETUP_TOKEN = TEST_SETUP_TOKEN;

/** Owner created on the stack (test-only credentials; the TOTP secret is read during the setup). */
export const E2E_OWNER = ownerIdentity(E2E_STACK);

export const WEB_ROOT = HARNESS_WEB_ROOT;
export const REPO_ROOT = HARNESS_REPO_ROOT;
/** Stack folder: `.data/stacks/<E2E_STACK>` (git-ignored). */
export const E2E_STACK_DIR = layout.dir;
export const E2E_STATE_FILE = layout.stateFile;
/** Playwright's own files for this stack (per-worker storage states). */
export const E2E_STATE_DIR = layout.playwright;
/** Owner credentials, TOTP secret and unused backup codes of the stack. */
export const OWNER_STATE_FILE = layout.ownerFile;
