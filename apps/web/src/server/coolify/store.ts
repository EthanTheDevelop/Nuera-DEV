import 'server-only';
import { integrations } from '@nuera/db/schema';
import type { IntegrationStatus } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import type { CheckHistoryEntry, IntegrationCheck } from '@/server/integrations/model';
import { decryptJson, encryptJson } from '@/server/security/crypto';

/**
 * Coolify credentials: one `integrations` row (kind = 'coolify').
 * config = base URL, token fingerprint (« jeton n°67 », the non-secret id before `|`), inferred scope
 * and abilities, declared expiry, last check. secrets_encrypted = { token } (AES-256-GCM).
 */

export const coolifyConfigSchema = z.object({
  baseUrl: z.string().min(1),
  /** Part of the token before `|` (Sanctum id): a display fingerprint, not a secret. */
  tokenIdPrefix: z.string().nullable().default(null),
  /** Expiry chosen in Coolify, declared by the owner (the API cannot return it, research §3.1). */
  declaredExpiresAt: z.string().nullable().default(null),
  scope: z.enum(['scoped', 'team', 'unknown']).default('unknown'),
  teamName: z.string().nullable().default(null),
  abilities: z.array(z.string()).default([]),
  abilitiesSource: z.enum(['mcp_tools', 'rest', 'unknown']).default('unknown'),
  version: z.string().nullable().default(null),
  mcpEnabled: z.boolean().nullable().default(null),
  mcpToolCount: z.number().int().nullable().default(null),
  visibleEnvironments: z.array(z.object({ project: z.string(), environment: z.string() })).default([]),
  productionVisible: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  connectedAt: z.string(),
  consecutiveFailures: z.number().int().default(0),
  failingSince: z.string().nullable().default(null),
  lastCheck: z.custom<IntegrationCheck>().nullable().default(null),
  history: z.array(z.custom<CheckHistoryEntry>()).default([]),
});
export type CoolifyConfig = z.infer<typeof coolifyConfigSchema>;

const coolifySecretsSchema = z.object({ token: z.string().min(1) });

export type CoolifyRow = typeof integrations.$inferSelect;

export async function readCoolifyRow(): Promise<CoolifyRow | null> {
  const [row] = await db.select().from(integrations).where(eq(integrations.kind, 'coolify')).limit(1);
  return row ?? null;
}

export async function getStoredCoolify(): Promise<{ row: CoolifyRow; config: CoolifyConfig } | null> {
  const row = await readCoolifyRow();
  if (!row) return null;
  const parsed = coolifyConfigSchema.safeParse(row.config);
  return parsed.success ? { row, config: parsed.data } : null;
}

export function readCoolifyToken(row: CoolifyRow): string {
  if (!row.secretsEncrypted) throw new AppError('CONFLICT', "Aucun jeton Coolify n'est enregistré.");
  try {
    return coolifySecretsSchema.parse(decryptJson<unknown>(row.secretsEncrypted)).token;
  } catch {
    throw new AppError('INTERNAL', 'Le jeton Coolify ne peut pas être déchiffré.', {
      detail: 'Vérifiez APP_ENCRYPTION_KEY, puis reconnectez Coolify si besoin.',
    });
  }
}

/** Inserts or replaces the Coolify credentials (reconnect). */
export async function upsertCoolify(input: {
  config: CoolifyConfig;
  token: string;
  status: IntegrationStatus;
  checkedAt: Date;
}): Promise<CoolifyRow> {
  const config = coolifyConfigSchema.parse(input.config) as unknown as Record<string, unknown>;
  const values = {
    kind: 'coolify' as const,
    status: input.status,
    label: 'Coolify',
    config,
    secretsEncrypted: encryptJson({ token: input.token }),
    lastCheckedAt: input.checkedAt,
    lastSuccessAt: input.checkedAt,
    lastError: null,
    expiresAt: input.config.declaredExpiresAt ? new Date(input.config.declaredExpiresAt) : null,
  };
  const [row] = await db
    .insert(integrations)
    .values(values)
    .onConflictDoUpdate({
      target: integrations.kind,
      set: {
        status: values.status,
        config: values.config,
        secretsEncrypted: values.secretsEncrypted,
        lastCheckedAt: values.lastCheckedAt,
        lastSuccessAt: values.lastSuccessAt,
        lastError: null,
        expiresAt: values.expiresAt,
      },
    })
    .returning();
  if (!row) throw new AppError('INTERNAL', 'Enregistrement du jeton Coolify impossible.');
  return row;
}

export async function updateCoolify(
  mutate: (config: CoolifyConfig) => CoolifyConfig,
  patch: { status?: IntegrationStatus; lastCheckedAt?: Date; lastSuccessAt?: Date; lastError?: string | null } = {},
): Promise<{ row: CoolifyRow; config: CoolifyConfig }> {
  const current = await getStoredCoolify();
  if (!current) throw new AppError('NOT_FOUND', "Coolify n'est pas connecté.");
  const config = coolifyConfigSchema.parse(mutate(structuredClone(current.config)));
  const [row] = await db
    .update(integrations)
    .set({ config: config as unknown as Record<string, unknown>, ...patch })
    .where(eq(integrations.id, current.row.id))
    .returning();
  if (!row) throw new AppError('NOT_FOUND', "Coolify n'est pas connecté.");
  return { row, config };
}

export async function deleteCoolify(): Promise<boolean> {
  const rows = await db.delete(integrations).where(eq(integrations.kind, 'coolify')).returning({ id: integrations.id });
  return rows.length > 0;
}
