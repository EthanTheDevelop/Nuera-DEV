import { projects } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getGitAuthForRepo } from '@/server/github';
import { internalRoute } from '@/server/http';
import { audit } from '@/server/security/audit';

/**
 * POST /api/internal/git-credentials — runner → web (Bearer RUNNER_TOKEN).
 * Short-lived git credential for ONE project and ONE kind of access, injected by the runner into a
 * single git process through GIT_CONFIG_COUNT (`http.https://github.com/.extraheader`).
 *
 *   { projectId, access: 'read' | 'write' } → { extraHeader: 'AUTHORIZATION: basic …', expiresAt }
 */

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  projectId: z.uuid(),
  access: z.enum(['read', 'write']),
});

export const POST = internalRoute({
  body: bodySchema,
  handler: async ({ body }) => {
    const [project] = await db
      .select({ id: projects.id, name: projects.name, githubFullName: projects.githubFullName, archivedAt: projects.archivedAt })
      .from(projects)
      .where(eq(projects.id, body.projectId))
      .limit(1);
    if (!project) throw new AppError('NOT_FOUND', 'Projet introuvable.');
    if (project.archivedAt && body.access === 'write') throw new AppError('CONFLICT', 'Ce projet est archivé.');
    const credential = await getGitAuthForRepo(project.githubFullName, body.access);
    if (body.access === 'write') {
      await audit({
        action: 'integration.github.write_token_issued',
        summary: `jeton d'écriture GitHub délivré au runner pour ${project.githubFullName}`,
        targetType: 'project',
        targetId: project.id,
        actorKind: 'runner',
        ip: null,
        userAgent: null,
        metadata: { expiresAt: credential.expiresAt },
      });
    }
    return Response.json(credential, { headers: { 'cache-control': 'no-store' } });
  },
});
