import 'server-only';
import { projects } from '@nuera/db/schema';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { auditIn } from '@/server/tenancy/scope';
import { gitIdentityOf, requireProject, type ProjectContext } from './access';
import { withSyncCopy } from './errors';
import type { ClaudeMdView } from './types';

export const writeClaudeMdInputSchema = z.object({
  content: z.string().max(512 * 1024, 'CLAUDE.md dépasse 512 Ko'),
  /** D04: « Chaque modification passe par un commit sur la branche courante » (on by default). */
  commit: z.boolean().default(true),
  message: z.string().trim().min(1).max(500).optional(),
});

export async function readProjectClaudeMd(ctx: ProjectContext, projectId: string): Promise<ClaudeMdView> {
  const { row, runner } = await requireProject(ctx, projectId, { state: 'ready' });
  const md = await runner.readClaudeMd({ params: { projectId: row.id } });
  return {
    worktreeId: md.worktreeId,
    exists: md.exists,
    content: md.content,
    lines: md.lines,
    modifiedAt: md.modifiedAt,
    lastCommit: md.lastCommit,
  };
}

/**
 * Writes CLAUDE.md at the root of the primary clone through the project's runner and, by default,
 * commits it on the current branch with the acting account's Git identity (Paramètres › Identité
 * Git, else its name and e-mail; the runner commits only that file). Audited.
 */
export async function writeProjectClaudeMd(ctx: ProjectContext, projectId: string, input: z.input<typeof writeClaudeMdInputSchema>) {
  const handle = await requireProject(ctx, projectId, { state: 'ready' });
  const project = handle.row;
  const parsed = writeClaudeMdInputSchema.parse(input);
  const message = parsed.message ?? 'docs: mise à jour de CLAUDE.md';
  const author = parsed.commit ? await gitIdentityOf(ctx) : null;
  if (parsed.commit && !author) {
    throw new AppError('VALIDATION', "Aucune identité Git valide pour signer ce commit : renseignez-la dans Paramètres.", {
      untouched: "CLAUDE.md n'a pas été modifié.",
    });
  }
  const result = await handle.runner
    .writeClaudeMd({
      params: { projectId: project.id },
      body: {
        content: parsed.content,
        ...(parsed.commit && author ? { commit: { message, author } } : {}),
        actorUserId: ctx.user.id,
      },
    })
    .catch(withSyncCopy);
  await db
    .update(projects)
    .set({ claudeMdUpdatedAt: new Date(), ...(result.commitSha ? { claudeMdCommitSha: result.commitSha } : {}) })
    .where(and(eq(projects.id, project.id), eq(projects.spaceId, ctx.space.id)));
  await auditIn(ctx, {
    action: 'project.claude_md_written',
    summary: `CLAUDE.md de ${project.name} modifié (${result.lines} lignes)${result.commitSha ? `, commit ${result.commitSha.slice(0, 7)} sur ${project.currentBranch ?? project.defaultBranch}` : ', sans commit'}`,
    targetType: 'project',
    targetId: project.id,
    environmentId: handle.environment.id,
    metadata: { lines: result.lines, commitSha: result.commitSha, branch: project.currentBranch },
  });
  return result;
}
