import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pino from 'pino';
import { createDb, projects, type Database } from '@nuera/db';
import { buildRunner, type Runner } from '../src/app';
import type { RunnerConfig } from '../src/config';

export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = path.join(TEST_DIR, 'fixtures', 'fake-claude.mjs');
export const dbReady = process.env.NUERA_TEST_DB === '1';
export const dbUrl = process.env.RUNNER_TEST_DATABASE_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/nuera_runner_test';
export const TOKEN = 'test-runner-token-0123456789abcdef';
export const silentLogger = pino({ level: process.env.RUNNER_TEST_LOG ?? 'silent' });

export function tmpDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), `nuera-${prefix}-`));
}

export function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Windows may keep handles a little longer
  }
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
};

/** git for test fixtures (not the code under test). */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false', ...args], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Bare repository `<remotes>/<owner>/<repo>.git` with one commit on main (README + src). */
export function createBareRemote(remotes: string, fullName: string, files: Record<string, string> = {}): { bare: string; work: string } {
  const bare = path.join(remotes, `${fullName}.git`);
  mkdirSync(path.dirname(bare), { recursive: true });
  git(remotes, 'init', '--bare', '-b', 'main', bare);
  const work = tmpDir('seed');
  git(work, 'init', '-b', 'main');
  const content: Record<string, string> = {
    'README.md': '# Projet de test\n',
    'CLAUDE.md': '# Règles\n\n- Une ligne\n- Deux lignes\n',
    'src/index.ts': 'export const answer = 42;\n',
    ...files,
  };
  for (const [rel, text] of Object.entries(content)) {
    const abs = path.join(work, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'init');
  git(work, 'remote', 'add', 'origin', bare);
  git(work, 'push', 'origin', 'main');
  return { bare, work };
}

export function remoteBase(remotes: string): string {
  return `${pathToFileURL(remotes).href.replace(/\/$/, '')}/`;
}

export function testConfig(dirs: { projects: string; data: string; remotes: string }, overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    env: 'test',
    host: '127.0.0.1',
    port: 0,
    hookPort: 0,
    token: TOKEN,
    databaseUrl: dbUrl,
    appUrl: 'http://127.0.0.1:9',
    webInternalUrl: 'http://127.0.0.1:9',
    projectsRoot: dirs.projects,
    dataDir: dirs.data,
    sessionBackend: 'pty',
    claudeBin: FAKE_CLAUDE,
    logLevel: 'silent',
    gitRemoteBase: remoteBase(dirs.remotes),
    schedulerEnabled: false,
    version: '0.0.0-test',
    ...overrides,
  };
}

export interface TestEnv {
  root: string;
  dirs: { projects: string; data: string; remotes: string };
  db: Database;
  runner: Runner;
  apiUrl: string;
  close(): Promise<void>;
}

export async function startTestRunner(overrides: Partial<RunnerConfig> = {}, env: Record<string, string> = {}): Promise<TestEnv> {
  const root = tmpDir('runner');
  const dirs = { projects: path.join(root, 'projects'), data: path.join(root, 'data'), remotes: path.join(root, 'remotes') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  Object.assign(process.env, env);
  const db = createDb(dbUrl, { max: 5, applicationName: 'nuera-runner-test' });
  const runner = await buildRunner(testConfig(dirs, overrides), { logger: silentLogger, db });
  const { apiUrl } = await runner.start({ listen: true });
  return {
    root,
    dirs,
    db,
    runner,
    apiUrl: apiUrl!,
    async close() {
      await runner.close();
      cleanup(root);
    },
  };
}

let projectCounter = 0;
export async function seedProject(db: Database, input: { fullName: string; path: string; status?: 'cloning' | 'ready'; slug?: string; defaultBranch?: string }) {
  projectCounter += 1;
  const slug = input.slug ?? `p${Date.now().toString(36)}${projectCounter}`;
  const [row] = await db
    .insert(projects)
    .values({
      slug,
      name: input.fullName.split('/')[1] ?? slug,
      githubFullName: input.fullName,
      cloneUrl: `https://github.com/${input.fullName}.git`,
      path: input.path,
      status: input.status ?? 'ready',
      defaultBranch: input.defaultBranch ?? 'main',
    })
    .returning();
  return row!;
}

export const auth = { authorization: `Bearer ${TOKEN}` };

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, options: { timeoutMs?: number; intervalMs?: number; label?: string } = {}): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value as T;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`waitFor ${options.label ?? ''} : délai dépassé ${last ? `(${String(last)})` : ''}`);
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 100));
  }
}
