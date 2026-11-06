import 'server-only';
import { environments } from '@nuera/db/schema';
import type { EnvironmentConfigSource, EnvironmentStatus } from '@nuera/db/schema';
import { hashToken } from '@nuera/shared/tokens';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { decryptSecret, encryptSecret, SecretScopes } from '@/server/security/crypto';

/**
 * Where the web reaches the runner of one server (environment), and with which bearer token.
 *
 *   const endpoint = await getRunnerEndpoint(project.environmentId);
 *
 * - `config_source = 'env'` (the default server, « VPS-3 »): RUNNER_URL / RUNNER_TOKEN, read at
 *   every call exactly as before the multi-account model (no manual step at upgrade).
 * - `config_source = 'db'`: `environments.url` + the AES-256-GCM `token_encrypted` (bound to its
 *   row), and `next_token_encrypted` as a fallback while a rotation is in progress.
 * - Rows are cached 30 s per process; {@link invalidateRunnerEndpoint} after any change.
 *
 * Tokens never leave the server: an endpoint is never serialised to a client.
 */

export const DEFAULT_RUNNER_URL = 'http://127.0.0.1:4100';
const ENDPOINT_TTL_MS = 30_000;
const MIN_TOKEN_LENGTH = 16;

/** RUNNER_URL / RUNNER_TOKEN of the default server (`config_source = 'env'`). */
export function getRunnerConfig(): { baseUrl: string; token: string | null } {
  const baseUrl = (process.env.RUNNER_URL || DEFAULT_RUNNER_URL).replace(/\/+$/, '');
  const token = process.env.RUNNER_TOKEN?.trim() || null;
  return { baseUrl, token };
}

export interface RunnerEndpoint {
  environmentId: string;
  /** Server name shown in the copy (« VPS-3 ne répond pas… »). */
  name: string;
  isDefault: boolean;
  configSource: EnvironmentConfigSource;
  status: EnvironmentStatus;
  /** null when the server has no URL yet (the call answers RUNNER_UNAVAILABLE with `problem`). */
  baseUrl: string | null;
  /** Bearer token; null when missing or unreadable (see `problem`). */
  token: string | null;
  /** Token being rotated in, tried once when the runner refuses `token`. */
  fallbackToken: string | null;
  /** Why the endpoint cannot be used (French, no secret). */
  problem: string | null;
}

interface EnvironmentRow {
  id: string;
  name: string;
  isDefault: boolean;
  configSource: EnvironmentConfigSource;
  status: EnvironmentStatus;
  url: string | null;
  tokenEncrypted: string | null;
  nextTokenEncrypted: string | null;
}

interface CachedRow {
  row: EnvironmentRow;
  /** Decrypted tokens of a `db` server (decrypted once per cache period). */
  token: string | null;
  fallbackToken: string | null;
  problem: string | null;
  expiresAt: number;
}

const cacheHolder = globalThis as unknown as { __nueraRunnerEndpoints?: Map<string, CachedRow> };

function endpointCache(): Map<string, CachedRow> {
  cacheHolder.__nueraRunnerEndpoints ??= new Map();
  return cacheHolder.__nueraRunnerEndpoints;
}

/** Forget one server (or all of them) after its row changed: URL, token, rotation, status. */
export function invalidateRunnerEndpoint(environmentId?: string): void {
  if (environmentId) endpointCache().delete(environmentId);
  else endpointCache().clear();
}

/** AES-256-GCM ciphertext of a runner token, bound to its `environments` row. */
export function encryptRunnerToken(environmentId: string, token: string): string {
  return encryptSecret(token, SecretScopes.environmentToken(environmentId));
}

/** Clear token of `environments.token_encrypted` / `next_token_encrypted` (server side only). */
export function decryptRunnerToken(environmentId: string, cipherText: string): string {
  return decryptSecret(cipherText, SecretScopes.environmentToken(environmentId));
}

function readToken(row: EnvironmentRow, cipherText: string | null): { token: string | null; problem: string | null } {
  if (!cipherText) return { token: null, problem: `Le jeton du serveur ${row.name} n'est pas configuré.` };
  try {
    return { token: decryptRunnerToken(row.id, cipherText), problem: null };
  } catch {
    return { token: null, problem: `Le jeton du serveur ${row.name} est illisible : renouvelez-le depuis l'administration.` };
  }
}

async function loadRow(environmentId: string): Promise<CachedRow> {
  const cached = endpointCache().get(environmentId);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const [row] = await db
    .select({
      id: environments.id,
      name: environments.name,
      isDefault: environments.isDefault,
      configSource: environments.configSource,
      status: environments.status,
      url: environments.url,
      tokenEncrypted: environments.tokenEncrypted,
      nextTokenEncrypted: environments.nextTokenEncrypted,
    })
    .from(environments)
    .where(eq(environments.id, environmentId))
    .limit(1);
  if (!row) {
    endpointCache().delete(environmentId);
    throw new AppError('NOT_FOUND', 'Serveur introuvable.');
  }
  let entry: CachedRow;
  if (row.configSource === 'env') {
    entry = { row, token: null, fallbackToken: null, problem: null, expiresAt: Date.now() + ENDPOINT_TTL_MS };
  } else {
    const current = readToken(row, row.tokenEncrypted);
    const next = row.nextTokenEncrypted ? readToken(row, row.nextTokenEncrypted) : { token: null, problem: null };
    entry = {
      row,
      token: current.token ?? next.token,
      fallbackToken: current.token ? next.token : null,
      problem: current.token || next.token ? null : current.problem,
      expiresAt: Date.now() + ENDPOINT_TTL_MS,
    };
  }
  endpointCache().set(environmentId, entry);
  return entry;
}

/** Endpoint of one server. AppError NOT_FOUND « Serveur introuvable. » for an unknown id. */
export async function getRunnerEndpoint(environmentId: string): Promise<RunnerEndpoint> {
  await ensureDefaultRunnerTokenHash();
  const { row, token, fallbackToken, problem } = await loadRow(environmentId);
  const base = {
    environmentId: row.id,
    name: row.name,
    isDefault: row.isDefault,
    configSource: row.configSource,
    status: row.status,
  };
  if (row.configSource === 'env') {
    const config = getRunnerConfig();
    return {
      ...base,
      baseUrl: config.baseUrl,
      token: config.token,
      fallbackToken: null,
      problem: config.token ? null : "RUNNER_TOKEN n'est pas configuré côté web.",
    };
  }
  const url = row.url?.trim().replace(/\/+$/, '') || null;
  return {
    ...base,
    baseUrl: url,
    token,
    fallbackToken,
    problem: url ? problem : `L'adresse du serveur ${row.name} n'est pas configurée.`,
  };
}

const bootstrapHolder = globalThis as unknown as { __nueraDefaultTokenHash?: { hash: string; done: Promise<void> } };

/**
 * « Par sécurité » (MULTICOMPTE §4): records sha256(RUNNER_TOKEN) on the default server while its
 * `token_hash` is still empty (`migrate` normally did it). Idempotent, once per process and token
 * (again after a transient database failure); never throws and never overwrites a recorded
 * fingerprint (a changed RUNNER_TOKEN is `migrate`'s job, MULTICOMPTE §14 F1-2).
 */
export function ensureDefaultRunnerTokenHash(): Promise<void> {
  const token = process.env.RUNNER_TOKEN?.trim();
  if (!token || token.length < MIN_TOKEN_LENGTH) return Promise.resolve();
  const hash = hashToken(token);
  const current = bootstrapHolder.__nueraDefaultTokenHash;
  if (current?.hash === hash) return current.done;
  const entry: { hash: string; done: Promise<void> } = { hash, done: Promise.resolve() };
  entry.done = (async () => {
    try {
      await db
        .update(environments)
        .set({ tokenHash: hash })
        .where(and(eq(environments.isDefault, true), eq(environments.configSource, 'env'), isNull(environments.tokenHash)));
    } catch (error) {
      const duplicate = (error as { code?: unknown } | null)?.code === '23505';
      console.error(
        "[runner] empreinte du jeton du serveur par défaut non enregistrée :",
        duplicate ? "RUNNER_TOKEN est déjà le jeton d'un autre serveur." : error instanceof Error ? error.message : String(error),
      );
      // A transient failure (database briefly unreachable) is retried at the next call; a token
      // already used by another server is not (it would only repeat the same refusal).
      if (!duplicate && bootstrapHolder.__nueraDefaultTokenHash === entry) delete bootstrapHolder.__nueraDefaultTokenHash;
    }
  })();
  bootstrapHolder.__nueraDefaultTokenHash = entry;
  return entry.done;
}
