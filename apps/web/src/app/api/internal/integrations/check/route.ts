import { z } from 'zod';
import { internalRoute } from '@/server/http';
import { runAllIntegrationChecks } from '@/server/integrations';

/**
 * POST /api/internal/integrations/check — runner → web (Bearer RUNNER_TOKEN), every 15 minutes.
 * Runs the GitHub, Coolify and MCP checks (non-mutating), updates the statuses and creates the
 * « bientôt expiré » / « expiré » / « ne répond plus » notifications on transitions (T7).
 * Body optional: `{ trigger?: 'schedule' | 'startup' | 'hook' | 'git_failure' }`.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const bodySchema = z
  .object({ trigger: z.enum(['schedule', 'startup', 'hook', 'git_failure']).default('schedule') })
  .default({ trigger: 'schedule' });

export const POST = internalRoute({
  body: bodySchema,
  handler: async ({ body }) => runAllIntegrationChecks({ trigger: body.trigger }),
});
