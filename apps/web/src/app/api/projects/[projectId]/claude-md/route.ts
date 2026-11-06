import { z } from 'zod';
import { apiRoute } from '@/server/http';
import { readProjectClaudeMd, withProjectErrors, writeClaudeMdInputSchema, writeProjectClaudeMd } from '@/server/projects';

/**
 * GET /api/projects/[projectId]/claude-md — CLAUDE.md of the primary clone (content, lines, last commit).
 * PUT — { content, commit = true, message? }: written by the runner and committed on the current
 * branch with the account's Git identity as author (audited).
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const params = z.object({ projectId: z.uuid() });

export const GET = apiRoute({
  params,
  handler: ({ params: { projectId }, ctx }) => withProjectErrors(() => readProjectClaudeMd(ctx, projectId)),
});

export const PUT = apiRoute({
  params,
  body: writeClaudeMdInputSchema,
  maxBodyBytes: 600 * 1024,
  rateLimit: { limit: 30, windowMs: 10 * 60_000 },
  handler: ({ params: { projectId }, body, ctx }) => withProjectErrors(() => writeProjectClaudeMd(ctx, projectId, body)),
});
