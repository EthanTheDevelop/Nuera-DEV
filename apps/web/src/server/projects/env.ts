import 'server-only';
import { projectEnvVars } from '@nuera/db/schema';
import { isDeniedProjectEnvName } from '@nuera/shared/env';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { audit } from '@/server/security/audit';
import { decryptSecret, encryptSecret } from '@/server/security/crypto';
import { requireProjectRow } from './queries';
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
 */

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

type Actor = { id: string };

function toView(row: typeof projectEnvVars.$inferSelect): EnvVarView {
  let value: string | null = null;
  if (!row.isSecret) {
    try {
      value = decryptSecret(row.valueEncrypted);
    } catch {
      value = null;
    }
  }
  return { id: row.id, key: row.key, secret: row.isSecret, value, updatedAt: row.updatedAt.toISOString() };
}

/** Names (+ non-secret values) of the project's variables, sorted by name. */
export async function listEnvVars(projectId: string): Promise<EnvVarView[]> {
  const rows = await db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, projectId)).orderBy(asc(projectEnvVars.key));
  return rows.map(toView);
}

/**
 * Decrypted variables for the runner (`createRun.env`). Server-side only; a value that cannot be
 * decrypted (rotated key) is skipped rather than sent empty.
 */
export async function decryptedEnvForRuns(projectId: string): Promise<Record<string, string>> {
  const rows = await db.select().from(projectEnvVars).where(eq(projectEnvVars.projectId, projectId));
  const env: Record<string, string> = {};
  for (const row of rows) {
    if (isProtectedEnvName(row.key)) continue;
    try {
      env[row.key] = decryptSecret(row.valueEncrypted);
    } catch {
      // Unreadable after a key change: the owner replaces it from the project page.
    }
  }
  return env;
}

export async function createEnvVar(projectId: string, input: z.input<typeof createEnvVarInputSchema>, actor: Actor): Promise<EnvVarView> {
  const project = await requireProjectRow(projectId);
  if (project.archivedAt) throw new AppError('CONFLICT', 'Ce projet est archivé.');
  const parsed = createEnvVarInputSchema.parse(input);
  const [existing] = await db
    .select({ id: projectEnvVars.id })
    .from(projectEnvVars)
    .where(and(eq(projectEnvVars.projectId, projectId), eq(projectEnvVars.key, parsed.key)))
    .limit(1);
  if (existing) throw new AppError('CONFLICT', `La variable ${parsed.key} existe déjà : modifiez-la plutôt.`);
  const [row] = await db
    .insert(projectEnvVars)
    .values({ projectId, key: parsed.key, valueEncrypted: encryptSecret(parsed.value), isSecret: parsed.secret })
    .returning();
  await audit({
    action: 'project.env_created',
    summary: `variable ${parsed.key} ajoutée à ${project.name}${parsed.secret ? ' (secrète)' : ''}`,
    targetType: 'project',
    targetId: project.id,
    metadata: { key: parsed.key, secret: parsed.secret },
    actorUserId: actor.id,
  });
  return toView(row!);
}

export async function updateEnvVar(projectId: string, input: z.input<typeof updateEnvVarInputSchema>, actor: Actor): Promise<EnvVarView> {
  const project = await requireProjectRow(projectId);
  if (project.archivedAt) throw new AppError('CONFLICT', 'Ce projet est archivé.');
  const parsed = updateEnvVarInputSchema.parse(input);
  const [row] = await db
    .select()
    .from(projectEnvVars)
    .where(and(eq(projectEnvVars.id, parsed.id), eq(projectEnvVars.projectId, projectId)))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'Variable introuvable.');
  if (parsed.value === undefined && parsed.secret === undefined) return toView(row);
  // Turning a secret into a plain variable would reveal its value: a new value is required.
  if (row.isSecret && parsed.secret === false && parsed.value === undefined) {
    throw new AppError('VALIDATION', 'Saisissez une nouvelle valeur pour rendre cette variable visible.');
  }
  const [updated] = await db
    .update(projectEnvVars)
    .set({
      ...(parsed.value !== undefined ? { valueEncrypted: encryptSecret(parsed.value) } : {}),
      ...(parsed.secret !== undefined ? { isSecret: parsed.secret } : {}),
    })
    .where(eq(projectEnvVars.id, row.id))
    .returning();
  const changes = [parsed.value !== undefined ? 'valeur remplacée' : null, parsed.secret !== undefined && parsed.secret !== row.isSecret ? (parsed.secret ? 'rendue secrète' : 'rendue visible') : null]
    .filter(Boolean)
    .join(', ');
  await audit({
    action: 'project.env_updated',
    summary: `variable ${row.key} de ${project.name} modifiée${changes ? ` (${changes})` : ''}`,
    targetType: 'project',
    targetId: project.id,
    metadata: { key: row.key, valueReplaced: parsed.value !== undefined, secret: updated!.isSecret },
    actorUserId: actor.id,
  });
  return toView(updated!);
}

export async function deleteEnvVar(projectId: string, id: string, actor: Actor): Promise<{ deleted: boolean }> {
  const project = await requireProjectRow(projectId);
  const [row] = await db
    .delete(projectEnvVars)
    .where(and(eq(projectEnvVars.id, id), eq(projectEnvVars.projectId, projectId)))
    .returning({ key: projectEnvVars.key });
  if (!row) return { deleted: false };
  await audit({
    action: 'project.env_deleted',
    summary: `variable ${row.key} supprimée de ${project.name}`,
    targetType: 'project',
    targetId: project.id,
    metadata: { key: row.key },
    actorUserId: actor.id,
  });
  return { deleted: true };
}
