import { permissionDecisionInputSchema, permissionParamsSchema } from '@/features/workspace/lib/contract';
import { apiRoute } from '@/server/http';
import { decidePermission, withWorkspaceErrors } from '@/server/workspace';

/**
 * POST /api/permissions/[permissionId]/decision { optionId: allow | allow_always | deny, message? } —
 * answer of `Dev · Demande d'autorisation`, handed to the CLI's PermissionRequest hook (the mode is
 * never bypassed). 409 `PERMISSION_NOT_PENDING` / `PERMISSION_NO_LISTENER`. Audited
 * `permission.decision`. → PermissionRequestDto
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const POST = apiRoute({
  params: permissionParamsSchema,
  body: permissionDecisionInputSchema,
  maxBodyBytes: 16 * 1024,
  rateLimit: { limit: 120, windowMs: 10 * 60_000 },
  handler: ({ params, body, ctx }) => withWorkspaceErrors(() => decidePermission(ctx, params.permissionId, body)),
});
