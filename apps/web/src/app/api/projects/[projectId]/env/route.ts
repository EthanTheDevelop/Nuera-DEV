import { z } from 'zod';
import { apiRoute } from '@/server/http';
import {
  createEnvVar,
  createEnvVarInputSchema,
  deleteEnvVar,
  deleteEnvVarInputSchema,
  listEnvVars,
  updateEnvVar,
  updateEnvVarInputSchema,
  withProjectErrors,
} from '@/server/projects';

/**
 * Project variables (D04 « Variables d'environnement »), AES-256-GCM in the database, bound to their row.
 *   GET    → names, secret flag, values of the NON-secret ones only
 *   POST   { key, value, secret }      PATCH { id, value?, secret? }      DELETE { id }
 * A secret value is never sent back: it can only be replaced. Every change is audited.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const params = z.object({ projectId: z.uuid() });
const rateLimit = { limit: 60, windowMs: 10 * 60_000 };

export const GET = apiRoute({
  params,
  handler: ({ params: { projectId }, ctx }) => withProjectErrors(async () => ({ variables: await listEnvVars(ctx, projectId) })),
});

export const POST = apiRoute({
  params,
  body: createEnvVarInputSchema,
  maxBodyBytes: 64 * 1024,
  rateLimit,
  handler: ({ params: { projectId }, body, ctx }) =>
    withProjectErrors(async () => Response.json({ variable: await createEnvVar(ctx, projectId, body) }, { status: 201 })),
});

export const PATCH = apiRoute({
  params,
  body: updateEnvVarInputSchema,
  maxBodyBytes: 64 * 1024,
  rateLimit,
  handler: ({ params: { projectId }, body, ctx }) => withProjectErrors(async () => ({ variable: await updateEnvVar(ctx, projectId, body) })),
});

export const DELETE = apiRoute({
  params,
  body: deleteEnvVarInputSchema,
  rateLimit,
  handler: ({ params: { projectId }, body, ctx }) => withProjectErrors(() => deleteEnvVar(ctx, projectId, body.id)),
});
