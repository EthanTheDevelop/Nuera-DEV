import 'server-only';
import { projects, sessions } from '@nuera/db/schema';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { isRunnerUnavailable, RunnerError } from '@/server/runner/client';
import { auditIn, ofSpace } from '@/server/tenancy/scope';
import { requireProject, type ProjectContext, type ProjectHandle } from './access';
import { LIVE_STATUSES, loadListItem } from './queries';
import type { ArchivePreviewView, ArchiveResultView, ProjectListItem } from './types';

/** Row of a project of the space (the id comes out of `requireProject`). */
const inSpace = (ctx: ProjectContext, projectId: string) => ofSpace(ctx, eq(projects.id, projectId));

const commandSchema = z
  .string()
  .trim()
  .max(1000, '1 000 caractères au maximum')
  .transform((value) => (value === '' ? null : value))
  .nullable();

export const projectCommandsInputSchema = z
  .object({ install: commandSchema, dev: commandSchema, build: commandSchema, test: commandSchema, lint: commandSchema })
  .partial();

export const projectOptionsInputSchema = z
  .object({ installDeps: z.boolean(), worktreePerSession: z.boolean(), readClaudeMd: z.boolean() })
  .partial();

/** PATCH /api/projects/[projectId] */
export const patchProjectInputSchema = z
  .object({
    favorite: z.boolean().optional(),
    name: z.string().trim().min(1, 'nom requis').max(120, '120 caractères au maximum').optional(),
    commands: projectCommandsInputSchema.optional(),
    options: projectOptionsInputSchema.optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), { message: 'aucune modification' });
export type PatchProjectInput = z.input<typeof patchProjectInputSchema>;

const COMMAND_LABELS: Record<string, string> = { install: 'installation', dev: 'lancement', build: 'build', test: 'tests', lint: 'lint' };

/**
 * Favourite, display name, commands and options of a project of the space. The favourite star is a
 * plain preference (not audited); name, commands (run through a shell by the runner) and options are.
 */
export async function updateProject(ctx: ProjectContext, projectId: string, input: PatchProjectInput): Promise<ProjectListItem> {
  const parsed = patchProjectInputSchema.parse(input);
  const handle = await requireProject(ctx, projectId);
  const project = handle.row;
  const environmentId = handle.environment.id;
  if (project.archivedAt && (parsed.commands || parsed.options || parsed.name)) {
    throw new AppError('CONFLICT', 'Ce projet est archivé : restaurez-le pour le modifier.');
  }
  const set: Partial<typeof projects.$inferInsert> = {};
  if (parsed.favorite !== undefined) set.isFavorite = parsed.favorite;
  if (parsed.name !== undefined) set.name = parsed.name;
  if (parsed.commands) set.commands = { ...project.commands, ...parsed.commands };
  if (parsed.options) set.options = { ...project.options, ...parsed.options };
  const [row] = await db.update(projects).set(set).where(inSpace(ctx, project.id)).returning();

  if (parsed.name !== undefined && parsed.name !== project.name) {
    await auditIn(ctx, {
      environmentId,
      action: 'project.renamed',
      summary: `projet « ${project.name} » renommé en « ${parsed.name} »`,
      targetType: 'project',
      targetId: project.id,
    });
  }
  if (parsed.commands) {
    const changed = Object.entries(parsed.commands)
      .filter(([key, value]) => (project.commands as Record<string, unknown>)[key] !== value)
      .map(([key]) => COMMAND_LABELS[key] ?? key);
    if (changed.length) {
      await auditIn(ctx, {
        environmentId,
        action: 'project.commands_updated',
        summary: `commandes de ${project.name} modifiées : ${changed.join(', ')}`,
        targetType: 'project',
        targetId: project.id,
        metadata: { commands: parsed.commands },
      });
    }
  }
  if (parsed.options) {
    await auditIn(ctx, {
      environmentId,
      action: 'project.options_updated',
      summary: `options de ${project.name} modifiées`,
      targetType: 'project',
      targetId: project.id,
      metadata: { options: parsed.options },
    });
  }
  return loadListItem(row!);
}

/**
 * Records the account opening the page of a project of its space (D01 « Projets récents », D02
 * activity). Never touches a project of another space (the update itself is scoped).
 */
export async function markProjectOpened(ctx: ProjectContext, projectId: string): Promise<void> {
  await db
    .update(projects)
    .set({ lastOpenedAt: new Date() })
    .where(inSpace(ctx, projectId))
    .catch(() => undefined);
}

export type ArchivePreview = ArchivePreviewView;

export async function getArchivePreview(ctx: ProjectContext, projectId: string): Promise<ArchivePreview> {
  return archivePreviewOf(await requireProject(ctx, projectId));
}

async function archivePreviewOf(handle: ProjectHandle): Promise<ArchivePreview> {
  const projectId = handle.row.id;
  const [row] = await db
    .select({
      live: sql<number>`count(*) filter (where ${sessions.status} in ('running','waiting_permission','waiting_input'))::int`,
      ended: sql<number>`count(*) filter (where ${sessions.status} not in ('running','waiting_permission','waiting_input'))::int`,
    })
    .from(sessions)
    .where(and(eq(sessions.projectId, projectId), ne(sessions.status, 'archived'), isNull(sessions.archivedAt)));
  return { endedSessions: Number(row?.ended ?? 0), liveSessions: Number(row?.live ?? 0), clone: await readCloneFootprint(handle) };
}

/** Folders of the project on its server (primary clone + worktrees) and their measured size. */
async function readCloneFootprint(handle: ProjectHandle): Promise<ArchivePreviewView['clone']> {
  try {
    const { worktrees } = await handle.runner.listWorktrees({ params: { projectId: handle.row.id }, query: { sizes: true } }, { timeoutMs: 20_000 });
    const present = worktrees.filter((worktree) => worktree.status === 'active');
    if (present.length === 0) return { onDisk: false, sizeBytes: null };
    let total = 0;
    for (const worktree of present) {
      if (worktree.sizeBytes === null || worktree.sizeBytes === undefined) return { onDisk: true, sizeBytes: null };
      total += worktree.sizeBytes;
    }
    return { onDisk: true, sizeBytes: total };
  } catch (error) {
    // Runner down, or the folder already gone (NOT_FOUND / WORKTREE_MISSING): nothing to offer.
    if (isRunnerUnavailable(error)) return { onDisk: null, sizeBytes: null };
    return { onDisk: false, sizeBytes: null };
  }
}

export const archiveProjectInputSchema = z
  .object({
    /** T8 option « Supprimer aussi le clone de {serveur} »: the runner refuses if work exists only there. */
    removeClone: z.boolean().default(false),
  })
  .optional();

/**
 * Archives a project of the space (T8 « Archiver … ? »): it leaves the list (« Archivés » keeps it),
 * its ended sessions are archived with it, the GitHub repository and the clone on its server are
 * never touched. Refused while a Claude session is live on it (CONFLICT, the dialog says why).
 */
export async function archiveProject(ctx: ProjectContext, projectId: string, options: { removeClone?: boolean } = {}): Promise<ArchiveResultView> {
  const handle = await requireProject(ctx, projectId);
  const project = handle.row;
  if (project.archivedAt) return { archivedSessions: 0, clone: options.removeClone ? await removeProjectClone(ctx, handle) : null };
  if (project.status === 'cloning') throw new AppError('CONFLICT', 'Le clonage est en cours : attendez la fin pour archiver le projet.');
  const preview = await archivePreviewOf(handle);
  if (preview.liveSessions > 0) {
    throw new AppError('CONFLICT', `${preview.liveSessions === 1 ? 'Une session Claude est active' : `${preview.liveSessions} sessions Claude sont actives`} sur ce projet : arrêtez-les avant de l'archiver.`, {
      untouched: "Le projet n'a pas été archivé.",
    });
  }
  const now = new Date();
  const archived = await db.transaction(async (tx) => {
    await tx.update(projects).set({ archivedAt: now }).where(inSpace(ctx, project.id));
    const rows = await tx
      .update(sessions)
      .set({ status: 'archived', archivedAt: now })
      .where(and(eq(sessions.projectId, project.id), isNull(sessions.archivedAt), ne(sessions.status, 'archived'), sql`${sessions.status} not in ('running','waiting_permission','waiting_input')`))
      .returning({ id: sessions.id });
    return rows.length;
  });
  await auditIn(ctx, {
    environmentId: handle.environment.id,
    action: 'project.archived',
    summary: `projet ${project.name} archivé${archived ? ` avec ${archived} session${archived > 1 ? 's' : ''}` : ''} (dépôt GitHub et clone conservés)`,
    targetType: 'project',
    targetId: project.id,
    metadata: { fullName: project.githubFullName, archivedSessions: archived },
  });
  return { archivedSessions: archived, clone: options.removeClone ? await removeProjectClone(ctx, handle) : null };
}

/**
 * Deletes the clone and the worktrees of an archived project from its server (runner `removeClone`:
 * confined, refused while something runs or when work exists only there). Audited either way.
 */
async function removeProjectClone(ctx: ProjectContext, handle: ProjectHandle): Promise<NonNullable<ArchiveResultView['clone']>> {
  const project = handle.row;
  const environmentId = handle.environment.id;
  try {
    const result = await handle.runner.removeClone({ params: { projectId: project.id } });
    await auditIn(ctx, {
      environmentId,
      action: 'project.clone_removed',
      summary: `clone de ${project.name} supprimé du serveur (${result.worktrees} worktree${result.worktrees > 1 ? 's' : ''} avec lui)`,
      targetType: 'project',
      targetId: project.id,
      metadata: { fullName: project.githubFullName, operationId: result.operationId, freedBytes: result.freedBytes, worktrees: result.worktrees },
    });
    return { removed: true, freedBytes: result.freedBytes };
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    const message = isRunnerUnavailable(error) ? 'Le runner ne répond pas : le clone est conservé.' : (appError?.message ?? "Le clone n'a pas pu être supprimé.");
    await auditIn(ctx, {
      environmentId,
      action: 'project.clone_remove_refused',
      summary: `suppression du clone de ${project.name} refusée : ${message}`,
      targetType: 'project',
      targetId: project.id,
      metadata: { fullName: project.githubFullName, reason: error instanceof RunnerError ? (error.reason ?? error.code) : error instanceof AppError ? error.code : 'UNKNOWN' },
    });
    return { removed: false, message, untouched: appError?.untouched ?? "Rien n'a été supprimé du disque." };
  }
}

/** The repository is already tracked by another active project of the space on the same server. */
function alreadyFollowed(fullName: string, name: string): AppError {
  return new AppError('CONFLICT', `${fullName} est déjà suivi par le projet « ${name} ».`, {
    untouched: "Le projet archivé n'a pas été modifié.",
  });
}

async function activeTwin(ctx: ProjectContext, project: { id: string; environmentId: string; githubFullName: string }) {
  const [active] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      ofSpace(
        ctx,
        eq(projects.environmentId, project.environmentId),
        eq(projects.githubFullName, project.githubFullName),
        isNull(projects.archivedAt),
        ne(projects.id, project.id),
      ),
    )
    .limit(1);
  return active ?? null;
}

/**
 * « Restaurer » from the « Archivés » chip (or A4 « Ouvrir le projet existant »). Refused when the
 * repository is tracked again on the same server (one active project per repository and server).
 */
export async function restoreProject(ctx: ProjectContext, projectId: string): Promise<ProjectListItem> {
  const handle = await requireProject(ctx, projectId);
  const project = handle.row;
  if (!project.archivedAt) return loadListItem(project);
  const active = await activeTwin(ctx, project);
  if (active) throw alreadyFollowed(project.githubFullName, active.name);
  let row: typeof projects.$inferSelect | undefined;
  try {
    [row] = await db.update(projects).set({ archivedAt: null }).where(inSpace(ctx, project.id)).returning();
  } catch (error) {
    const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
    if (code === '23505') {
      // Lost a race with a creation or another restore of the same repository on that server.
      const twin = await activeTwin(ctx, project);
      throw alreadyFollowed(project.githubFullName, twin?.name ?? project.name);
    }
    throw error;
  }
  if (!row) throw new AppError('NOT_FOUND', 'Projet introuvable : il a peut-être été retiré.');
  await auditIn(ctx, {
    environmentId: handle.environment.id,
    action: 'project.restored',
    summary: `projet ${project.name} restauré depuis les archives`,
    targetType: 'project',
    targetId: project.id,
  });
  return loadListItem(row);
}

/**
 * Removes the row of a project whose clone FAILED (status `error`, nothing left on disk: the runner
 * cleans up a failed clone). A ready project is archived instead, never deleted.
 */
export async function discardFailedProject(ctx: ProjectContext, projectId: string): Promise<void> {
  const handle = await requireProject(ctx, projectId);
  const project = handle.row;
  if (project.status !== 'error') throw new AppError('CONFLICT', 'Seul un projet dont le clonage a échoué peut être retiré ainsi : archivez-le.');
  const [live] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.projectId, project.id), inArray(sessions.status, [...LIVE_STATUSES])))
    .limit(1);
  if (live) throw new AppError('CONFLICT', 'Une session est active sur ce projet.');
  await db.delete(projects).where(inSpace(ctx, project.id));
  await auditIn(ctx, {
    environmentId: handle.environment.id,
    action: 'project.discarded',
    summary: `projet ${project.name} retiré après un clonage en échec (${project.githubFullName})`,
    targetType: 'project',
    targetId: project.id,
  });
}
