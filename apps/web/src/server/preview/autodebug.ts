import 'server-only';
import { auditLog, commandRuns } from '@nuera/db/schema';
import { DEFAULT_DEV_SERVER_NAME } from '@nuera/shared/runner';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { buildAutodebugInstruction, devServerFailure } from '@/lib/preview-autodebug';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { decryptedEnvForRuns } from '@/server/projects/env';
import { assertCanDriveSession } from '@/server/sessions';
import type { RequestContext } from '@/server/tenancy/context';
import { auditIn, NOT_FOUND_MESSAGES, scopeOfRun } from '@/server/tenancy/scope';
import { requireSessionContext } from '@/server/workspace/access';
import { sendInstruction } from '@/server/workspace/session-actions';

export const previewAutodebugInputSchema = z
  .object({
    runId: z.uuid('lancement invalide'),
    sessionId: z.uuid('session invalide'),
    /** `auto`: « Demander à Claude de corriger automatiquement » · `manual`: « Demander à Claude ». */
    trigger: z.enum(['auto', 'manual']),
    /**
     * Output the browser received while the server still runs (the runner keeps the live tail; the
     * row gets it at the end). Only the owner's own text: it goes to the owner's own session.
     */
    output: z.string().max(64 * 1024).optional(),
  })
  .strict();
export type PreviewAutodebugInput = z.input<typeof previewAutodebugInputSchema>;

export interface PreviewAutodebugResult {
  delivered: boolean;
  queued: boolean;
  status: string;
  queuedInstructions: number;
}

/** Runs being handed over right now (one web container): a double request never sends twice. */
const inFlight = new Set<string>();

/**
 * « Le serveur de développement ne démarre pas » → its output to Claude in the session (audited
 * `preview.autodebug`). The owner started the server from this session's Aperçu: the request is
 * theirs. Checks: session and run of the space (the same 404 as an unknown id), a dev server of
 * the session's worktree, really failing (ended in error, or no port after a minute with errors in
 * its output — any run without port when asked by hand), never twice for the same run. While a
 * permission waits the runner refuses (409 `SESSION_BUSY_PERMISSION`): nothing is recorded, the
 * browser asks again once it is answered.
 */
export async function requestPreviewAutodebug(
  ctx: Pick<RequestContext, 'user' | 'space' | 'environment'>,
  input: PreviewAutodebugInput,
): Promise<PreviewAutodebugResult> {
  const parsed = previewAutodebugInputSchema.parse(input);
  const { scope: sessionScope, session, worktree } = await requireSessionContext(ctx, parsed.sessionId);
  assertCanDriveSession(ctx, sessionScope);
  const runScope = await scopeOfRun(ctx, parsed.runId);
  const [row] = await db.select().from(commandRuns).where(eq(commandRuns.id, runScope.runId)).limit(1);
  if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGES.run);
  if (row.kind !== 'dev') throw new AppError('VALIDATION', "Ce lancement n'est pas un serveur de développement.", { reason: 'PREVIEW_NOT_DEV' });
  if (row.projectId !== session.projectId || !worktree || row.worktreeId !== worktree.id) {
    throw new AppError('VALIDATION', "Ce serveur de développement ne tourne pas dans le worktree de cette session.", { untouched: "Rien n'a été envoyé à Claude." });
  }

  if (inFlight.has(row.id)) throw alreadySent();
  inFlight.add(row.id);
  try {
    const [sent] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, 'preview.autodebug'), eq(auditLog.targetId, row.id), eq(auditLog.spaceId, ctx.space.id)))
      .limit(1);
    if (sent) throw alreadySent();

    // The live state of the run on its server (the stored row when the runner no longer knows it).
    let status: string = row.status;
    let port = row.port;
    let exitCode = row.exitCode;
    try {
      const live = await runScope.runner.getRun({ params: { runId: row.id } }, { timeoutMs: 5_000 });
      status = live.live || live.status !== 'running' ? live.status : 'stopped';
      port = live.port;
      exitCode = live.exitCode;
    } catch {
      // stored row
    }
    const output = status === 'running' ? (parsed.output ?? row.outputTail ?? '') : row.outputTail || parsed.output || '';
    const failure =
      devServerFailure({ status, port, startedAt: row.startedAt.toISOString(), exitCode }, output) ??
      (parsed.trigger === 'manual' && status === 'running' && !port ? 'stalled' : null);
    if (!failure) {
      throw new AppError('CONFLICT', "Le serveur de développement n'est pas en échec : rien à corriger pour l'instant.", {
        reason: 'AUTODEBUG_NOT_FAILED',
        untouched: "Rien n'a été envoyé à Claude.",
      });
    }

    const name = row.details?.devServer ?? DEFAULT_DEV_SERVER_NAME;
    const env = await decryptedEnvForRuns(row.projectId);
    const text = buildAutodebugInstruction({ name, command: row.command, output, failure, exitCode, knownSecrets: Object.values(env) });
    const result = await sendInstruction(ctx, sessionScope.sessionId, text);
    await auditIn(ctx, {
      action: 'preview.autodebug',
      summary: `sortie du serveur de développement « ${name} » envoyée à Claude : ${row.command}`,
      targetType: 'run',
      targetId: row.id,
      environmentId: runScope.environmentId,
      metadata: {
        sessionId: sessionScope.sessionId,
        projectId: row.projectId,
        name,
        trigger: parsed.trigger,
        failure,
        exitCode,
        delivered: result.delivered,
        queued: result.queued,
      },
    });
    return { delivered: result.delivered, queued: result.queued, status: result.status, queuedInstructions: result.queuedInstructions };
  } finally {
    inFlight.delete(row.id);
  }
}

function alreadySent(): AppError {
  return new AppError('CONFLICT', 'Claude a déjà reçu la sortie de ce lancement.', {
    reason: 'AUTODEBUG_ALREADY_SENT',
    untouched: "Rien n'a été envoyé à Claude une seconde fois.",
  });
}
