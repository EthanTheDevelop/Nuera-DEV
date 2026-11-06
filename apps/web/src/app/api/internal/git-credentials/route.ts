import { projects } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getGitAuthForProject } from '@/server/github';
import { internalRoute } from '@/server/http';
import { audit } from '@/server/security/audit';
import { requireCallerProject } from '@/server/tenancy/runner-scope';

/**
 * POST /api/internal/git-credentials — runner → web (Bearer token of its server).
 * Short-lived git credential for ONE project of the CALLER'S server and ONE kind of access,
 * injected by the runner into a single git process through GIT_CONFIG_COUNT
 * (`http.https://github.com/.extraheader`). A project of another server answers like an unknown
 * one (404) and is journalled (`security.runner_scope_violation`). The credential comes from the
 * project's own GitHub source only (bound lazily when still null), or GITHUB_FALLBACK_TOKEN for the
 * space of the default server without source — never from another space.
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
  handler: async ({ body, environment }) => {
    const project = await requireCallerProject(environment, body.projectId, {
      route: 'git-credentials',
      notFound: 'Projet introuvable.',
    });
    if (project.archivedAt && body.access === 'write') throw new AppError('CONFLICT', 'Ce projet est archivé.');
    const [binding] = await db.select({ githubSourceId: projects.githubSourceId }).from(projects).where(eq(projects.id, project.id)).limit(1);
    const credential = await getGitAuthForProject(
      { id: project.id, spaceId: project.spaceId, environmentId: project.environmentId, githubSourceId: binding?.githubSourceId ?? null, githubFullName: project.githubFullName },
      body.access,
    );
    if (body.access === 'write') {
      await audit({
        action: 'integration.github.write_token_issued',
        summary: `jeton d'écriture GitHub délivré au runner pour ${project.githubFullName}`,
        targetType: 'project',
        targetId: project.id,
        actorKind: 'runner',
        spaceId: project.spaceId,
        environmentId: environment.id,
        ip: null,
        userAgent: null,
        metadata: { expiresAt: credential.expiresAt, sourceId: credential.sourceId },
      });
    }
    return Response.json({ extraHeader: credential.extraHeader, expiresAt: credential.expiresAt }, { headers: { 'cache-control': 'no-store' } });
  },
});
