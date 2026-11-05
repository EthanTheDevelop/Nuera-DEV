import 'server-only';
import { projects, sessions } from '@nuera/db/schema';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { audit } from '@/server/security/audit';
import { LIVE_STATUSES, loadListItem, requireProjectRow } from './queries';
import type { ArchivePreviewView, ProjectListItem } from './types';

type Actor = { id: string };

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
 * Favourite, display name, commands and options of a project. The favourite star is a plain
 * preference (not audited); name, commands (run through a shell by the runner) and options are.
 */
export async function updateProject(projectId: string, input: PatchProjectInput, actor: Actor): Promise<ProjectListItem> {
  const parsed = patchProjectInputSchema.parse(input);
  const project = await requireProjectRow(projectId);
  if (project.archivedAt && (parsed.commands || parsed.options || parsed.name)) {
    throw new AppError('CONFLICT', 'Ce projet est archivé : restaurez-le pour le modifier.');
  }
  const set: Partial<typeof projects.$inferInsert> = {};
  if (parsed.favorite !== undefined) set.isFavorite = parsed.favorite;
  if (parsed.name !== undefined) set.name = parsed.name;
  if (parsed.commands) set.commands = { ...project.commands, ...parsed.commands };
  if (parsed.options) set.options = { ...project.options, ...parsed.options };
  const [row] = await db.update(projects).set(set).where(eq(projects.id, projectId)).returning();

  if (parsed.name !== undefined && parsed.name !== project.name) {
    await audit({
      action: 'project.renamed',
      summary: `projet « ${project.name} » renommé en « ${parsed.name} »`,
      targetType: 'project',
      targetId: project.id,
      actorUserId: actor.id,
    });
  }
  if (parsed.commands) {
    const changed = Object.entries(parsed.commands)
      .filter(([key, value]) => (project.commands as Record<string, unknown>)[key] !== value)
      .map(([key]) => COMMAND_LABELS[key] ?? key);
    if (changed.length) {
      await audit({
        action: 'project.commands_updated',
        summary: `commandes de ${project.name} modifiées : ${changed.join(', ')}`,
        targetType: 'project',
        targetId: project.id,
        metadata: { commands: parsed.commands },
        actorUserId: actor.id,
      });
    }
  }
  if (parsed.options) {
    await audit({
      action: 'project.options_updated',
      summary: `options de ${project.name} modifiées`,
      targetType: 'project',
      targetId: project.id,
      metadata: { options: parsed.options },
      actorUserId: actor.id,
    });
  }
  return loadListItem(row!);
}

/** Records the owner opening the project page (D01 « Projets récents », D02 activity). */
export async function markProjectOpened(projectId: string): Promise<void> {
  await db.update(projects).set({ lastOpenedAt: new Date() }).where(eq(projects.id, projectId)).catch(() => undefined);
}

export type ArchivePreview = ArchivePreviewView;

export async function getArchivePreview(projectId: string): Promise<ArchivePreview> {
  await requireProjectRow(projectId);
  const [row] = await db
    .select({
      live: sql<number>`count(*) filter (where ${sessions.status} in ('running','waiting_permission','waiting_input'))::int`,
      ended: sql<number>`count(*) filter (where ${sessions.status} not in ('running','waiting_permission','waiting_input'))::int`,
    })
    .from(sessions)
    .where(and(eq(sessions.projectId, projectId), ne(sessions.status, 'archived'), isNull(sessions.archivedAt)));
  return { endedSessions: Number(row?.ended ?? 0), liveSessions: Number(row?.live ?? 0) };
}

/**
 * Archives a project (T8 « Archiver … ? »): it leaves the list (« Archivés » keeps it), its ended
 * sessions are archived with it, the GitHub repository and the clone on VPS-3 are never touched.
 * Refused while a Claude session is live on it (CONFLICT, the dialog says why).
 */
export async function archiveProject(projectId: string, actor: Actor): Promise<{ archivedSessions: number }> {
  const project = await requireProjectRow(projectId);
  if (project.archivedAt) return { archivedSessions: 0 };
  if (project.status === 'cloning') throw new AppError('CONFLICT', 'Le clonage est en cours : attendez la fin pour archiver le projet.');
  const preview = await getArchivePreview(projectId);
  if (preview.liveSessions > 0) {
    throw new AppError('CONFLICT', `${preview.liveSessions === 1 ? 'Une session Claude est active' : `${preview.liveSessions} sessions Claude sont actives`} sur ce projet : arrêtez-les avant de l'archiver.`, {
      untouched: "Le projet n'a pas été archivé.",
    });
  }
  const now = new Date();
  const archived = await db.transaction(async (tx) => {
    await tx.update(projects).set({ archivedAt: now }).where(eq(projects.id, projectId));
    const rows = await tx
      .update(sessions)
      .set({ status: 'archived', archivedAt: now })
      .where(and(eq(sessions.projectId, projectId), isNull(sessions.archivedAt), ne(sessions.status, 'archived'), sql`${sessions.status} not in ('running','waiting_permission','waiting_input')`))
      .returning({ id: sessions.id });
    return rows.length;
  });
  await audit({
    action: 'project.archived',
    summary: `projet ${project.name} archivé${archived ? ` avec ${archived} session${archived > 1 ? 's' : ''}` : ''} (dépôt GitHub et clone conservés)`,
    targetType: 'project',
    targetId: project.id,
    metadata: { fullName: project.githubFullName, archivedSessions: archived },
    actorUserId: actor.id,
  });
  return { archivedSessions: archived };
}

/** « Restaurer » from the « Archivés » chip (or A4 « Ouvrir le projet existant »). */
export async function restoreProject(projectId: string, actor: Actor): Promise<ProjectListItem> {
  const project = await requireProjectRow(projectId);
  if (!project.archivedAt) return loadListItem(project);
  const [active] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.githubFullName, project.githubFullName), isNull(projects.archivedAt)))
    .limit(1);
  if (active) {
    throw new AppError('CONFLICT', `${project.githubFullName} est déjà suivi par le projet « ${active.name} ».`, {
      untouched: "Le projet archivé n'a pas été modifié.",
    });
  }
  const [row] = await db.update(projects).set({ archivedAt: null }).where(eq(projects.id, projectId)).returning();
  await audit({
    action: 'project.restored',
    summary: `projet ${project.name} restauré depuis les archives`,
    targetType: 'project',
    targetId: project.id,
    actorUserId: actor.id,
  });
  return loadListItem(row!);
}

/**
 * Removes the row of a project whose clone FAILED (status `error`, nothing left on disk: the runner
 * cleans up a failed clone). A ready project is archived instead, never deleted.
 */
export async function discardFailedProject(projectId: string, actor: Actor): Promise<void> {
  const project = await requireProjectRow(projectId);
  if (project.status !== 'error') throw new AppError('CONFLICT', 'Seul un projet dont le clonage a échoué peut être retiré ainsi : archivez-le.');
  const [live] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.projectId, projectId), inArray(sessions.status, [...LIVE_STATUSES])))
    .limit(1);
  if (live) throw new AppError('CONFLICT', 'Une session est active sur ce projet.');
  await db.delete(projects).where(eq(projects.id, projectId));
  await audit({
    action: 'project.discarded',
    summary: `projet ${project.name} retiré après un clonage en échec (${project.githubFullName})`,
    targetType: 'project',
    targetId: project.id,
    actorUserId: actor.id,
  });
}
