import { z } from 'zod';
import { AppError, toErrorBody } from '@/server/errors';
import { disconnectGithubSource, getGithubSourceView, renameGithubSource } from '@/server/github';
import { apiRoute } from '@/server/http';

/**
 * GET    /api/integrations/github/sources/[sourceId] — one GitHub source of the space (D07 tile).
 * PATCH  /api/integrations/github/sources/[sourceId] — `{ label }` (1 to 40 characters), audited.
 * DELETE /api/integrations/github/sources/[sourceId] — « Déconnecter » this source (audited). 409
 *        while a non-archived project of the space uses it (`error.projects`: their id and name).
 * A source of another space answers exactly like an unknown one (404 « Source GitHub introuvable. »).
 */

export const dynamic = 'force-dynamic';

const params = z.object({ sourceId: z.string().min(1).max(64) });

export const GET = apiRoute({
  params,
  handler: async ({ params: { sourceId }, ctx }) => getGithubSourceView({ spaceId: ctx.space.id, sourceId }),
});

export const PATCH = apiRoute({
  params,
  body: z.object({ label: z.string().trim().min(1, 'nom requis').max(40, '40 caractères au maximum') }),
  handler: async ({ params: { sourceId }, body, ctx, user }) =>
    renameGithubSource({ spaceId: ctx.space.id, sourceId, label: body.label, actorUserId: user.id }),
});

export const DELETE = apiRoute({
  params,
  handler: async ({ params: { sourceId }, ctx, user }) => {
    try {
      return await disconnectGithubSource({ spaceId: ctx.space.id, sourceId, actorUserId: user.id });
    } catch (error) {
      const projects = error instanceof AppError && error.code === 'CONFLICT' ? error.data?.projects : undefined;
      if (!projects) throw error;
      // The projects that still use the source (all of this space) go with the refusal.
      const body = toErrorBody(error);
      return Response.json({ error: { ...body.error, projects } }, { status: 409, headers: { 'cache-control': 'no-store' } });
    }
  },
});
