/**
 * TEST-ONLY — fixed locations used by the local test stack (apps/web/e2e/harness).
 * Nothing under apps/web/src imports this folder.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(HARNESS_DIR, '..', '..');
export const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..');
export const RUNNER_ROOT = path.join(REPO_ROOT, 'apps', 'runner');

/** Every stack lives in `.data/stacks/<name>/` (git-ignored). */
export const STACKS_ROOT = path.join(REPO_ROOT, '.data', 'stacks');
/** Shared cache of the fixture bare repositories (built once a day, copied into each stack). */
export const FIXTURES_CACHE = path.join(STACKS_ROOT, '_fixtures');

/** The TEST-ONLY fake Claude Code CLI (selected with NUERA_CLAUDE_BIN). */
export const FAKE_CLAUDE_BIN = path.join(RUNNER_ROOT, 'test', 'fixtures', 'fake-claude.mjs');

/** tsx (devDependency of the runner) — loader for `node --import` and in-process registration. */
export const TSX_LOADER_URL = pathToFileURL(path.join(RUNNER_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

export const NEXT_BIN = path.join(WEB_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
export const RUNNER_ENTRY = path.join(RUNNER_ROOT, 'src', 'index.ts');
export const FAKE_GITHUB_ENTRY = path.join(HARNESS_DIR, 'github-fake-server.ts');
export const STACK_CLI = path.join(HARNESS_DIR, 'stack.mjs');

/** Root `.env` (development secrets): its keys must never leak into a stack. */
export const ROOT_ENV_FILE = path.join(REPO_ROOT, '.env');

/** `apps/web/e2e/harness/stack.mjs` as written in the docs (forward slashes, relative to the repo root). */
export const STACK_CLI_DISPLAY = 'node apps/web/e2e/harness/stack.mjs';
