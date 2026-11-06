import 'server-only';
import { githubSources } from '@nuera/db/schema';
import type { IntegrationStatus } from '@nuera/db/schema';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { decryptJson, encryptJson, needsReencryption, reencryptSecret, SecretScopes } from '@/server/security/crypto';
import { MAX_GITHUB_SOURCES_PER_SPACE } from './config';
import { githubConfigSchema, githubSecretsSchema, type GithubConfig, type GithubSecrets } from './types';

/**
 * GitHub sources of a space (table `github_sources`, MULTICOMPTE §3.1): one row per GitHub App,
 * at most {@link MAX_GITHUB_SOURCES_PER_SPACE} per space. Every read and write names the space: a
 * source of another space answers exactly like an unknown one (NOT_FOUND « Source GitHub
 * introuvable. »).
 * `config` = non-secret metadata (ids, slug, installations, last check);
 * `secrets_encrypted` = AES-256-GCM JSON { privateKeyPem, clientSecret, webhookSecret }, bound to
 * the source id (legacy values are still read, and rewritten bound on the next update).
 */

export type GithubSourceRow = typeof githubSources.$inferSelect;
/** @deprecated name kept for the readers of the former single-app row. */
export type GithubRow = GithubSourceRow;

export interface StoredGithubSource {
  id: string;
  spaceId: string;
  /** « nuera-studio », or the app name. */
  label: string;
  row: GithubSourceRow;
  config: GithubConfig;
}
/** @deprecated alias of {@link StoredGithubSource}. */
export type StoredGithubApp = StoredGithubSource;

export interface GithubSourceScope {
  spaceId: string;
  sourceId: string;
}

export const GITHUB_SOURCE_NOT_FOUND = 'Source GitHub introuvable.';

const isUuid = (value: unknown): value is string => typeof value === 'string' && z.uuid().safeParse(value).success;

export function parseGithubConfig(row: Pick<GithubSourceRow, 'config'>): GithubConfig | null {
  const parsed = githubConfigSchema.safeParse(row.config);
  return parsed.success ? parsed.data : null;
}

/** Display label: the stored one, else the owner of the app, else its name. */
export function labelOf(row: Pick<GithubSourceRow, 'label' | 'ownerLogin'>, config: GithubConfig | null): string {
  return row.label?.trim() || config?.owner?.login || row.ownerLogin || config?.name || 'GitHub';
}

function toStored(row: GithubSourceRow): StoredGithubSource | null {
  const config = parseGithubConfig(row);
  return config ? { id: row.id, spaceId: row.spaceId, label: labelOf(row, config), row, config } : null;
}

/** Sources of the space, oldest first (the first one is the default); unreadable rows apart. */
export async function listGithubSources(spaceId: string): Promise<{ sources: StoredGithubSource[]; unreadable: GithubSourceRow[] }> {
  if (!isUuid(spaceId)) return { sources: [], unreadable: [] };
  const rows = await db
    .select()
    .from(githubSources)
    .where(eq(githubSources.spaceId, spaceId))
    .orderBy(asc(githubSources.createdAt), asc(githubSources.id));
  const sources: StoredGithubSource[] = [];
  const unreadable: GithubSourceRow[] = [];
  for (const row of rows) {
    const stored = toStored(row);
    if (stored) sources.push(stored);
    else unreadable.push(row);
  }
  return { sources, unreadable };
}

export async function countGithubSources(spaceId: string): Promise<number> {
  if (!isUuid(spaceId)) return 0;
  const [row] = await db.select({ n: count() }).from(githubSources).where(eq(githubSources.spaceId, spaceId));
  return Number(row?.n ?? 0);
}

async function readRow(scope: GithubSourceScope): Promise<GithubSourceRow | null> {
  if (!isUuid(scope.spaceId) || !isUuid(scope.sourceId)) return null;
  const [row] = await db
    .select()
    .from(githubSources)
    .where(and(eq(githubSources.id, scope.sourceId), eq(githubSources.spaceId, scope.spaceId)))
    .limit(1);
  return row ?? null;
}

/** The source, or null (unknown, malformed id, another space's, or unreadable). */
export async function findGithubSource(scope: GithubSourceScope): Promise<StoredGithubSource | null> {
  const row = await readRow(scope);
  return row ? toStored(row) : null;
}

/** The source, or NOT_FOUND « Source GitHub introuvable. » (same answer for another space's id). */
export async function getGithubSource(scope: GithubSourceScope): Promise<StoredGithubSource> {
  const stored = await findGithubSource(scope);
  if (!stored) throw new AppError('NOT_FOUND', GITHUB_SOURCE_NOT_FOUND);
  return stored;
}

/** Row of the source even when its configuration is unreadable (disconnect, diagnostic). */
export async function getGithubSourceRow(scope: GithubSourceScope): Promise<GithubSourceRow> {
  const row = await readRow(scope);
  if (!row) throw new AppError('NOT_FOUND', GITHUB_SOURCE_NOT_FOUND);
  return row;
}

export function readGithubSecrets(row: Pick<GithubSourceRow, 'id' | 'secretsEncrypted'>): GithubSecrets {
  if (!row.secretsEncrypted) {
    throw new AppError('CONFLICT', "Les identifiants de l'application GitHub sont absents : reconnectez GitHub.");
  }
  try {
    return githubSecretsSchema.parse(decryptJson<unknown>(row.secretsEncrypted, SecretScopes.githubSource(row.id)));
  } catch {
    throw new AppError('INTERNAL', "Les identifiants de l'application GitHub ne peuvent pas être déchiffrés.", {
      detail: 'Vérifiez APP_ENCRYPTION_KEY (et APP_ENCRYPTION_PREVIOUS_KEYS après une rotation).',
    });
  }
}

export const GITHUB_APP_ALREADY_REGISTERED = 'Cette application GitHub est déjà enregistrée.';

/** True when `label` is already the label of one of `taken` (case-insensitive). */
export function labelTaken(label: string, taken: readonly string[]): boolean {
  const wanted = label.trim().toLowerCase();
  return taken.some((item) => item.trim().toLowerCase() === wanted);
}

/** `label`, or « label 2 », « label 3 »… so that each source of a space has its own label. */
export function uniqueLabel(label: string | null, taken: readonly string[]): string | null {
  if (!label || !labelTaken(label, taken)) return label;
  for (let index = 2; ; index += 1) {
    const candidate = `${label} ${index}`;
    if (!labelTaken(candidate, taken)) return candidate;
  }
}

/**
 * Inserts a source (id chosen by the caller: the manifest flow allocates it first). CONFLICT when
 * the app or the id is already registered, or when the space already has the maximum of sources.
 */
export async function insertGithubSource(input: {
  id: string;
  spaceId: string;
  createdByUserId: string | null;
  label: string | null;
  config: GithubConfig;
  secrets: GithubSecrets;
}): Promise<StoredGithubSource> {
  const config = githubConfigSchema.parse(input.config);
  try {
    const row = await db.transaction(async (tx) => {
      // Serialises the creations of one space (the limit below is then exact).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`github_sources:${input.spaceId}`}))`);
      const [current] = await tx.select({ n: count() }).from(githubSources).where(eq(githubSources.spaceId, input.spaceId));
      if (Number(current?.n ?? 0) >= MAX_GITHUB_SOURCES_PER_SPACE) {
        throw new AppError('CONFLICT', `Votre espace a déjà ${MAX_GITHUB_SOURCES_PER_SPACE} sources GitHub : déconnectez-en une d'abord.`, {
          reason: 'SOURCE_LIMIT',
        });
      }
      // Two apps of the same owner would read « GitHub · atelier-test » twice: « atelier-test 2 ».
      const siblings = await tx
        .select({ label: githubSources.label, ownerLogin: githubSources.ownerLogin, config: githubSources.config })
        .from(githubSources)
        .where(eq(githubSources.spaceId, input.spaceId));
      const label = uniqueLabel(
        input.label,
        siblings.map((sibling) => labelOf(sibling, parseGithubConfig(sibling))),
      );
      const [inserted] = await tx
        .insert(githubSources)
        .values({
          id: input.id,
          spaceId: input.spaceId,
          kind: 'app',
          label,
          appId: config.appId,
          ownerLogin: config.owner?.login ?? null,
          ownerType: config.owner?.type ?? null,
          status: 'pending',
          config: config as unknown as Record<string, unknown>,
          secretsEncrypted: encryptJson(githubSecretsSchema.parse(input.secrets), SecretScopes.githubSource(input.id)),
          createdByUserId: input.createdByUserId,
        })
        .returning();
      return inserted;
    });
    if (!row) throw new AppError('INTERNAL', "Enregistrement de l'application GitHub impossible.");
    return toStored(row)!;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as { code?: string; cause?: { code?: string } }).code === '23505' || (error as { cause?: { code?: string } }).cause?.code === '23505') {
      throw new AppError('CONFLICT', GITHUB_APP_ALREADY_REGISTERED);
    }
    throw error;
  }
}

export interface GithubRowPatch {
  status?: IntegrationStatus;
  lastCheckedAt?: Date | null;
  lastSuccessAt?: Date | null;
  lastError?: string | null;
  expiresAt?: Date | null;
  label?: string | null;
}

/**
 * Read-modify-write of one source in a transaction (`select … for update`): the scheduled check,
 * the setup redirect and a repository listing may update the same row at the same time. A legacy
 * ciphertext is rewritten in the bound format on the way.
 */
export async function updateGithubSource(
  scope: GithubSourceScope,
  mutate: (config: GithubConfig) => GithubConfig,
  patch: GithubRowPatch = {},
): Promise<StoredGithubSource> {
  if (!isUuid(scope.spaceId) || !isUuid(scope.sourceId)) throw new AppError('NOT_FOUND', GITHUB_SOURCE_NOT_FOUND);
  const row = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(githubSources)
      .where(and(eq(githubSources.id, scope.sourceId), eq(githubSources.spaceId, scope.spaceId)))
      .for('update')
      .limit(1);
    const parsed = current ? parseGithubConfig(current) : null;
    if (!current || !parsed) throw new AppError('NOT_FOUND', GITHUB_SOURCE_NOT_FOUND);
    const config = githubConfigSchema.parse(mutate(structuredClone(parsed)));
    let secretsEncrypted = current.secretsEncrypted;
    if (secretsEncrypted && needsReencryption(secretsEncrypted)) {
      try {
        secretsEncrypted = reencryptSecret(secretsEncrypted, SecretScopes.githubSource(current.id));
      } catch {
        // Unreadable: left as is (the check reports it).
      }
    }
    const [updated] = await tx
      .update(githubSources)
      .set({
        config: config as unknown as Record<string, unknown>,
        ownerLogin: config.owner?.login ?? current.ownerLogin,
        ownerType: config.owner?.type ?? current.ownerType,
        secretsEncrypted,
        ...patch,
      })
      .where(and(eq(githubSources.id, current.id), eq(githubSources.spaceId, scope.spaceId)))
      .returning();
    return updated;
  });
  if (!row) throw new AppError('NOT_FOUND', GITHUB_SOURCE_NOT_FOUND);
  return toStored(row)!;
}

/** Deletes the source and its encrypted credentials. Returns the deleted row, or null. */
export async function deleteGithubSourceRow(scope: GithubSourceScope): Promise<GithubSourceRow | null> {
  if (!isUuid(scope.spaceId) || !isUuid(scope.sourceId)) return null;
  const [row] = await db
    .delete(githubSources)
    .where(and(eq(githubSources.id, scope.sourceId), eq(githubSources.spaceId, scope.spaceId)))
    .returning();
  return row ?? null;
}
