import { apiRoute } from '@/server/http';
import { createProject, createProjectInputSchema, listProjects, listProjectsQuerySchema, withProjectErrors } from '@/server/projects';

/**
 * GET /api/projects?q=&filtre=tous|favoris|archives&tri=activite|nom|ajout — D02 / M02 list of the
 * space (items, chip counters, disk of the projects root of its server).
 * POST /api/projects — D03 « Cloner sur {serveur} »: { fullName, sourceId?, branch?, name,
 * destination, installDeps, worktreePerSession, readClaudeMd, commands? } → 201 { projectId,
 * operationId }; the progress is read on /api/stream/operations/<operationId>. A non-empty
 * destination answers 409 with `reason: DESTINATION_NOT_EMPTY` and the A4 data (fileCount,
 * suggestedPath, existingProject); a repository already tracked in the space 409 ALREADY_TRACKED;
 * no server assigned 409 NO_ENVIRONMENT.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  query: listProjectsQuerySchema,
  handler: ({ query, ctx }) => listProjects(ctx, { q: query.q, filter: query.filtre, sort: query.tri }),
});

export const POST = apiRoute({
  body: createProjectInputSchema,
  maxBodyBytes: 16 * 1024,
  rateLimit: { limit: 20, windowMs: 10 * 60_000 },
  handler: ({ body, ctx }) =>
    withProjectErrors(async () => Response.json(await createProject(ctx, body), { status: 201, headers: { 'cache-control': 'no-store' } })),
});
