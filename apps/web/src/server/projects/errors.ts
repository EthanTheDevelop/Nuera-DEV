import 'server-only';
import { AppError, toAppError, toErrorBody } from '@/server/errors';
import { RunnerError } from '@/server/runner/client';
import type { ProjectErrorBody } from './types';

/**
 * Errors of the Projets domain.
 *
 * The generic `toErrorBody` drops the runner's machine `reason` and `data`; the add flow (A4
 * « dossier non vide » + suggestions), the sync banner (T4) and the worktree dialog (T8) need them,
 * so the project routes answer with {@link projectErrorResponse}. Only an allow-list of data keys
 * is forwarded (paths, counts, branch names — never a secret).
 */

/** AppError carrying a reason/data pair produced by the web itself (destination checks…). */
export class ProjectError extends AppError {
  readonly reason?: string;
  readonly data?: Record<string, unknown>;
  constructor(
    code: ConstructorParameters<typeof AppError>[0],
    message: string,
    options: { reason?: string; data?: Record<string, unknown>; untouched?: string; detail?: string; raw?: string; cause?: unknown } = {},
  ) {
    const { reason, data, ...rest } = options;
    super(code, message, rest);
    this.name = 'ProjectError';
    if (reason !== undefined) this.reason = reason;
    if (data !== undefined) this.data = data;
  }
}

const SAFE_DATA_KEYS = new Set([
  'path',
  'fileCount',
  'exists',
  'empty',
  'available',
  'suggestedPath',
  'existingClone',
  'existingProject',
  'ahead',
  'behind',
  'branch',
  'upstream',
  'files',
  'count',
  'stage',
  'active',
  'max',
]);

function safeData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!SAFE_DATA_KEYS.has(key)) continue;
    if (key === 'existingClone' && value && typeof value === 'object') {
      // The remote URL could carry credentials in a hand-made clone: never forwarded.
      const { fullName = null, branch = null, sameRepository = false } = value as Record<string, unknown>;
      out[key] = { fullName, branch, sameRepository };
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

export function projectErrorBody(error: unknown): ProjectErrorBody {
  const body = toErrorBody(error) as ProjectErrorBody;
  if (error instanceof RunnerError || error instanceof ProjectError) {
    if (error.reason) body.error.reason = error.reason;
    const data = safeData(error.data);
    if (data) body.error.data = data;
  }
  return body;
}

export function projectErrorResponse(error: unknown): Response {
  const appError = toAppError(error);
  if (appError.code === 'INTERNAL') console.error('[projets]', error);
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  if (appError.retryAfterSeconds !== undefined) headers.set('retry-after', String(Math.max(1, Math.ceil(appError.retryAfterSeconds))));
  return new Response(JSON.stringify(projectErrorBody(error)), { status: appError.status, headers });
}

/** Runs a route body and turns any failure into {@link projectErrorResponse} (keeps reason/data). */
export async function withProjectErrors<T>(fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn();
  } catch (error) {
    if (isNextControlFlow(error)) throw error;
    return projectErrorResponse(error);
  }
}

function isNextControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === 'string' && (digest.startsWith('NEXT_REDIRECT') || digest.startsWith('NEXT_HTTP_ERROR_FALLBACK'));
}

/**
 * French T4 copy of the git reasons the Projets pages meet (what failed + what was not touched).
 * The runner message is kept as the detail: it names the branch, counts, files.
 */
export const SYNC_REASON_COPY: Record<string, { title: string; untouched: string }> = {
  PULL_DIVERGED: {
    title: 'La branche locale et origin ont divergé',
    untouched: "Aucun commit ni fichier local n'a été modifié. Ouvrez une session pour fusionner ou rebaser.",
  },
  PULL_CONFLICT: {
    title: 'La mise à jour a rencontré un conflit',
    untouched: "Votre branche est revenue à son état d'avant la mise à jour.",
  },
  PULL_DIRTY: {
    title: 'Des modifications locales empêchent la mise à jour',
    untouched: "Aucun fichier local n'a été modifié.",
  },
  WORKTREE_DIRTY: {
    title: 'Des modifications non commitées bloquent l\'opération',
    untouched: "Aucun fichier n'a été modifié.",
  },
  GIT_CONFIG_UNSAFE: {
    title: 'La configuration Git du dépôt a été refusée',
    untouched: "Rien n'a été envoyé ni récupéré.",
  },
  GIT_AUTH_FAILED: {
    title: "GitHub a refusé l'accès au dépôt",
    untouched: "Rien n'a été récupéré : vérifiez l'application GitHub dans Intégrations.",
  },
  NO_UPSTREAM: {
    title: "La branche n'existe pas sur origin",
    untouched: "Aucun fichier local n'a été modifié.",
  },
  TIMEOUT: {
    title: 'GitHub n\'a pas répondu à temps',
    untouched: "Aucun fichier local n'a été modifié.",
  },
};

/** Re-throws a runner error with the T4 title of its reason (message kept as detail). */
export function withSyncCopy(error: unknown): never {
  if (error instanceof RunnerError && error.reason && SYNC_REASON_COPY[error.reason]) {
    const copy = SYNC_REASON_COPY[error.reason]!;
    throw new ProjectError(error.code, copy.title, {
      reason: error.reason,
      ...(error.data ? { data: error.data } : {}),
      detail: error.message,
      untouched: error.untouched ?? copy.untouched,
      ...(error.raw ? { raw: error.raw } : {}),
      cause: error,
    });
  }
  throw error;
}
