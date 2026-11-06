import { z } from 'zod';
import { getProjectCoolifyApplications, listCoolifyApplications, toPublicApplication } from '@/server/coolify';
import { apiRoute } from '@/server/http';

/**
 * GET /api/integrations/coolify/applications[?projectId=] — read-only view of the Coolify
 * applications visible to the space's token; with `projectId` (a project of the space; another
 * space's answers like an unknown one, before any call to Coolify), the applications deploying that
 * project's repository (its branch first) and their latest deployments. Browser-safe fields only.
 */

export const dynamic = 'force-dynamic';

const querySchema = z.object({ projectId: z.uuid().optional() });

export const GET = apiRoute({
  query: querySchema,
  rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async ({ query, ctx }) => {
    if (query.projectId) {
      return { projectId: query.projectId, applications: await getProjectCoolifyApplications({ spaceId: ctx.space.id, projectId: query.projectId }) };
    }
    return { applications: (await listCoolifyApplications(ctx.space.id)).map(toPublicApplication) };
  },
});
