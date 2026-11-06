import 'server-only';
import { projects } from '@nuera/db/schema';
import type { GitIdentity } from '@nuera/shared/runner';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import type { RunnerClient } from '@/server/runner/client';
import { getGitIdentity, resolveGitIdentity } from '@/server/sessions/git-identity';
import type { RequestContext } from '@/server/tenancy/context';
import { scopeOfProject, type ProjectScope, type ScopeOptions } from '@/server/tenancy/scope';

/**
 * Gate of every project function (docs/MULTICOMPTE.md §5): the project is looked up IN the space of
 * the request context (`scopeOfProject`, one indexed query), so the id of another space answers
 * exactly like an unknown id — NOT_FOUND « Projet introuvable : il a peut-être été retiré. », no
 * runner call, nothing written. The state checks (archived, clone running or failed) only run
 * after that check. The runner of the handle is the one of the server HOLDING the project
 * (`projects.environment_id`, immutable), never « the current server of the space ».
 */

export type ProjectRow = typeof projects.$inferSelect;

/** What a project function needs: who acts (ctx), the row, its server and that server's runner. */
export interface ProjectHandle {
  row: ProjectRow;
  scope: ProjectScope;
  runner: RunnerClient;
  /** Server holding the project (« VPS-3 » for the default one). */
  environment: { id: string; name: string };
}

export type ProjectContext = Pick<RequestContext, 'user' | 'space' | 'environment'>;

export interface RequireProjectOptions extends ScopeOptions {
  /** `any` (default): any state · `active`: not archived · `ready`: not archived and cloned. */
  state?: 'any' | 'active' | 'ready';
  /** Copy of the « archived » refusal for `active` (default « Ce projet est archivé. »). */
  archived?: string;
}

/** The ready-state refusals (same copy as before the multi-account model). */
export function assertReady(row: ProjectRow): void {
  if (row.archivedAt) throw new AppError('CONFLICT', 'Ce projet est archivé : restaurez-le pour agir dessus.');
  if (row.status === 'cloning') throw new AppError('CONFLICT', 'Le clonage de ce projet est encore en cours.');
  if (row.status !== 'ready') {
    throw new AppError('CONFLICT', "Ce projet n'est pas prêt : son clonage a échoué.", { detail: row.statusDetail ?? undefined });
  }
}

export async function requireProject(ctx: Pick<RequestContext, 'space'>, projectId: string, options: RequireProjectOptions = {}): Promise<ProjectHandle> {
  const scope = await scopeOfProject(ctx, projectId, options);
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.spaceId, ctx.space.id)))
    .limit(1);
  // Deleted between the two reads (discarded failed clone): same answer as an unknown id.
  if (!row) throw new AppError('NOT_FOUND', options.notFound ?? 'Projet introuvable : il a peut-être été retiré.');
  const state = options.state ?? 'any';
  if (state === 'active' && row.archivedAt) throw new AppError('CONFLICT', options.archived ?? 'Ce projet est archivé.');
  if (state === 'ready') assertReady(row);
  return { row, scope, runner: scope.runner, environment: { id: scope.environmentId, name: scope.environmentName } };
}

/** The project row of the space, or null (never throws for an unknown or foreign id). */
export async function findProject(ctx: Pick<RequestContext, 'space'>, projectId: string): Promise<ProjectRow | null> {
  try {
    return (await requireProject(ctx, projectId)).row;
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

/**
 * Author and committer of what the account does through the runner (runs, CLAUDE.md commits): the
 * same rule as its sessions and Workspace commits (`getGitIdentity`: Paramètres › Identité Git,
 * else the account's name and e-mail). Null when nothing valid can be built (the runner then keeps
 * its own default); a preferences read failure falls back to the account itself.
 */
export async function gitIdentityOf(ctx: Pick<RequestContext, 'user'>): Promise<GitIdentity | null> {
  return getGitIdentity(ctx.user).catch(() => resolveGitIdentity(ctx.user, null));
}
