/**
 * TEST-ONLY — `.data/stacks/<name>/state.json`: everything a test or a lot needs to drive its stack
 * (ports, URLs, database, owner, RUNNER_TOKEN, fixture repositories, seeded ids, processes).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StackLayout, StackPorts, StackSecrets, StackUrls } from './config';

export type ComponentName = 'github' | 'runner' | 'web';

export interface ProcessRecord {
  pid: number;
  startedAt: string;
  log: string;
  command: string;
}

export interface FixtureAccount {
  login: string;
  id: number;
  type: 'Organization' | 'User';
  installationId: number;
}

export interface FixtureRepoState {
  fullName: string;
  owner: string;
  name: string;
  id: number;
  installationId: number;
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
  /** Files left modified / added / deleted in the worktree (not committed). */
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

export interface StackState {
  version: 1;
  name: string;
  createdAt: string;
  updatedAt: string;
  dir: string;
  ports: StackPorts;
  urls: StackUrls;
  database: { name: string; url: string; adminUrl: string };
  secrets: StackSecrets;
  owner: { name: string; email: string; password: string; totpSecret: string | null; userId: string | null; created: boolean };
  options: { web: boolean; scheduler: boolean; pristine: boolean };
  paths: StackLayout;
  processes: Partial<Record<ComponentName, ProcessRecord>>;
  github: {
    appId: number;
    slug: string;
    accounts: FixtureAccount[];
    connected: boolean;
  };
  repos: FixtureRepoState[];
  seeded: SeededData;
}

export function readState(file: string): StackState | null {
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as StackState;
    return state.version === 1 ? state : null;
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
  writeState(file, state);
  return state;
}

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
      if (Date.now() > deadline) throw new Error(`Pile verrouillée par le processus ${holder.pid ?? '?'} (${holder.label ?? '?'}).`);
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
