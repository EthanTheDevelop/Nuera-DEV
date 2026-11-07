import { auditLog, commandRuns } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeWebTestDb, prepareTenancyDatabase, useTestEncryptionKey } from '@/server/tenancy/test/db';
import { startFakeRunner, type FakeRunner } from '@/server/tenancy/test/fake-runner';
import { createTestAccount, createTestResources, truncateTenancy, type TestAccount, type TestResources } from '@/server/tenancy/test/fixtures';

/*
 * « Aperçu » — a dev server started from the session that does not start is handed to Claude in
 * that session: only a failing dev server of the session's worktree, of the space, once per run;
 * nothing recorded while a permission waits (the browser asks again after it is answered).
 */

const sent: Array<{ sessionId: string; text: string }> = [];
const busy = { permission: false };
vi.mock('@/server/workspace/session-actions', () => ({
  sendInstruction: vi.fn<(ctx: unknown, sessionId: string, text: string) => Promise<unknown>>(async (_ctx, sessionId, text) => {
    if (busy.permission) {
      const { RunnerError } = await import('@/server/runner/errors');
      throw new RunnerError('CONFLICT', "Répondez d'abord à la demande d'autorisation.", { reason: 'SESSION_BUSY_PERMISSION' });
    }
    sent.push({ sessionId, text });
    return { delivered: true, queued: false, started: false, resumed: false, status: 'running', queuedInstructions: 0 };
  }),
}));

const { requestPreviewAutodebug } = await import('./autodebug');
const { db } = await import('@/server/db');

describe.skipIf(process.env.NUERA_TEST_DB === '0')('preview autodebug', () => {
  let runner: FakeRunner;
  let otherRunner: FakeRunner;
  let a: TestAccount;
  let b: TestAccount;
  let res: TestResources;

  beforeAll(async () => {
    await prepareTenancyDatabase('apercu_autodebug');
    useTestEncryptionKey();
    runner = await startFakeRunner();
    otherRunner = await startFakeRunner();
  });

  afterAll(async () => {
    await runner?.close();
    await otherRunner?.close();
    await closeWebTestDb();
  });

  beforeEach(async () => {
    await truncateTenancy();
    sent.length = 0;
    busy.permission = false;
    a = await createTestAccount({ role: 'owner', environment: { configSource: 'db', isDefault: false, url: runner.url, name: 'VPS-3' } });
    b = await createTestAccount({ role: 'member', environment: { configSource: 'db', url: otherRunner.url, name: 'VPS-4' } });
    res = await createTestResources(a, 'autodebug-a');
    await createTestResources(b, 'autodebug-b');
    runner.requests.length = 0;
    otherRunner.requests.length = 0;
  });

  async function devRun(values: Partial<typeof commandRuns.$inferInsert>) {
    const [row] = await db
      .insert(commandRuns)
      .values({
        projectId: res.projectId,
        environmentId: a.environment!.id,
        worktreeId: res.worktreeId,
        kind: 'dev',
        command: 'pnpm --filter client dev',
        status: 'failed',
        exitCode: 1,
        details: { devServer: 'client' },
        outputTail: "> next dev\nError: Cannot find module 'tailwindcss'\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\n",
        ...values,
      })
      .returning();
    const run = row!;
    // The run's server answers about it (the row is the truth once it ended).
    runner.handle((_req, response) =>
      runner.json(response, 200, {
        id: run.id, projectId: run.projectId, worktreeId: run.worktreeId, kind: 'dev', command: run.command, status: run.status,
        exitCode: run.exitCode, pid: null, port: run.port, summary: null, tests: null, startedAt: run.startedAt.toISOString(),
        finishedAt: null, live: run.status === 'running', name: 'client',
      }),
    );
    return run;
  }

  it('hands the redacted end of the output to Claude in the session, once per run, audited', async () => {
    const run = await devRun({});
    const result = await requestPreviewAutodebug(a.ctx, { runId: run.id, sessionId: res.sessionId, trigger: 'auto' });
    expect(result).toMatchObject({ delivered: true, queued: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sessionId).toBe(res.sessionId);
    expect(sent[0]!.text).toContain("Le serveur de développement « client » (`pnpm --filter client dev`) ne démarre pas : il s'est arrêté avec le code 1.");
    expect(sent[0]!.text).toContain("Error: Cannot find module 'tailwindcss'");
    expect(sent[0]!.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    const audits = await db.select().from(auditLog).where(eq(auditLog.action, 'preview.autodebug'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ targetId: run.id, spaceId: a.space.id, environmentId: a.environment!.id });
    expect(audits[0]!.metadata).toMatchObject({ sessionId: res.sessionId, name: 'client', trigger: 'auto', failure: 'exit' });

    // Never twice for the same run (another tab, the manual button after the automatic one).
    await expect(requestPreviewAutodebug(a.ctx, { runId: run.id, sessionId: res.sessionId, trigger: 'manual' })).rejects.toMatchObject({
      code: 'CONFLICT',
      reason: 'AUTODEBUG_ALREADY_SENT',
    });
    expect(sent).toHaveLength(1);
  });

  it('records nothing while a permission waits, then sends once it is answered', async () => {
    const run = await devRun({});
    busy.permission = true;
    await expect(requestPreviewAutodebug(a.ctx, { runId: run.id, sessionId: res.sessionId, trigger: 'auto' })).rejects.toMatchObject({
      reason: 'SESSION_BUSY_PERMISSION',
    });
    expect(await db.select().from(auditLog).where(eq(auditLog.action, 'preview.autodebug'))).toHaveLength(0);
    busy.permission = false;
    await requestPreviewAutodebug(a.ctx, { runId: run.id, sessionId: res.sessionId, trigger: 'auto' });
    expect(sent).toHaveLength(1);
  });

  it('refuses a server that runs fine, a run of another space (unknown-run 404, no runner call) and a run of another worktree', async () => {
    const healthy = await devRun({ status: 'running', exitCode: null, port: 3001, outputTail: 'ready' });
    await expect(requestPreviewAutodebug(a.ctx, { runId: healthy.id, sessionId: res.sessionId, trigger: 'manual' })).rejects.toMatchObject({
      reason: 'AUTODEBUG_NOT_FAILED',
    });
    // Without a port, by hand: the owner sees it does not start.
    const stuck = await devRun({ status: 'running', exitCode: null, port: null, outputTail: 'compiling…' });
    await requestPreviewAutodebug(a.ctx, { runId: stuck.id, sessionId: res.sessionId, trigger: 'manual', output: 'Error: port en conflit' });
    expect(sent.at(-1)!.text).toContain('Error: port en conflit');
    // ...but never automatically before a minute with errors.
    const young = await devRun({ status: 'running', exitCode: null, port: null, outputTail: 'Error' });
    await expect(requestPreviewAutodebug(a.ctx, { runId: young.id, sessionId: res.sessionId, trigger: 'auto', output: 'Error' })).rejects.toMatchObject({
      reason: 'AUTODEBUG_NOT_FAILED',
    });

    const failed = await devRun({});
    runner.requests.length = 0;
    await expect(requestPreviewAutodebug(b.ctx, { runId: failed.id, sessionId: res.sessionId, trigger: 'manual' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(runner.requests).toHaveLength(0);
    expect(otherRunner.requests).toHaveLength(0);
    const tests = await db.select().from(commandRuns).where(eq(commandRuns.id, res.runId));
    expect(tests[0]!.kind).toBe('test');
    await expect(requestPreviewAutodebug(a.ctx, { runId: res.runId, sessionId: res.sessionId, trigger: 'manual' })).rejects.toMatchObject({ reason: 'PREVIEW_NOT_DEV' });
    const elsewhere = await devRun({ worktreeId: null });
    await expect(requestPreviewAutodebug(a.ctx, { runId: elsewhere.id, sessionId: res.sessionId, trigger: 'manual' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});
