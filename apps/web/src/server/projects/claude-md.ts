import 'server-only';
import { projects } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { runner } from '@/server/runner/client';
import { audit } from '@/server/security/audit';
import { withSyncCopy } from './errors';
import { requireReadyProject } from './queries';
import type { ClaudeMdView } from './types';

type Actor = { id: string; name: string; email: string };

export const writeClaudeMdInputSchema = z.object({
  content: z.string().max(512 * 1024, 'CLAUDE.md dépasse 512 Ko'),
  /** D04: « Chaque modification passe par un commit sur la branche courante » (on by default). */
  commit: z.boolean().default(true),
  message: z.string().trim().min(1).max(500).optional(),
});

export async function readProjectClaudeMd(projectId: string): Promise<ClaudeMdView> {
  await requireReadyProject(projectId);
  const md = await runner.readClaudeMd({ params: { projectId } });
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
 * Writes CLAUDE.md at the root of the primary clone through the runner and, by default, commits it
 * on the current branch with the owner as author (the runner commits only that file). Audited.
 */
export async function writeProjectClaudeMd(projectId: string, input: z.input<typeof writeClaudeMdInputSchema>, actor: Actor) {
  const project = await requireReadyProject(projectId);
  const parsed = writeClaudeMdInputSchema.parse(input);
  const message = parsed.message ?? 'docs: mise à jour de CLAUDE.md';
  const result = await runner
    .writeClaudeMd({
      params: { projectId },
      body: {
        content: parsed.content,
        ...(parsed.commit ? { commit: { message, author: { name: actor.name, email: actor.email } } } : {}),
        actorUserId: actor.id,
      },
    })
    .catch(withSyncCopy);
  await db
    .update(projects)
    .set({ claudeMdUpdatedAt: new Date(), ...(result.commitSha ? { claudeMdCommitSha: result.commitSha } : {}) })
    .where(eq(projects.id, project.id));
  await audit({
    action: 'project.claude_md_written',
    summary: `CLAUDE.md de ${project.name} modifié (${result.lines} lignes)${result.commitSha ? `, commit ${result.commitSha.slice(0, 7)} sur ${project.currentBranch ?? project.defaultBranch}` : ', sans commit'}`,
    targetType: 'project',
    targetId: project.id,
    metadata: { lines: result.lines, commitSha: result.commitSha, branch: project.currentBranch },
    actorUserId: actor.id,
  });
  return result;
}
