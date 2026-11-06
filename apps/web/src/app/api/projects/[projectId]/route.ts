import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { archiveProject, archiveProjectInputSchema, getProjectDetail, patchProjectInputSchema, updateProject, withProjectErrors } from '@/server/projects';

/**
 * GET /api/projects/[projectId] — everything D04 / M04 shows (runner parts degrade on their own).
 * PATCH — { favorite?, name?, commands?, options? } (audited except the favourite star).
 * DELETE — { removeClone? } archives the project (T8 « Archiver … ? »): ended sessions archived with
 * it, GitHub repository untouched; 409 while a Claude session is live on it. With `removeClone`, the
 * clone and its worktrees are then deleted from its server (refused, and reported in `clone`, when
 * work exists only there).
 * A project of another space answers exactly like an unknown one (404, same message).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const params = z.object({ projectId: z.uuid() });

export const GET = apiRoute({
  params,
  handler: ({ params: { projectId }, ctx }) => withProjectErrors(() => getProjectDetail(ctx, projectId)),
});

export const PATCH = apiRoute({
  params,
  body: patchProjectInputSchema,
  maxBodyBytes: 16 * 1024,
  handler: ({ params: { projectId }, body, ctx }) => withProjectErrors(() => updateProject(ctx, projectId, body)),
});

export const DELETE = apiRoute({
  params,
  body: archiveProjectInputSchema,
  maxBodyBytes: 1024,
  handler: ({ params: { projectId }, body, ctx }) => withProjectErrors(() => archiveProject(ctx, projectId, { removeClone: body?.removeClone ?? false })),
});
