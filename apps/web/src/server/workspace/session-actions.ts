import 'server-only';
import { isLiveStatus, type InstructionResult, type TerminalResult } from '@/features/workspace/lib/contract';
import { AppError } from '@/server/errors';
import { assertCanDriveSession, resumeSession, startNewSession } from '@/server/sessions';
import type { RequestContext } from '@/server/tenancy/context';
import { requireSessionContext } from './access';

/**
 * Composer and header actions of the Workspace: instruction (typed into the official CLI by the
 * runner of the session's server, bracketed paste + Entrée), Échap (« Interrompre ») and the
 * session's raw terminal. The session must be one of the space (same 404 as an unknown id
 * otherwise) and the account must be allowed to drive it (`canDriveSession`).
 */

type WorkspaceCtx = Pick<RequestContext, 'user' | 'space' | 'environment'>;

function assertUsable(status: string, archivedAt: Date | null): void {
  if (status === 'archived' || archivedAt) {
    throw new AppError('CONFLICT', "Session archivée : elle ne reçoit plus d'instruction.", {
      untouched: "L'instruction n'a pas été envoyée.",
    });
  }
}

/**
 * « Envoyer » (D05 composer, S1). The runner's instruction call carries no launch options, so a
 * session whose CLI is not running is first launched by the sessions lot with options rebuilt for
 * this account (MCP, variables, effective policy of the space, Git identity): a new session starts
 * its CLI at the first instruction (W1, `startNewSession`); a session whose CLI is gone (terminée,
 * interrompue, arrêtée) is resumed with `claude --resume` (audited `session.resume`). The
 * instruction then joins that run. While the CLI waits for a permission the runner refuses (409
 * SESSION_BUSY_PERMISSION).
 */
export async function sendInstruction(ctx: WorkspaceCtx, sessionId: string, text: string): Promise<InstructionResult> {
  const { scope, session } = await requireSessionContext(ctx, sessionId);
  assertCanDriveSession(ctx, scope);
  assertUsable(session.status, session.archivedAt);
  const current = await scope.runner.getSession({ params: { sessionId: scope.sessionId } }, { timeoutMs: 8_000 });
  let resumed = false;
  let started = false;
  if (!current.live && !isLiveStatus(current.status)) {
    if (current.status === 'new') {
      await startNewSession(ctx, scope.sessionId);
      started = true;
    } else {
      await resumeSession(ctx, scope.sessionId);
      resumed = true;
    }
  }
  const result = await scope.runner.sendInstruction({ params: { sessionId: scope.sessionId }, body: { text } });
  return {
    delivered: result.delivered,
    queued: result.queued,
    started: started || result.started,
    resumed: resumed || result.resumed,
    status: result.session.status,
    queuedInstructions: result.session.queuedInstructions,
  };
}

/** « Interrompre » / Échap: the current step stops, the session stays alive (W2). */
export async function interruptSession(ctx: Pick<RequestContext, 'space'>, sessionId: string): Promise<{ status: string }> {
  const { scope } = await requireSessionContext(ctx, sessionId);
  assertCanDriveSession(ctx, scope);
  const current = await scope.runner.getSession({ params: { sessionId: scope.sessionId } }, { timeoutMs: 8_000 });
  if (!current.live) {
    throw new AppError('CONFLICT', 'Aucun processus Claude Code ne tourne pour cette session.', { untouched: "Rien n'a été interrompu." });
  }
  const dto = await scope.runner.interruptSession({ params: { sessionId: scope.sessionId } });
  return { status: dto.status };
}

/**
 * Raw terminal of the session (W2 « Terminal brut »): the PTY of the CLI on the session's server,
 * owned by the session. Typing in it drives the session: same rule as the composer.
 */
export async function getSessionTerminal(ctx: Pick<RequestContext, 'space'>, sessionId: string): Promise<TerminalResult> {
  const { scope } = await requireSessionContext(ctx, sessionId);
  assertCanDriveSession(ctx, scope);
  const result = await scope.runner.sessionTerminal({ params: { sessionId: scope.sessionId } }, { timeoutMs: 8_000 });
  return { terminalId: result.terminalId, live: result.live };
}
