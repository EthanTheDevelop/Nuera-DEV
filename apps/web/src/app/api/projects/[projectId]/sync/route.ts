import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { syncProject, withProjectErrors } from '@/server/projects';

/**
 * POST /api/projects/[projectId]/sync — « Synchroniser »: fetch + fast-forward pull of the primary
 * clone with a read token of the project's GitHub source. Failures keep the runner reason
 * (PULL_DIVERGED, PULL_CONFLICT, PULL_DIRTY, GIT_CONFIG_UNSAFE…) and the T4 copy (title,
 * untouched, raw output).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: z.object({ projectId: z.uuid() }),
  rateLimit: { limit: 30, windowMs: 5 * 60_000 },
  handler: ({ params: { projectId }, ctx }) => withProjectErrors(() => syncProject(ctx, projectId)),
});
