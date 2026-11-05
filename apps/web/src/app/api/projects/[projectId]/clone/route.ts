import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { discardFailedProject, retryCloneInputSchema, retryProjectClone, withProjectErrors } from '@/server/projects';

/**
 * POST /api/projects/[projectId]/clone — { destination? }: retries a FAILED clone (A4 « Réessayer »,
 * optionally into another folder) → 201 { projectId, operationId }.
 * DELETE — removes the row of a project whose clone failed (nothing is left on VPS-3).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const params = z.object({ projectId: z.uuid() });

export const POST = apiRoute({
  params,
  body: retryCloneInputSchema,
  rateLimit: { limit: 20, windowMs: 10 * 60_000 },
  handler: ({ params: { projectId }, body, user }) =>
    withProjectErrors(async () =>
      Response.json(await retryProjectClone(projectId, body, user), { status: 201, headers: { 'cache-control': 'no-store' } }),
    ),
});

export const DELETE = apiRoute({
  params,
  handler: ({ params: { projectId }, user }) =>
    withProjectErrors(async () => {
      await discardFailedProject(projectId, user);
      return undefined;
    }),
});
