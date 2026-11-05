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
 * Everything goes through the stack's REAL runner (Bearer RUNNER_TOKEN from state.json) and the
 * TEST-ONLY fake Claude CLI (apps/runner/test/fixtures/fake-claude.mjs).
 */
import type { Page } from '@playwright/test';
import type { SessionDto, SessionStatusValue } from '@nuera/shared/runner';
import type { FakeCliScript } from '../harness/scenarios';
import type { RunnerApi } from '../harness/runner-api';
import type { TestSessionInput } from '../harness/seed';
import type { SeededData, SeededProject, StackState } from '../harness/state';
import { E2E_STACK } from './env';

export type { FakeCliScript, RunnerApi, SeededData, SeededProject, SessionDto, StackState };

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

/** Typed calls to the stack's runner (same contract as the web's runner client). */
export async function stackRunnerApi(): Promise<RunnerApi> {
  const { runnerApiFor } = await import('../harness/stack');
  return runnerApiFor(await stackState());
}

/** Runs seed scenarios (`projects`, `sessions`, `changes`, `runs`, `notifications`, `all`) — idempotent. */
export async function seedStack(...scenarios: string[]): Promise<SeededData> {
  const { seed } = await import('../harness/stack');
  return seed(E2E_STACK, scenarios.length ? scenarios : ['all'], { log: () => undefined });
}

export interface WaitForSessionOptions {
  timeoutMs?: number;
  /** Extra condition on the session (e.g. `(s) => s.pendingPermission !== null`). */
  where?: (session: SessionDto) => boolean;
}

/** Polls the runner until the session reaches one of `status` (and `where`); returns it. */
export async function waitForSessionStatus(sessionId: string, status: SessionStatusValue | SessionStatusValue[], options: WaitForSessionOptions = {}): Promise<SessionDto> {
  const { waitForSession } = await import('../harness/seed');
  const wanted = Array.isArray(status) ? status : [status];
  return waitForSession(await stackRunnerApi(), sessionId, (session) => wanted.includes(session.status) && (options.where?.(session) ?? true), `session ${sessionId} → ${wanted.join(' | ')}`, options.timeoutMs ?? 120_000);
}

export interface CliHelpers {
  /**
   * Creates a session the way the web does (new worktree from the default branch) on a seeded
   * project (`devis` by default; run `seed projects` first).
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
   * Installs a custom script of the fake CLI and returns the instruction that runs it
   * (`scenario:<name> …`). Names `full`, `long`, `fail` are reserved.
   */
  script(name: string, script: FakeCliScript): Promise<string>;
  /** Login state of the fake CLI (`claude auth status`, T6). */
  setLoggedIn(loggedIn: boolean): Promise<string>;
}

export function cliHelpers(): CliHelpers {
  return {
    async createSession(input) {
      const { createTestSession } = await import('../harness/seed');
      const state = await stackState();
      const key = input.project ?? 'devis';
      const project = state.seeded.projects?.[key];
      if (!project) throw new Error(`Projet « ${key} » absent de la pile ${state.name} : lancez \`seed projects\`.`);
      return createTestSession(await stackRunnerApi(), state, project, input);
    },
    async sendInstruction(sessionId, text) {
      await (await stackRunnerApi())('sendInstruction', { params: { sessionId }, body: { text } });
    },
    async waitForPermission(sessionId, timeoutMs = 120_000) {
      const session = await waitForSessionStatus(sessionId, 'waiting_permission', { timeoutMs, where: (item) => item.pendingPermission !== null });
      return { ...session.pendingPermission!, sessionId };
    },
    async answerPermission(permissionId, behavior, options = {}) {
      const state = await stackState();
      await (await stackRunnerApi())('permissionDecision', {
        params: { permissionId },
        body: { behavior, always: options.always ?? false, ...(options.message ? { message: options.message } : {}), decidedByUserId: state.owner.userId },
      });
    },
    async waitForTurn(sessionId, instruction, timeoutMs = 180_000) {
      const { turnDone, waitForSession } = await import('../harness/seed');
      return waitForSession(await stackRunnerApi(), sessionId, turnDone(instruction), `fin du tour de ${sessionId}`, timeoutMs);
    },
    async typeInTerminal(sessionId, data) {
      const api = await stackRunnerApi();
      const terminal = await api('sessionTerminal', { params: { sessionId } });
      if (!terminal.terminalId) throw new Error(`Session ${sessionId} sans terminal vivant.`);
      await api('terminalInput', { params: { terminalId: terminal.terminalId }, body: { data } });
    },
    async script(name, script) {
      const { writeScript } = await import('../harness/scenarios');
      const state = await stackState();
      writeScript(state.paths.claudeScenarios, name, script);
      return `scenario:${name}`;
    },
    async setLoggedIn(loggedIn) {
      const { setClaudeLoggedIn } = await import('../harness/stack');
      return setClaudeLoggedIn(E2E_STACK, loggedIn, () => undefined);
    },
  };
}
