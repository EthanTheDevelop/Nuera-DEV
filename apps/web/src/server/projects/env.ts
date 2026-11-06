import 'server-only';
import { projectEnvVars } from '@nuera/db/schema';
import { isDeniedProjectEnvName } from '@nuera/shared/env';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { decryptSecret, encryptSecret, needsReencryption, SecretScopes, type SecretScope } from '@/server/security/crypto';
import { auditIn } from '@/server/tenancy/scope';
import { requireProject, type ProjectContext, type ProjectHandle } from './access';
import type { EnvVarView } from './types';

/**
 * Project environment variables (D04 « Variables d'environnement »), encrypted with AES-256-GCM in
 * `project_env_vars`. They are given to the project's own commands (runs) by the runner.
 *
 * - A SECRET value never leaves the server: the browser gets the name and the mask, and can only
 *   replace it (docs/ARCHITECTURE.md §9).
 * - A non-secret value is shown in clear (« NEXT_PUBLIC_SITE_URL https://… ») and can be edited.
 * - Names the runner refuses for project commands (credentials of Claude, code injection, runner
 *   identity) are refused here too, with the same list (`@nuera/shared/env`).
 * - Each value is encrypted BOUND to its row (`project_env_vars`, project id and name): a ciphertext
 *   copied under another project (or another space) does not decrypt. Values written before the
 *   multi-account model (legacy format) are still read, and rewritten bound on their next update.
 */

/** Associated data of a project variable's ciphertext (sessions decrypt with the same scope). */
export function projectEnvSecretScope(projectId: string, key: string): SecretScope {
  return SecretScopes.projectEnvVar(projectId, key);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Same list as the runner's project commands (`@nuera/shared/env`). */
export function isProtectedEnvName(name: string): boolean {
  return isDeniedProjectEnvName(name);
}

export const envVarNameSchema = z
  .string()
  .trim()
  .regex(ENV_NAME, 'nom invalide (lettres, chiffres et _, sans commencer par un chiffre)')
  .refine((name) => !isProtectedEnvName(name), { message: 'nom réservé : il ne peut pas être défini pour un projet' });

export const envVarValueSchema = z.string().max(32_768, '32 768 caractères au maximum');

export const createEnvVarInputSchema = z.object({
  key: envVarNameSchema,
  value: envVarValueSchema,
  secret: z.boolean().default(true),
});
export const updateEnvVarInputSchema = z.object({
  id: z.uuid(),
  /** New value (replace). Absent = keep the current one (only the secret flag changes). */
  value: envVarValueSchema.optional(),
  secret: z.boolean().optional(),
});
export const deleteEnvVarInputSchema = z.object({ id: z.uuid() });

type EnvRow = typeof projectEnvVars.$inferSelect;

function decryptRow(row: EnvRow): string {
  return decryptSecret(row.valueEncrypted, projectEnvSecretScope(row.projectId, row.key));
}

function toView(row: EnvRow): EnvVarView {
  let value: string | null = null;
  if (!row.isSecret) {
    try {
      value = decryptRow(row);
    } catch {
      value = null;
    }
  }
  return { id: row.id, key: row.key, secret: row.isSecret, value, updatedAt: row.updatedAt.toISOString() };
}

/** Variables of a project already checked in the space (detail page). */
export async function envVarsOf(handle: Pick<ProjectHandle, 'row'>): Promise<EnvVarView[]> {
  const rows = await db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, handle.row.id)).orderBy(asc(projectEnvVars.key));
  return rows.map(toView);
}

/** Names (+ non-secret values) of the variables of a project of the space, sorted by name. */
export async function listEnvVars(ctx: ProjectContext, projectId: string): Promise<EnvVarView[]> {
  return envVarsOf(await requireProject(ctx, projectId));
}

/**
 * Decrypted variables for the runner (`createRun.env`) of a project already checked in the space.
 * Server-side only; a value that cannot be decrypted (rotated key, row moved) is skipped rather
 * than sent empty.
 */
export async function decryptedEnvForRuns(projectId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, projectId));
  const env: Record<string, string> = {};
  for (const row of rows) {
    if (isProtectedEnvName(row.key)) continue;
    try {
      env[row.key] = decryptRow(row);
    } catch {
      // Unreadable after a key change: the owner replaces it from the project page.
    }
  }
  return env;
}

export async function createEnvVar(ctx: ProjectContext, projectId: string, input: z.input<typeof createEnvVarInputSchema>): Promise<EnvVarView> {
  const { row: project, environment } = await requireProject(ctx, projectId, { state: 'active' });
  const parsed = createEnvVarInputSchema.parse(input);
  const [existing] = await db
    .select({ id: projectEnvVars.id })
    .from(projectEnvVars)
    .where(and(eq(projectEnvVars.projectId, project.id), eq(projectEnvVars.key, parsed.key)))
    .limit(1);
  if (existing) throw new AppError('CONFLICT', `La variable ${parsed.key} existe déjà : modifiez-la plutôt.`);
  const [row] = await db
    .insert(projectEnvVars)
    .values({
      projectId: project.id,
      key: parsed.key,
      valueEncrypted: encryptSecret(parsed.value, projectEnvSecretScope(project.id, parsed.key)),
      isSecret: parsed.secret,
    })
    .returning();
  await auditIn(ctx, {
    environmentId: environment.id,
    action: 'project.env_created',
    summary: `variable ${parsed.key} ajoutée à ${project.name}${parsed.secret ? ' (secrète)' : ''}`,
    targetType: 'project',
    targetId: project.id,
    metadata: { key: parsed.key, secret: parsed.secret },
  });
  return toView(row!);
}

/**
 * The new ciphertext of a variable: the new value, else its current value rewritten in the bound
 * format when it is still a legacy one (undefined = nothing to rewrite).
 */
function nextCipher(row: EnvRow, value: string | undefined): string | undefined {
  const scope = projectEnvSecretScope(row.projectId, row.key);
  if (value !== undefined) return encryptSecret(value, scope);
  if (!needsReencryption(row.valueEncrypted)) return undefined;
  try {
    return encryptSecret(decryptSecret(row.valueEncrypted, scope), scope);
  } catch {
    // Unreadable (rotated key): kept as is, the owner replaces the value.
    return undefined;
  }
}

export async function updateEnvVar(ctx: ProjectContext, projectId: string, input: z.input<typeof updateEnvVarInputSchema>): Promise<EnvVarView> {
  const { row: project, environment } = await requireProject(ctx, projectId, { state: 'active' });
  const parsed = updateEnvVarInputSchema.parse(input);
  const [row] = await db
    .select()
    .from(projectEnvVars)
    .where(and(eq(projectEnvVars.id, parsed.id), eq(projectEnvVars.projectId, project.id)))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'Variable introuvable.');
  if (parsed.value === undefined && parsed.secret === undefined) return toView(row);
  // Turning a secret into a plain variable would reveal its value: a new value is required.
  if (row.isSecret && parsed.secret === false && parsed.value === undefined) {
    throw new AppError('VALIDATION', 'Saisissez une nouvelle valeur pour rendre cette variable visible.');
  }
  const cipher = nextCipher(row, parsed.value);
  const [updated] = await db
    .update(projectEnvVars)
    .set({
      ...(cipher !== undefined ? { valueEncrypted: cipher } : {}),
      ...(parsed.secret !== undefined ? { isSecret: parsed.secret } : {}),
    })
    .where(and(eq(projectEnvVars.id, row.id), eq(projectEnvVars.projectId, project.id)))
    .returning();
  const changes = [parsed.value !== undefined ? 'valeur remplacée' : null, parsed.secret !== undefined && parsed.secret !== row.isSecret ? (parsed.secret ? 'rendue secrète' : 'rendue visible') : null]
    .filter(Boolean)
    .join(', ');
  await auditIn(ctx, {
    environmentId: environment.id,
    action: 'project.env_updated',
    summary: `variable ${row.key} de ${project.name} modifiée${changes ? ` (${changes})` : ''}`,
    targetType: 'project',
    targetId: project.id,
    metadata: { key: row.key, valueReplaced: parsed.value !== undefined, secret: updated!.isSecret },
  });
  return toView(updated!);
}

export async function deleteEnvVar(ctx: ProjectContext, projectId: string, id: string): Promise<{ deleted: boolean }> {
  const { row: project, environment } = await requireProject(ctx, projectId);
  const [row] = await db
    .delete(projectEnvVars)
    .where(and(eq(projectEnvVars.id, id), eq(projectEnvVars.projectId, project.id)))
    .returning({ key: projectEnvVars.key });
  if (!row) return { deleted: false };
  await auditIn(ctx, {
    environmentId: environment.id,
    action: 'project.env_deleted',
    summary: `variable ${row.key} supprimée de ${project.name}`,
    targetType: 'project',
    targetId: project.id,
    metadata: { key: row.key },
  });
  return { deleted: true };
}
