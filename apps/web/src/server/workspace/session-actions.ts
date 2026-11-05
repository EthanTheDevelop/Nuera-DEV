import 'server-only';
import { isLiveStatus, type InstructionResult, type TerminalResult } from '@/features/workspace/lib/contract';
import { AppError } from '@/server/errors';
import { runner } from '@/server/runner/client';
import { resumeSession } from '@/server/sessions';
import { requireSessionContext } from './access';

/**
 * Composer and header actions of the Workspace: instruction (typed into the official CLI by the
 * runner, bracketed paste + Entrée), Échap (« Interrompre ») and the session's raw terminal.
 */

export interface WorkspaceActor {
  id: string;
}

function assertUsable(status: string, archivedAt: Date | null): void {
  if (status === 'archived' || archivedAt) {
    throw new AppError('CONFLICT', "Session archivée : elle ne reçoit plus d'instruction.", {
      untouched: "L'instruction n'a pas été envoyée.",
    });
  }
}

/**
 * « Envoyer » (D05 composer, S1). A new session starts its CLI at the first instruction (W1); a
 * session whose CLI is gone (terminée, interrompue, arrêtée) is resumed first with
 * `claude --resume` and the launch options rebuilt by the sessions lot (audited `session.resume`).
 * While the CLI waits for a permission the runner refuses (409 SESSION_BUSY_PERMISSION).
 */
export async function sendInstruction(sessionId: string, text: string, actor: WorkspaceActor): Promise<InstructionResult> {
  const { session } = await requireSessionContext(sessionId);
  assertUsable(session.status, session.archivedAt);
  const current = await runner.getSession({ params: { sessionId } }, { timeoutMs: 8_000 });
  let resumed = false;
  if (!current.live && current.status !== 'new' && !isLiveStatus(current.status)) {
    await resumeSession(sessionId, actor);
    resumed = true;
  }
  const result = await runner.sendInstruction({ params: { sessionId }, body: { text } });
  return {
    delivered: result.delivered,
    queued: result.queued,
    started: result.started,
    resumed: resumed || result.resumed,
    status: result.session.status,
    queuedInstructions: result.session.queuedInstructions,
  };
}

/** « Interrompre » / Échap: the current step stops, the session stays alive (W2). */
export async function interruptSession(sessionId: string): Promise<{ status: string }> {
  await requireSessionContext(sessionId);
  const current = await runner.getSession({ params: { sessionId } }, { timeoutMs: 8_000 });
  if (!current.live) {
    throw new AppError('CONFLICT', 'Aucun processus Claude Code ne tourne pour cette session.', { untouched: "Rien n'a été interrompu." });
  }
  const dto = await runner.interruptSession({ params: { sessionId } });
  return { status: dto.status };
}

/** Raw terminal of the session (W2 « Terminal brut »): the PTY of the CLI, owned by the session. */
export async function getSessionTerminal(sessionId: string): Promise<TerminalResult> {
  await requireSessionContext(sessionId);
  const result = await runner.sessionTerminal({ params: { sessionId } }, { timeoutMs: 8_000 });
  return { terminalId: result.terminalId, live: result.live };
}
