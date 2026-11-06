/**
 * TEST-ONLY — access to the local test stack from Playwright specs (and from scripts):
 *
 *   import { test, expect } from './fixtures';
 *   test('…', async ({ page, stack, runnerApi, seed, waitForSessionStatus, cli }) => {
 *     const devis = stack.seeded.projects!.devis!;
 *     const session = await cli.createSession({ title: 'Essai', branch: 'test/essai' });
 *     await cli.sendInstruction(session.id, cli.script('essai-court', { description: '…', steps: [{ final: 'Fait.' }] }));
 *     await waitForSessionStatus(session.id, 'waiting_input');
 *   });
 *
 * Everything goes through the stack's REAL runners (Bearer: each server's RUNNER_TOKEN from
 * state.json) and the TEST-ONLY fake Claude CLI (apps/runner/test/fixtures/fake-claude.mjs). Every
 * helper works for account `a` (the owner, server « VPS-3 ») by default and takes an account key for
 * the others (`cliHelpers('b')`, `stackRunnerApi('b')`, `seedStack(…)` with `{ account: 'b' }`).
 */
import type { Page } from '@playwright/test';
import type { SessionDto, SessionStatusValue } from '@nuera/shared/runner';
import type { StackKey } from '../harness/config';
import type { FakeCliScript } from '../harness/scenarios';
import type { RunnerApi } from '../harness/runner-api';
import type { TestSessionInput } from '../harness/seed';
import type { SeededData, SeededProject, StackAccount, StackRunner, StackState } from '../harness/state';
import { E2E_STACK } from './env';

export type { FakeCliScript, RunnerApi, SeededData, SeededProject, SessionDto, StackAccount, StackKey, StackRunner, StackState };

/**
 * Hides the `next dev` indicator before a screenshot compared with Figma (it covers the sidebar's
 * user card and the first phone tab): `await hideNextDevIndicator(page); await page.screenshot(…)`.
 */
export async function hideNextDevIndicator(page: Page): Promise<void> {
  const browser = await import('../harness/browser');
  await browser.hideNextDevIndicator(page);
}

/** state.json of the selected stack (E2E_STACK), re-read on every call. */
export async function stackState(): Promise<StackState> {
  const { loadState } = await import('../harness/stack');
  return loadState(E2E_STACK);
}

/** Account `key` of the stack (throws when the stack has no such account). */
export async function stackAccount(key: StackKey): Promise<StackAccount> {
  const { accountOf } = await import('../harness/state');
  return accountOf(await stackState(), key);
}

/** Server (runner) of account `key`'s space. */
export async function stackRunnerOf(key: StackKey): Promise<StackRunner> {
  const { runnerOfAccount } = await import('../harness/state');
  return runnerOfAccount(await stackState(), key);
}

/** Seeded data of account `key` (`a`: `stack.seeded`). */
export async function seededOfAccount(key: StackKey): Promise<SeededData> {
  const { seededOf } = await import('../harness/state');
  return seededOf(await stackState(), key);
}

/** Typed calls to a runner of the stack (same contract as the web's runner client). Default: server of account `a`. */
export async function stackRunnerApi(account: StackKey = 'a'): Promise<RunnerApi> {
  const { runnerApiFor } = await import('../harness/stack');
  const { runnerOfAccount } = await import('../harness/state');
  const state = await stackState();
  return runnerApiFor(state, account === 'a' ? 'a' : runnerOfAccount(state, account).key);
}

/** Runs seed scenarios (`projects`, `sessions`, `changes`, `runs`, `notifications`, `all`) — idempotent. */
export async function seedStack(...scenarios: Array<string | { account: StackKey }>): Promise<SeededData> {
  const { seed } = await import('../harness/stack');
  const names = scenarios.filter((item): item is string => typeof item === 'string');
  const options = scenarios.find((item): item is { account: StackKey } => typeof item === 'object');
  return seed(E2E_STACK, names.length ? names : ['all'], { log: () => undefined, account: options?.account ?? 'a' });
}

export interface WaitForSessionOptions {
  timeoutMs?: number;
  /** Extra condition on the session (e.g. `(s) => s.pendingPermission !== null`). */
  where?: (session: SessionDto) => boolean;
  /** Account whose server runs the session (default `a`). */
  account?: StackKey;
}

/** Polls the runner until the session reaches one of `status` (and `where`); returns it. */
export async function waitForSessionStatus(sessionId: string, status: SessionStatusValue | SessionStatusValue[], options: WaitForSessionOptions = {}): Promise<SessionDto> {
  const { waitForSession } = await import('../harness/seed');
  const wanted = Array.isArray(status) ? status : [status];
  return waitForSession(await stackRunnerApi(options.account ?? 'a'), sessionId, (session) => wanted.includes(session.status) && (options.where?.(session) ?? true), `session ${sessionId} → ${wanted.join(' | ')}`, options.timeoutMs ?? 120_000);
}

export interface CliHelpers {
  /** Account the helpers act for (its server, its seeded projects, its user id). */
  account: StackKey;
  /**
   * Creates a session the way the web does (new worktree from the default branch) on a seeded
   * project of the account (`devis` by default; run `seed projects` first).
   */
  createSession(input: TestSessionInput & { project?: string }): Promise<SessionDto>;
  /** Sends an instruction (the fake CLI answers the plain French sentences of scenarios.ts, or `scenario:<name>`). */
  sendInstruction(sessionId: string, text: string): Promise<void>;
  /** Waits until the session asks for a permission; returns the pending request. */
  waitForPermission(sessionId: string, timeoutMs?: number): Promise<NonNullable<SessionDto['pendingPermission']> & { sessionId: string }>;
  /** Answers a pending permission from « Nuera Dev » (what the browser's buttons call). */
  answerPermission(permissionId: string, behavior: 'allow' | 'deny', options?: { always?: boolean; message?: string }): Promise<void>;
  /** Waits for the end of the turn of `instruction` (status waiting_input, nothing queued). */
  waitForTurn(sessionId: string, instruction: string, timeoutMs?: number): Promise<SessionDto>;
  /** Types into the session's terminal (raw bytes: `'\x1b'` = Échap, `'/exit\r'`…). */
  typeInTerminal(sessionId: string, data: string): Promise<void>;
  /**
   * Installs a custom script of the fake CLI of the account's server and returns the instruction that
   * runs it (`scenario:<name> …`). Names `full`, `long`, `fail` are reserved.
   */
  script(name: string, script: FakeCliScript): Promise<string>;
  /** Login state of the fake CLI of the account's server (`claude auth status`, T6). */
  setLoggedIn(loggedIn: boolean): Promise<string>;
}

export function cliHelpers(account: StackKey = 'a'): CliHelpers {
  const api = () => stackRunnerApi(account);
  return {
    account,
    async createSession(input) {
      const { createTestSession } = await import('../harness/seed');
      const { accountOf, seededOf } = await import('../harness/state');
      const state = await stackState();
      const key = input.project ?? 'devis';
      const project = seededOf(state, account).projects?.[key];
      if (!project) throw new Error(`Projet « ${key} » absent du compte ${account} de la pile ${state.name} : lancez \`seed projects\`.`);
      const who = accountOf(state, account);
      return createTestSession(await api(), { userId: who.userId, gitIdentity: who.gitIdentity }, project, input);
    },
    async sendInstruction(sessionId, text) {
      await (await api())('sendInstruction', { params: { sessionId }, body: { text } });
    },
    async waitForPermission(sessionId, timeoutMs = 120_000) {
      const session = await waitForSessionStatus(sessionId, 'waiting_permission', { timeoutMs, where: (item) => item.pendingPermission !== null, account });
      return { ...session.pendingPermission!, sessionId };
    },
    async answerPermission(permissionId, behavior, options = {}) {
      const who = await stackAccount(account);
      await (await api())('permissionDecision', {
        params: { permissionId },
        body: { behavior, always: options.always ?? false, ...(options.message ? { message: options.message } : {}), decidedByUserId: who.userId },
      });
    },
    async waitForTurn(sessionId, instruction, timeoutMs = 180_000) {
      const { turnDone, waitForSession } = await import('../harness/seed');
      return waitForSession(await api(), sessionId, turnDone(instruction), `fin du tour de ${sessionId}`, timeoutMs);
    },
    async typeInTerminal(sessionId, data) {
      const runner = await api();
      const terminal = await runner('sessionTerminal', { params: { sessionId } });
      if (!terminal.terminalId) throw new Error(`Session ${sessionId} sans terminal vivant.`);
      await runner('terminalInput', { params: { terminalId: terminal.terminalId }, body: { data } });
    },
    async script(name, script) {
      const { writeScript } = await import('../harness/scenarios');
      const runner = await stackRunnerOf(account);
      writeScript(runner.paths.claudeScenarios, name, script);
      return `scenario:${name}`;
    },
    async setLoggedIn(loggedIn) {
      const { setClaudeLoggedIn } = await import('../harness/stack');
      const runner = await stackRunnerOf(account);
      return setClaudeLoggedIn(E2E_STACK, loggedIn, () => undefined, runner.key);
    },
  };
}

/** Restarts / stops a component of the stack (`runner` = « VPS-3 », `runner-b` = « VPS-4 »…). */
export async function restartComponent(component: 'github' | 'web' | 'runner' | 'runner-b' | 'runner-c'): Promise<void> {
  const { restart } = await import('../harness/stack');
  await restart(E2E_STACK, component, () => undefined);
}

export async function stopComponent(component: 'github' | 'web' | 'runner' | 'runner-b' | 'runner-c'): Promise<void> {
  const { stop } = await import('../harness/stack');
  await stop(E2E_STACK, component, () => undefined);
}

/** Controls of the fake GitHub (`{ app: 'b', rejectJwt: true }`, `{ bindNext: 'a2' }`, `{ release: 'a2' }`…). */
export async function controlFakeGithub(input: Record<string, unknown>): Promise<void> {
  const { controlGithub } = await import('../harness/stack');
  await controlGithub(E2E_STACK, input);
}

/** What the fake GitHub recorded: apps (manifest, installations, tokens, pulls) and every pull request. */
export interface FakeGithubState {
  apps: Array<{ key: string; appId: number; slug: string; bound: boolean; manifest: { name: string; public: boolean } | null; tokensIssued: number; pulls: Array<{ owner: string; repo: string; number: number; head: string; title: string }> }>;
  pulls: Array<{ owner: string; repo: string; number: number; head: string; base: string; title: string; draft: boolean; app: string; appId: number }>;
}

export async function fakeGithubState(): Promise<FakeGithubState> {
  const state = await stackState();
  const response = await fetch(`${state.urls.githubWeb}/__harness/state`);
  if (!response.ok) throw new Error(`Faux GitHub : HTTP ${response.status}`);
  return (await response.json()) as FakeGithubState;
}
