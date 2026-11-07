import 'server-only';
import { AppError, toAppError, toErrorBody } from '@/server/errors';

/**
 * Errors of the Workspace routes. Runner sub-codes (`reason`) become the French copy of the
 * Workspace (« what failed / what was not touched », rule T4) and the reason itself is kept in the
 * JSON body so the browser can react (reload a decided permission, show the terminal…).
 *
 *   export const POST = apiRoute({ handler: () => withWorkspaceErrors(() => sendInstruction(…)) });
 */

interface ReasonCopy {
  message?: string;
  untouched?: string;
}

/** Copy by runner reason. `message` overrides the runner message only when the Workspace says better. */
export const REASON_COPY: Readonly<Record<string, ReasonCopy>> = {
  SESSION_BUSY_PERMISSION: {
    message: "Répondez d'abord à la demande d'autorisation ci-dessus.",
    untouched: "L'instruction n'a pas été envoyée.",
  },
  SESSION_NOT_LIVE: { untouched: "Rien n'a été envoyé au CLI." },
  SESSION_NOT_RESUMABLE: {
    message: 'Cette session ne peut plus être reprise : elle ou son projet est archivé.',
    untouched: "L'historique reste lisible.",
  },
  RESUME_CONTEXT_REQUIRED: {
    message: 'La conversation enregistrée par Claude Code est introuvable : reprenez la session avec un nouveau contexte.',
    untouched: "Rien n'a été modifié.",
  },
  CAPACITY_REACHED: { untouched: 'Aucune session démarrée.' },
  PERMISSION_NOT_PENDING: {
    message: 'Cette demande a déjà reçu une réponse.',
    untouched: "Rien n'a été transmis au CLI.",
  },
  PERMISSION_NO_LISTENER: {
    message: "La demande n'attend plus de réponse ici : répondez dans le terminal de la session.",
    untouched: "Rien n'a été transmis au CLI.",
  },
  BRANCH_PROTECTED: {
    message: "Cette branche est protégée : elle évolue par pull request, jamais par un push direct.",
    untouched: "Rien n'a été envoyé sur GitHub.",
  },
  NOTHING_TO_COMMIT: { message: 'Rien à committer : aucun des fichiers choisis ne contient de modification.', untouched: 'Aucun commit créé.' },
  PUSH_REJECTED: {
    message: 'GitHub a refusé le push : la branche distante contient des commits absents du worktree.',
    untouched: "Le commit reste dans le worktree ; rien n'a été écrasé sur GitHub.",
  },
  GIT_AUTH_FAILED: {
    message: "GitHub a refusé l'accès de l'application à ce dépôt.",
    untouched: "Rien n'a été envoyé sur GitHub.",
  },
  GIT_CONFIG_UNSAFE: { untouched: "Rien n'a été envoyé ni récupéré." },
  NO_UPSTREAM: { untouched: "Rien n'a été envoyé sur GitHub." },
  WORKTREE_MISSING: {
    message: 'Le worktree de cette session a été supprimé sur le serveur.',
    untouched: "L'historique de la session reste lisible.",
  },
  FILE_TOO_LARGE: { message: 'Fichier trop volumineux pour être affiché ici.' },
  BINARY_FILE: { message: 'Fichier binaire : aperçu indisponible.' },
  PATH_REJECTED: { message: 'Chemin refusé : il sort du worktree de la session.' },
  TIMEOUT: { untouched: "L'opération a été abandonnée côté serveur." },
};

export interface WorkspaceErrorBody {
  error: {
    code: string;
    message: string;
    detail?: string;
    raw?: string;
    untouched?: string;
    reason?: string;
  };
}

/**
 * Error body with the Workspace copy for a reason (pure, tested). The reason comes from the runner
 * (RunnerError) or from the web itself (AppError: NO_ENVIRONMENT, RUNNER_OUTDATED…).
 */
export function workspaceErrorBody(error: unknown): { status: number; body: WorkspaceErrorBody; retryAfter?: number } {
  const appError = toAppError(error);
  const body = toErrorBody(appError) as WorkspaceErrorBody;
  const reason = appError.reason;
  if (reason) {
    body.error.reason = reason;
    const copy = REASON_COPY[reason];
    if (copy?.message) {
      // Keep the runner's own sentence as detail when it adds something.
      if (appError.message && appError.message !== copy.message && !body.error.detail) body.error.detail = appError.message;
      body.error.message = copy.message;
    }
    if (copy?.untouched && !body.error.untouched) body.error.untouched = copy.untouched;
  }
  return {
    status: appError.status,
    body,
    ...(appError.retryAfterSeconds !== undefined ? { retryAfter: appError.retryAfterSeconds } : {}),
  };
}

/** Runs a handler and turns any error into the Workspace JSON error response (with `reason`). */
export async function withWorkspaceErrors<T>(fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn();
  } catch (error) {
    if (isNextControlFlow(error)) throw error;
    const appError = toAppError(error);
    if (appError.code === 'INTERNAL') console.error('[workspace]', error);
    const { status, body, retryAfter } = workspaceErrorBody(error);
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    if (retryAfter !== undefined) headers.set('retry-after', String(Math.max(1, Math.ceil(retryAfter))));
    return new Response(JSON.stringify(body), { status, headers });
  }
}

function isNextControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest.startsWith('NEXT_HTTP_ERROR_FALLBACK'));
}

/** Re-throws an error as a Workspace AppError keeping the runner reason copy (for server actions / pages). */
export function notFound(what: string): AppError {
  return new AppError('NOT_FOUND', what);
}
