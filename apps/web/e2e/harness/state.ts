/**
 * TEST-ONLY — `.data/stacks/<name>/state.json`: everything a test or a lot needs to drive its stack
 * (ports, URLs, database, accounts, runners (servers) with their tokens, GitHub apps of the fake,
 * fixture repositories, seeded ids, processes).
 *
 * Version 2 (multi-account): `accounts[]`, `runners[]`, `githubApps[]`. The version-1 fields are kept
 * as the projection of account `a` / runner `a` (owner, secrets.runnerToken, paths, github, repos,
 * seeded), so that a spec or a lot written for one account keeps working. A version-1 file is
 * upgraded in memory (and written back as version 2 on the next update).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  accountFiles,
  accountIdentity,
  runnerName,
  runnerPathsFor,
  runnerUrlsFor,
  type AccountRole,
  type RunnerPaths,
  type RunnerPorts,
  type StackKey,
  type StackLayout,
  type StackPorts,
  type StackSecrets,
  type StackUrls,
} from './config';

/** `runner` = runner A (default server), `runner-b`, `runner-c`… = the other servers. */
export type RunnerComponent = 'runner' | 'runner-b' | 'runner-c' | 'runner-d';
export type ComponentName = 'github' | 'web' | RunnerComponent;

export function runnerComponent(key: StackKey): RunnerComponent {
  return key === 'a' ? 'runner' : (`runner-${key}` as RunnerComponent);
}

export function runnerKeyOf(component: RunnerComponent): StackKey {
  return component === 'runner' ? 'a' : (component.slice('runner-'.length) as StackKey);
}

export function isRunnerComponent(value: string): value is RunnerComponent {
  return value === 'runner' || value === 'runner-b' || value === 'runner-c' || value === 'runner-d';
}

export interface ProcessRecord {
  pid: number;
  startedAt: string;
  log: string;
  command: string;
  /** Image of the process when it was started (`node.exe`): a recycled PID is never killed. */
  image?: string | null;
}

export interface FixtureAccount {
  login: string;
  id: number;
  type: 'Organization' | 'User';
  /** Installation of GitHub app `a` (the owner's source) on this account; 0 when app `a` is not installed there. */
  installationId: number;
}

export interface FixtureRepoState {
  fullName: string;
  owner: string;
  name: string;
  id: number;
  /** Installation of app `a` that reaches this repository (0 when app `a` cannot). */
  installationId: number;
  /** Installation reaching this repository, per GitHub app of the fake (`a`, `a2`, `b`…). */
  installations: Record<string, number>;
  defaultBranch: string;
  branches: string[];
  private: boolean;
  language: string | null;
  description: string;
  /** Bare repository (the « GitHub » remote) under remotes/. */
  bare: string;
  /** Display name used when the seed adds it as a project. */
  displayName: string;
  /** `npm run test` fails on purpose (one red test). */
  failingTests: boolean;
}

export interface SeededProject {
  key: string;
  id: string;
  slug: string;
  name: string;
  fullName: string;
  path: string;
  defaultBranch: string;
  /** Primary worktree (the clone itself). */
  worktreeId: string;
  operationId: string;
}

export interface SeededSession {
  key: string;
  id: string;
  title: string;
  projectId: string;
  worktreeId: string | null;
  branch: string | null;
  /** Status reached by the seed (it may evolve afterwards: check with runnerApi('getSession')). */
  status: string;
  permissionMode: string;
  /** Pending permission request (waitingPermission only). */
  permissionId?: string | null;
}

export interface SeededChanges {
  sessionId: string;
  worktreeId: string;
  branch: string;
  /** Local commit made through the runner (ahead of origin by one). */
  commitSha: string;
  committedPaths: string[];
  /** Files left modified / added / deleted in the worktree (not committed), verified by the seed. */
  uncommitted: Array<{ path: string; change: 'modified' | 'added' | 'deleted' }>;
}

export interface SeededRun {
  id: string;
  projectId: string;
  command: string;
  status: string;
  summary: string | null;
}

export interface SeededData {
  github?: { connectedAt: string; accounts: string[]; repoCount: number };
  projects?: Record<string, SeededProject>;
  sessions?: Record<string, SeededSession>;
  changes?: SeededChanges;
  runs?: { passed?: SeededRun; failed?: SeededRun };
  notifications?: { ids: string[]; at: string };
}

/** A GitHub App served by the fake GitHub (one per source a test connects). */
export interface StackGithubApp {
  key: string;
  appId: number;
  slug: string;
  owner: { login: string; id: number; type: 'Organization' | 'User' };
  /** Installations of the app (account login → installation id). */
  installations: Array<{ account: string; installationId: number }>;
  /** Account of the stack whose source uses this app (`null` = spare app, bound by a spec). */
  account: StackKey | null;
}

/** A server of the stack = one runner process. */
export interface StackRunner {
  key: StackKey;
  component: RunnerComponent;
  /** Server name shown in the interface (« VPS-3 » for the default server). */
  name: string;
  isDefault: boolean;
  /** `environments.id` (null until known). */
  environmentId: string | null;
  /** Account whose space the server is attached to. */
  account: StackKey;
  ports: RunnerPorts;
  urls: { runner: string; hook: string };
  /** RUNNER_TOKEN of this runner (test secret; for `b`+ the one-time token shown by the registration). */
  token: string;
  /** Restricted PostgreSQL login role of the server (null = full DSN: the default server). */
  dbRole: string | null;
  /** RUNNER_DATABASE_URL of the runner (null = DATABASE_URL of the stack). */
  databaseUrl: string | null;
  paths: RunnerPaths;
  /** How the server row was made: by the migration (default server), the admin route, or SQL (fallback). */
  registeredVia: 'migration' | 'admin' | 'sql' | null;
}

export interface StackAccount {
  key: StackKey;
  role: AccountRole;
  name: string;
  email: string;
  password: string;
  totpSecret: string | null;
  userId: string | null;
  spaceId: string | null;
  /** Server of the account's space. */
  runner: StackKey;
  gitIdentity: { name: string; email: string };
  /** Credentials, TOTP secret and unused backup codes (owner.json for `a`, accounts/<key>.json otherwise). */
  stateFile: string;
  storageState: string;
  created: boolean;
  /** `/configuration` (owner) or `/invitation/<jeton>` (others). */
  createdVia: 'configuration' | 'invitation' | null;
  /** GitHub source of the account's space connected by the harness. */
  github: { app: string; sourceId: string | null; connected: boolean; accounts: string[]; repoCount: number | null };
  /** Seeded data of the account (account `a`: the top-level `seeded`). */
  seeded?: SeededData;
}

export interface StackState {
  version: 2;
  name: string;
  createdAt: string;
  updatedAt: string;
  dir: string;
  ports: StackPorts;
  urls: StackUrls;
  database: { name: string; url: string; adminUrl: string };
  secrets: StackSecrets;
  /** Account `a` (owner) — projection kept for single-account specs. */
  owner: { name: string; email: string; password: string; totpSecret: string | null; userId: string | null; created: boolean };
  /**
   * `shared` (lot P1, `up --shared`): every account works on the default server « VPS-3 » (runner a),
   * each with its own Claude Code folder there — no runner b.
   */
  options: { web: boolean; scheduler: boolean; pristine: boolean; shared?: boolean };
  /** Folders of the stack; projects/runnerData/home/claude* are runner A's. */
  paths: StackLayout;
  processes: Partial<Record<ComponentName, ProcessRecord>>;
  /** GitHub app of account `a` — projection kept for single-account specs. */
  github: {
    appId: number;
    slug: string;
    /** Accounts where app `a` is installed (atelier-test, dev-test). */
    accounts: FixtureAccount[];
    connected: boolean;
  };
  /** Repositories visible to account `a` (through app `a`). */
  repos: FixtureRepoState[];
  /** Every fixture repository (incl. those only another account's source reaches). */
  allRepos: FixtureRepoState[];
  /** Seeded data of account `a`. */
  seeded: SeededData;
  /** Number of accounts (= servers) the stack keeps (E2E_ACCOUNTS / `up --accounts`). */
  accountCount: number;
  accounts: StackAccount[];
  runners: StackRunner[];
  githubApps: StackGithubApp[];
}

type StateV1 = Omit<StackState, 'version' | 'allRepos' | 'accountCount' | 'accounts' | 'runners' | 'githubApps'> & { version: 1 };

/** Version-1 state (one owner, one runner, one app) → version 2 with account / runner `a` only. */
export function upgradeState(input: StateV1 | StackState): StackState {
  if (input.version === 2) return input;
  const v1 = input;
  const files = accountFiles(v1.paths, 'a');
  const identity = accountIdentity(v1.name, 'a');
  const repos = v1.repos.map((repo) => ({ ...repo, installations: repo.installations ?? { a: repo.installationId } }));
  return {
    ...v1,
    version: 2,
    paths: { ...v1.paths, accounts: v1.paths.accounts ?? path.join(v1.dir, 'accounts') },
    repos,
    allRepos: repos,
    accountCount: 1,
    accounts: [
      {
        key: 'a',
        role: 'owner',
        name: v1.owner.name,
        email: v1.owner.email,
        password: v1.owner.password,
        totpSecret: v1.owner.totpSecret,
        userId: v1.owner.userId,
        spaceId: null,
        runner: 'a',
        gitIdentity: identity.gitIdentity,
        stateFile: files.stateFile,
        storageState: files.storageState,
        created: v1.owner.created,
        createdVia: v1.owner.created ? 'configuration' : null,
        github: { app: 'a', sourceId: null, connected: v1.github.connected, accounts: v1.github.accounts.map((item) => item.login), repoCount: v1.repos.length },
      },
    ],
    runners: [
      {
        key: 'a',
        component: 'runner',
        name: runnerName('a'),
        isDefault: true,
        environmentId: null,
        account: 'a',
        ports: { runner: v1.ports.runner, hook: v1.ports.hook },
        urls: runnerUrlsFor({ runner: v1.ports.runner, hook: v1.ports.hook }),
        token: v1.secrets.runnerToken,
        dbRole: null,
        databaseUrl: null,
        paths: runnerPathsFor(v1.dir, 'a'),
        registeredVia: 'migration',
      },
    ],
    githubApps: [
      {
        key: 'a',
        appId: v1.github.appId,
        slug: v1.github.slug,
        owner: { login: v1.github.accounts[0]?.login ?? 'atelier-test', id: v1.github.accounts[0]?.id ?? 5101, type: v1.github.accounts[0]?.type ?? 'Organization' },
        installations: v1.github.accounts.map((item) => ({ account: item.login, installationId: item.installationId })),
        account: 'a',
      },
    ],
  };
}

export function readState(file: string): StackState | null {
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as StateV1 | StackState;
    if (state.version === 2) return state;
    if (state.version === 1) return upgradeState(state);
    return null;
  } catch {
    return null;
  }
}

/** Atomic write (temp file + rename): readers never see half a file. */
export function writeState(file: string, state: StackState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(tmp, file);
      return;
    } catch (error) {
      // Windows: a reader holding the file makes the rename fail with EPERM for a few ms.
      if (attempt >= 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

/** Re-reads the file, applies `patch`, writes it back (the file is the source of truth between processes). */
export function updateState(file: string, patch: (state: StackState) => void): StackState {
  const state = readState(file);
  if (!state) throw new Error(`État de pile introuvable : ${file}`);
  patch(state);
  syncProjections(state);
  writeState(file, state);
  return state;
}

/** Keeps the version-1 fields equal to account / runner `a`. */
export function syncProjections(state: StackState): void {
  const a = state.accounts.find((item) => item.key === 'a');
  if (a) {
    state.owner = { name: a.name, email: a.email, password: a.password, totpSecret: a.totpSecret, userId: a.userId, created: a.created };
    state.github.connected = a.github.connected;
  }
  const runner = state.runners.find((item) => item.key === 'a');
  if (runner) state.secrets.runnerToken = runner.token;
}

// ---------------------------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------------------------

export function accountOf(state: Pick<StackState, 'accounts' | 'name'>, key: StackKey): StackAccount {
  const account = state.accounts.find((item) => item.key === key);
  if (!account) throw new Error(`Compte « ${key} » absent de la pile ${state.name} (lancez \`up --accounts ${['a', 'b', 'c', 'd'].indexOf(key) + 1}\`).`);
  return account;
}

export function hasAccount(state: Pick<StackState, 'accounts'>, key: StackKey): boolean {
  return state.accounts.some((item) => item.key === key && item.created);
}

export function runnerOf(state: Pick<StackState, 'runners' | 'name'>, key: StackKey): StackRunner {
  const runner = state.runners.find((item) => item.key === key);
  if (!runner) throw new Error(`Serveur « ${key} » absent de la pile ${state.name}.`);
  return runner;
}

/** Runner (server) of an account's space. */
export function runnerOfAccount(state: Pick<StackState, 'runners' | 'accounts' | 'name'>, key: StackKey): StackRunner {
  return runnerOf(state, accountOf(state, key).runner);
}

export function githubAppOf(state: Pick<StackState, 'githubApps' | 'name'>, key: string): StackGithubApp {
  const app = state.githubApps.find((item) => item.key === key);
  if (!app) throw new Error(`Application GitHub « ${key} » absente du faux GitHub de la pile ${state.name}.`);
  return app;
}

/** Seeded data of an account (`a`: the top-level `seeded`). */
export function seededOf(state: Pick<StackState, 'seeded' | 'accounts'>, key: StackKey): SeededData {
  if (key === 'a') return state.seeded;
  return state.accounts.find((item) => item.key === key)?.seeded ?? {};
}

/** Mutates the seeded data of an account in place (inside an `updateState` patch). */
export function patchSeeded(state: StackState, key: StackKey, patch: (seeded: SeededData) => void): void {
  if (key === 'a') {
    patch(state.seeded);
    return;
  }
  const account = accountOf(state, key);
  account.seeded ??= {};
  patch(account.seeded);
}

/** Repositories a GitHub app of the fake reaches. */
export function reposOfApp(state: Pick<StackState, 'allRepos'>, appKey: string): FixtureRepoState[] {
  return state.allRepos.filter((repo) => (repo.installations[appKey] ?? 0) > 0);
}

// ---------------------------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------------------------

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Exclusive lock of a stack (up, seed, down) between processes. A lock whose process is gone or
 * older than `staleMs` is taken over.
 */
export async function withStackLock<T>(lockFile: string, label: string, fn: () => Promise<T>, options: { waitMs?: number; staleMs?: number; log?: (line: string) => void } = {}): Promise<T> {
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + (options.waitMs ?? 45 * 60_000);
  const staleMs = options.staleMs ?? 60 * 60_000;
  let announced = false;
  for (;;) {
    try {
      const fd = openSync(lockFile, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, label, at: new Date().toISOString() }));
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: { pid?: number; label?: string } = {};
      try {
        holder = JSON.parse(readFileSync(lockFile, 'utf8')) as { pid?: number; label?: string };
      } catch {
        // being written
      }
      const age = (() => {
        try {
          return Date.now() - statSync(lockFile).mtimeMs;
        } catch {
          return 0;
        }
      })();
      if (holder.pid === process.pid) {
        // Re-entrant use within the same process (global setup → seed).
        return fn();
      }
      if ((holder.pid && !pidAlive(holder.pid)) || age > staleMs) {
        rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Pile verrouillée par le processus ${holder.pid ?? '?'} (${holder.label ?? '?'}).`, { cause: error });
      if (!announced) {
        options.log?.(`En attente du verrou de la pile (processus ${holder.pid ?? '?'} : ${holder.label ?? '?'})…`);
        announced = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockFile, { force: true });
  }
}
