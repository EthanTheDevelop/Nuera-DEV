import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { checkoutInputSchema, checkoutProjectBranch, withProjectErrors } from '@/server/projects';

/**
 * POST /api/projects/[projectId]/checkout — { branch }: switches the primary clone (D04 branch
 * selector). Refused while a session works in it (WORKTREE_IN_USE) or with uncommitted files
 * (WORKTREE_DIRTY). Audited.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: z.object({ projectId: z.uuid() }),
  body: checkoutInputSchema,
  rateLimit: { limit: 60, windowMs: 10 * 60_000 },
  handler: ({ params: { projectId }, body, ctx }) => withProjectErrors(() => checkoutProjectBranch(ctx, projectId, body)),
});
