import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { createDb, environments, projects, spaces, type Database } from '@nuera/db';
import { seedMember } from '@nuera/db/test';
import { hashToken } from '@nuera/shared/tokens';
import { buildRunner, type BuildRunnerOptions, type Runner } from '../src/app';
import type { RunnerConfig } from '../src/config';
import { TOKEN } from './constants';

export { TOKEN };
export const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_CLAUDE = path.join(TEST_DIR, 'fixtures', 'fake-claude.mjs');
export const dbReady = process.env.NUERA_TEST_DB === '1';
export const dbUrl = process.env.RUNNER_TEST_DATABASE_URL ?? 'postgres://nuera:nuera@127.0.0.1:54329/nuera_runner_test';
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
    dbPoolMax: 5,
    environmentId: null,
    claudeConfigDir: null,
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

/** `Authorization` header of a runner token. */
export const authFor = (token: string) => ({ authorization: `Bearer ${token}` });
export const auth = authFor(TOKEN);

export interface TestEnv {
  root: string;
  dirs: { projects: string; data: string; remotes: string };
  db: Database;
  runner: Runner;
  apiUrl: string;
  /** Bearer header of this runner's token. */
  auth: { authorization: string };
  /** Stops the runner; its temporary folders are removed unless `keepFolders` (restart scenarios). */
  close(options?: { keepFolders?: boolean }): Promise<void>;
}

export interface StartTestRunnerOptions {
  /** Existing folders (a restarted runner keeps its data); fresh temporary ones otherwise. */
  dirs?: { projects: string; data: string; remotes: string };
  /** Database client (a restricted role's in its suite); a new pool on the test database otherwise. */
  db?: Database;
  runner?: Omit<BuildRunnerOptions, 'logger' | 'db'>;
}

export async function startTestRunner(overrides: Partial<RunnerConfig> = {}, options: StartTestRunnerOptions = {}): Promise<TestEnv> {
  const root = tmpDir('runner');
  const dirs = options.dirs ?? { projects: path.join(root, 'projects'), data: path.join(root, 'data'), remotes: path.join(root, 'remotes') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const db = options.db ?? createDb(overrides.databaseUrl ?? dbUrl, { max: 5, applicationName: 'nuera-runner-test' });
  const config = testConfig(dirs, overrides);
  const runner = await buildRunner(config, { logger: silentLogger, db, standbyRetryMs: 200, ...options.runner });
  const { apiUrl } = await runner.start({ listen: true });
  return {
    root,
    dirs,
    db,
    runner,
    apiUrl: apiUrl!,
    auth: authFor(config.token),
    async close(closeOptions = {}) {
      await runner.close();
      if (!closeOptions.keepFolders) cleanup(root);
    },
  };
}

export interface TestServer {
  environmentId: string;
  spaceId: string;
  userId: string;
}

/** The default server « VPS-3 » (token {@link TOKEN}, adopted by the owner in global-setup). */
export async function defaultServer(db: Database): Promise<TestServer> {
  const [row] = await db
    .select({ id: environments.id, spaceId: spaces.id, ownerUserId: spaces.ownerUserId })
    .from(environments)
    .innerJoin(spaces, eq(spaces.id, environments.spaceId))
    .where(eq(environments.tokenHash, hashToken(TOKEN)))
    .limit(1);
  if (!row?.ownerUserId) throw new Error('Serveur par défaut des tests introuvable : global-setup a-t-il tourné ?');
  return { environmentId: row.id, spaceId: row.spaceId, userId: row.ownerUserId };
}

let serverCounter = 0;
/** Another account with its own space and server, reached with `token` (as the administration registers it). */
export async function seedServer(
  db: Database,
  options: { token: string; name?: string; dbRole?: string | null; maxConcurrentSessions?: number; sessionMemoryLimitMb?: number | null },
): Promise<TestServer> {
  serverCounter += 1;
  const account = await seedMember(db, {
    email: `membre-${Date.now().toString(36)}-${serverCounter}@example.test`,
    name: 'Camille Test',
    environment: {
      name: options.name ?? 'Serveur de test',
      tokenHash: hashToken(options.token),
      dbRole: options.dbRole ?? null,
      ...(options.maxConcurrentSessions !== undefined ? { maxConcurrentSessions: options.maxConcurrentSessions } : {}),
      sessionMemoryLimitMb: options.sessionMemoryLimitMb ?? null,
    },
  });
  return { environmentId: account.environmentId!, spaceId: account.spaceId, userId: account.userId };
}

let projectCounter = 0;
export async function seedProject(
  db: Database,
  input: { fullName: string; path: string; status?: 'cloning' | 'ready'; slug?: string; defaultBranch?: string; server?: TestServer },
) {
  projectCounter += 1;
  const slug = input.slug ?? `p${Date.now().toString(36)}${projectCounter}`;
  const server = input.server ?? (await defaultServer(db));
  const [row] = await db
    .insert(projects)
    .values({
      spaceId: server.spaceId,
      environmentId: server.environmentId,
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
