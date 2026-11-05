import { fileQuerySchema, worktreeParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { getFile, withWorkspaceErrors } from '@/server/workspace';

/**
 * GET /api/worktrees/[worktreeId]/file?path= — read-only preview (W1 `Aperçu`): UTF-8 text capped,
 * `binary` / `truncated` flags, line count. → FileContent
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = apiRoute({
  params: worktreeParamsSchema,
  query: fileQuerySchema,
  rateLimit: { limit: 600, windowMs: 10 * 60_000 },
  handler: ({ params, query }) => withWorkspaceErrors(() => getFile(params.worktreeId, query.path)),
});
