import 'server-only';
import { createAppAuth } from '@octokit/auth-app';
import { AppError } from '@/server/errors';
import { createOctokit, githubErrorMessage, githubErrorStatus } from './client';
import { getStoredGithubApp, readGithubSecrets } from './store';
import type { GithubTokenPermissions } from './types';

/**
 * GitHub App credentials in memory:
 *  - app JWT (RS256, ≤ 10 min) for `/app/*` routes;
 *  - installation tokens DOWN-SCOPED per operation (repositories + permissions), cached in memory
 *    until 5 minutes before their expiry (research §2.4–2.5). Never written anywhere.
 */

const REFRESH_MARGIN_MS = 5 * 60_000;

interface CachedToken {
  token: string;
  expiresAt: string;
  expiresAtMs: number;
}

interface TokenState {
  tokens: Map<string, CachedToken>;
  pending: Map<string, Promise<CachedToken>>;
}

const globalForTokens = globalThis as unknown as { __nueraGithubTokens?: TokenState };
const state: TokenState =
  globalForTokens.__nueraGithubTokens ??
  (globalForTokens.__nueraGithubTokens = { tokens: new Map(), pending: new Map() });

export interface AppCredentials {
  appId: number;
  privateKey: string;
}

/** App id + private key of the stored app (decrypted on demand, never cached on disk). */
export async function getAppCredentials(): Promise<AppCredentials> {
  const stored = await getStoredGithubApp();
  if (!stored) throw new AppError('CONFLICT', "GitHub n'est pas connecté : créez l'application GitHub depuis Intégrations.");
  const secrets = readGithubSecrets(stored.row);
  return { appId: stored.config.appId, privateKey: secrets.privateKeyPem };
}

function createAuth(credentials: AppCredentials) {
  const base = createOctokit();
  return createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
    // Same base URL / API version / timeout as every other call (fake GitHub in tests).
    request: base.request as unknown as Parameters<typeof createAppAuth>[0]['request'],
    log: { warn: () => {} },
  });
}

/** Fresh app JWT (Bearer) for `/app/*` endpoints. */
export async function createAppJwt(credentials?: AppCredentials): Promise<string> {
  const auth = createAuth(credentials ?? (await getAppCredentials()));
  try {
    const { token } = await auth({ type: 'app' });
    return token;
  } catch (error) {
    throw new AppError('INTERNAL', "Signature du jeton de l'application GitHub impossible.", {
      detail: 'La clé privée stockée est illisible ou invalide.',
      raw: githubErrorMessage(error) ?? 'clé privée invalide',
    });
  }
}

export function tokenCacheKey(input: {
  installationId: number;
  repositoryNames?: readonly string[] | undefined;
  permissions?: GithubTokenPermissions | undefined;
}): string {
  const repos = [...(input.repositoryNames ?? [])].map((name) => name.toLowerCase()).sort().join(',');
  const perms = Object.entries(input.permissions ?? {})
    .filter(([, level]) => level)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, level]) => `${name}:${level}`)
    .join(',');
  return `${input.installationId}|${repos}|${perms}`;
}

export interface MintTokenInput {
  installationId: number;
  /** Repository NAMES (not full names) — the token is limited to them. Omit for the whole installation. */
  repositoryNames?: string[];
  /** Permission subset; omit for every permission of the installation (avoid). */
  permissions: GithubTokenPermissions;
  credentials?: AppCredentials;
  /** Bypass the cache (e.g. after a 401 from GitHub). */
  refresh?: boolean;
}

export interface MintedToken {
  token: string;
  expiresAt: string;
}

/** Mints (or reuses) a down-scoped installation access token. */
export async function mintInstallationToken(input: MintTokenInput): Promise<MintedToken> {
  const key = tokenCacheKey(input);
  if (!input.refresh) {
    const cached = state.tokens.get(key);
    if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > Date.now()) {
      return { token: cached.token, expiresAt: cached.expiresAt };
    }
    const inflight = state.pending.get(key);
    if (inflight) {
      const token = await inflight;
      return { token: token.token, expiresAt: token.expiresAt };
    }
  }

  const promise = (async (): Promise<CachedToken> => {
    const credentials = input.credentials ?? (await getAppCredentials());
    const auth = createAuth(credentials);
    try {
      const result = await auth({
        type: 'installation',
        installationId: input.installationId,
        ...(input.repositoryNames?.length ? { repositoryNames: input.repositoryNames } : {}),
        permissions: Object.fromEntries(
          Object.entries(input.permissions).filter((entry): entry is [string, 'read' | 'write'] => Boolean(entry[1])),
        ),
        // Our own cache below honours the 5-minute margin; never reuse the library cache.
        refresh: true,
      });
      const expiresAtMs = Date.parse(result.expiresAt);
      const entry: CachedToken = {
        token: result.token,
        expiresAt: result.expiresAt,
        expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 55 * 60_000,
      };
      state.tokens.set(key, entry);
      return entry;
    } catch (error) {
      throw tokenError(error);
    }
  })();

  state.pending.set(key, promise);
  try {
    const token = await promise;
    return { token: token.token, expiresAt: token.expiresAt };
  } finally {
    state.pending.delete(key);
  }
}

function tokenError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const status = githubErrorStatus(error);
  const raw = githubErrorMessage(error);
  if (status === 401) {
    return new AppError('UPSTREAM', "GitHub refuse la clé de l'application Nuera Dev.", {
      detail: 'La clé privée a peut-être été révoquée ou remplacée sur GitHub.',
      ...(raw ? { raw } : {}),
    });
  }
  if (status === 403 || status === 404) {
    return new AppError('FORBIDDEN', "L'accès de l'application GitHub a été retiré pour ce compte.", {
      detail: 'Installation supprimée ou suspendue sur GitHub.',
      ...(raw ? { raw } : {}),
    });
  }
  if (status === 422) {
    return new AppError('FORBIDDEN', "Ce dépôt ou ce droit n'est pas accordé à l'application GitHub.", {
      detail: "Ajoutez le dépôt à l'installation (« Gérer l'accès ») ou acceptez les nouveaux droits sur GitHub.",
      ...(raw ? { raw } : {}),
    });
  }
  return new AppError('UPSTREAM', "GitHub n'a pas délivré de jeton d'installation.", raw ? { raw } : {});
}

/** Drops every cached token (disconnect, key rotation, tests). */
export function clearGithubTokenCache(): void {
  state.tokens.clear();
  state.pending.clear();
}

/** Drops the cached tokens of one installation (after a 401/403 on that installation). */
export function invalidateInstallationTokens(installationId: number): void {
  for (const key of state.tokens.keys()) {
    if (key.startsWith(`${installationId}|`)) state.tokens.delete(key);
  }
}
