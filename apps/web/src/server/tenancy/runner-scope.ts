import 'server-only';
import { projects, sessions, spaceMembers, user } from '@nuera/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { audit } from '@/server/security/audit';
import type { CallerEnvironment } from '@/server/security/runner-token';

/**
 * Ownership checks of the runner → web callbacks (/api/internal/*): a runner only ever obtains
 * something about the resources of ITS server. A resource of another server answers exactly like
 * an unknown one (404, same message) and leaves a `security.runner_scope_violation` entry in the
 * instance journal (actor: the runner, with its server).
 */

export const RUNNER_SCOPE_VIOLATION = 'security.runner_scope_violation';

/** Journals a refused access of `caller` to a resource of another server (never throws). */
export async function reportRunnerScopeViolation(
  caller: CallerEnvironment,
  input: { route: string; resourceType: 'project' | 'session'; resourceId: string },
): Promise<void> {
  await audit({
    action: RUNNER_SCOPE_VIOLATION,
    summary: `runner « ${caller.name} » : accès refusé à un élément d'un autre serveur`,
    targetType: input.resourceType,
    targetId: input.resourceId,
    actorKind: 'runner',
    actorUserId: null,
    environmentId: caller.id,
    spaceId: caller.spaceId,
    ip: null,
    userAgent: null,
    metadata: { route: input.route, resourceType: input.resourceType },
  });
}

export interface CallerProject {
  id: string;
  name: string;
  githubFullName: string;
  archivedAt: Date | null;
  spaceId: string;
  environmentId: string;
}

/**
 * Project `projectId` of the caller's server, or AppError NOT_FOUND `notFound` (unknown or of
 * another server: identical answer; the latter is journalled).
 */
export async function requireCallerProject(
  caller: CallerEnvironment,
  projectId: string,
  options: { route: string; notFound: string },
): Promise<CallerProject> {
  const [row] = await db
    .select({
      id: projects.id,
      name: projects.name,
      githubFullName: projects.githubFullName,
      archivedAt: projects.archivedAt,
      spaceId: projects.spaceId,
      environmentId: projects.environmentId,
    })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', options.notFound);
  if (row.environmentId !== caller.id) {
    await reportRunnerScopeViolation(caller, { route: options.route, resourceType: 'project', resourceId: projectId });
    throw new AppError('NOT_FOUND', options.notFound);
  }
  return row;
}

export interface CallerSession {
  id: string;
  projectId: string;
  environmentId: string;
}

/** Session `sessionId` of the caller's server (same rules as {@link requireCallerProject}). */
export async function requireCallerSession(
  caller: CallerEnvironment,
  sessionId: string,
  options: { route: string; notFound: string },
): Promise<CallerSession> {
  const row = await findSession(sessionId);
  if (!row) throw new AppError('NOT_FOUND', options.notFound);
  if (row.environmentId !== caller.id) {
    await reportRunnerScopeViolation(caller, { route: options.route, resourceType: 'session', resourceId: sessionId });
    throw new AppError('NOT_FOUND', options.notFound);
  }
  return row;
}

async function findSession(sessionId: string): Promise<CallerSession | null> {
  const [row] = await db
    .select({ id: sessions.id, projectId: sessions.projectId, environmentId: sessions.environmentId })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

/**
 * References of a runner notification checked against the caller's server: an unknown id is
 * tolerated (the session may be gone: the notification simply loses its link), an id of another
 * server is refused (404) and journalled.
 */
export async function assertCallerReferences(
  caller: CallerEnvironment,
  refs: { sessionId?: string | null; projectId?: string | null },
  route: string,
): Promise<void> {
  if (refs.sessionId) {
    const session = await findSession(refs.sessionId);
    if (session && session.environmentId !== caller.id) {
      await reportRunnerScopeViolation(caller, { route, resourceType: 'session', resourceId: refs.sessionId });
      throw new AppError('NOT_FOUND', 'Session introuvable.');
    }
  }
  if (refs.projectId) {
    const [project] = await db
      .select({ environmentId: projects.environmentId })
      .from(projects)
      .where(eq(projects.id, refs.projectId))
      .limit(1);
    if (project && project.environmentId !== caller.id) {
      await reportRunnerScopeViolation(caller, { route, resourceType: 'project', resourceId: refs.projectId });
      throw new AppError('NOT_FOUND', 'Projet introuvable.');
    }
  }
}

/**
 * Space an event of the caller's server is about (lot P1, shared servers): the space of its session
 * or project (on the caller's server, already checked by {@link assertCallerReferences}); without
 * either, the server's first account (null while it is not assigned). Never another account of a
 * shared server than the one the resource belongs to.
 */
export async function eventSpaceOfCaller(
  caller: Pick<CallerEnvironment, 'id' | 'spaceId'>,
  refs: { sessionId?: string | null; projectId?: string | null },
): Promise<string | null> {
  const projectId = refs.sessionId ? ((await findSession(refs.sessionId))?.projectId ?? refs.projectId ?? null) : (refs.projectId ?? null);
  if (projectId) {
    const [project] = await db
      .select({ spaceId: projects.spaceId })
      .from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.environmentId, caller.id)))
      .limit(1);
    if (project) return project.spaceId;
  }
  return caller.spaceId;
}

/**
 * Who receives an event of the caller's server: the active members of its space; the active
 * administrators (owner included) when the server is not assigned to a space yet.
 */
export async function recipientsOfCaller(caller: Pick<CallerEnvironment, 'spaceId'>): Promise<string[]> {
  const active = and(isNull(user.disabledAt), isNull(user.deletedAt));
  const rows = caller.spaceId
    ? await db
        .select({ id: user.id })
        .from(spaceMembers)
        .innerJoin(user, eq(user.id, spaceMembers.userId))
        .where(and(eq(spaceMembers.spaceId, caller.spaceId), active))
    : await db
        .select({ id: user.id })
        .from(user)
        .where(and(inArray(user.role, ['owner', 'admin']), active));
  return rows.map((row) => row.id).sort();
}
