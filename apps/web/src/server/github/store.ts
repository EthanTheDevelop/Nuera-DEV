import 'server-only';
import { integrations } from '@nuera/db/schema';
import type { IntegrationStatus } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { decryptJson, encryptJson } from '@/server/security/crypto';
import { githubConfigSchema, githubSecretsSchema, type GithubConfig, type GithubSecrets } from './types';

/**
 * Persistence of the GitHub App registration: one `integrations` row (kind = 'github').
 * `config` = non-secret metadata (ids, slug, installations, last check);
 * `secrets_encrypted` = AES-256-GCM JSON { privateKeyPem, clientSecret, webhookSecret }.
 */

export type GithubRow = typeof integrations.$inferSelect;

export interface StoredGithubApp {
  row: GithubRow;
  config: GithubConfig;
}

export async function readGithubRow(): Promise<GithubRow | null> {
  const [row] = await db.select().from(integrations).where(eq(integrations.kind, 'github')).limit(1);
  return row ?? null;
}

export function parseGithubConfig(row: GithubRow): GithubConfig | null {
  const parsed = githubConfigSchema.safeParse(row.config);
  return parsed.success ? parsed.data : null;
}

/** The registered GitHub App, or null when none is stored (or the row is unreadable). */
export async function getStoredGithubApp(): Promise<StoredGithubApp | null> {
  const row = await readGithubRow();
  if (!row) return null;
  const config = parseGithubConfig(row);
  return config ? { row, config } : null;
}

export function readGithubSecrets(row: GithubRow): GithubSecrets {
  if (!row.secretsEncrypted) {
    throw new AppError('CONFLICT', "Les identifiants de l'application GitHub sont absents : reconnectez GitHub.");
  }
  try {
    return githubSecretsSchema.parse(decryptJson<unknown>(row.secretsEncrypted));
  } catch {
    throw new AppError('INTERNAL', "Les identifiants de l'application GitHub ne peuvent pas être déchiffrés.", {
      detail: 'Vérifiez APP_ENCRYPTION_KEY (et APP_ENCRYPTION_PREVIOUS_KEYS après une rotation).',
    });
  }
}

/** Inserts the app registration. Throws CONFLICT if an app is already stored. */
export async function insertGithubApp(config: GithubConfig, secrets: GithubSecrets): Promise<GithubRow> {
  const existing = await readGithubRow();
  if (existing) {
    throw new AppError('CONFLICT', "Une application GitHub est déjà enregistrée : déconnectez-la d'abord.");
  }
  const [row] = await db
    .insert(integrations)
    .values({
      kind: 'github',
      status: 'pending',
      label: config.name,
      config: githubConfigSchema.parse(config) as unknown as Record<string, unknown>,
      secretsEncrypted: encryptJson(githubSecretsSchema.parse(secrets)),
    })
    .returning();
  if (!row) throw new AppError('INTERNAL', "Enregistrement de l'application GitHub impossible.");
  return row;
}

export interface GithubRowPatch {
  status?: IntegrationStatus;
  lastCheckedAt?: Date | null;
  lastSuccessAt?: Date | null;
  lastError?: string | null;
  expiresAt?: Date | null;
}

/** Applies a config transformation + optional column changes (read-modify-write on one row). */
export async function updateGithubApp(
  mutate: (config: GithubConfig) => GithubConfig,
  patch: GithubRowPatch = {},
): Promise<StoredGithubApp> {
  const current = await getStoredGithubApp();
  if (!current) throw new AppError('NOT_FOUND', "Aucune application GitHub n'est enregistrée.");
  const config = githubConfigSchema.parse(mutate(structuredClone(current.config)));
  const [row] = await db
    .update(integrations)
    .set({ config: config as unknown as Record<string, unknown>, ...patch })
    .where(eq(integrations.id, current.row.id))
    .returning();
  if (!row) throw new AppError('NOT_FOUND', "Aucune application GitHub n'est enregistrée.");
  return { row, config };
}

/** Deletes the registration and its encrypted credentials. Returns true when a row existed. */
export async function deleteGithubApp(): Promise<boolean> {
  const rows = await db.delete(integrations).where(eq(integrations.kind, 'github')).returning({ id: integrations.id });
  return rows.length > 0;
}
