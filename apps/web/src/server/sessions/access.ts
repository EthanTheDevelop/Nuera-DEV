import 'server-only';
import { projects } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import type { RequestContext } from '@/server/tenancy/context';
import { NOT_FOUND_MESSAGES, scopeOfProject, type ProjectScope } from '@/server/tenancy/scope';

/**
 * Who may drive a session, and the scoped project reads of the sessions lot.
 *
 * Every lookup puts the space of ctx in its WHERE clause (`scopeOf*()`): an id of another space
 * answers exactly like an unknown id (same AppError NOT_FOUND, same French copy), before any
 * runner call or write.
 */

/** « Projet introuvable. » — the copy of the sessions lot (kept byte for byte). */
export const PROJECT_NOT_FOUND = 'Projet introuvable.';

export type ProjectRow = typeof projects.$inferSelect;

/**
 * May this account drive (instruct, interrupt, stop, resume, archive, rename, answer a permission
 * of) a session of `session.spaceId`? v1: every member of the space — a personal space has one
 * member. Shared spaces will narrow it here (creator or space owner), in one place.
 */
export function canDriveSession(ctx: Pick<RequestContext, 'space'>, session: { spaceId: string }): boolean {
  if (session.spaceId !== ctx.space.id) return false;
  return ctx.space.role === 'owner' || ctx.space.role === 'member';
}

/**
 * {@link canDriveSession} or an AppError: NOT_FOUND (the unknown-id copy) for a session of another
 * space, FORBIDDEN for a member who may not drive it (not reachable in v1).
 */
export function assertCanDriveSession(ctx: Pick<RequestContext, 'space'>, session: { spaceId: string }): void {
  if (session.spaceId !== ctx.space.id) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGES.session);
  if (!canDriveSession(ctx, session)) {
    throw new AppError('FORBIDDEN', 'Seuls les membres de cet espace peuvent piloter cette session.', { untouched: "Rien n'a été envoyé au CLI." });
  }
}

/**
 * Project of the space (scope + row), refused like an unknown project when archived. One indexed
 * query for the scope, one for the row (the space is checked in both).
 */
export async function readScopedProject(
  ctx: Pick<RequestContext, 'space'>,
  projectId: string,
  notFound: string = PROJECT_NOT_FOUND,
): Promise<{ scope: ProjectScope; project: ProjectRow }> {
  const scope = await scopeOfProject(ctx, projectId, { notFound });
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.spaceId, ctx.space.id)))
    .limit(1);
  if (!project || project.archivedAt) throw new AppError('NOT_FOUND', notFound);
  return { scope, project };
}
