import 'server-only';
import { AppError } from '@/server/errors';
import { createOctokit, githubErrorStatus, toGithubAppError } from './client';
import { githubWebUrl, parseFullName } from './config';
import { findGithubSource, listGithubSources, updateGithubSource, type GithubSourceScope, type StoredGithubSource } from './store';
import { createAppJwt, getAppCredentials, type AppCredentials } from './tokens';
import {
  installationApiSchema,
  type GithubConfig,
  type GithubInstallationRecord,
  type InstallationApi,
} from './types';

/** Lists the installations of one app (JWT). Every account, allow-listed or not. */
export async function fetchInstallations(credentials: AppCredentials): Promise<InstallationApi[]> {
  const jwt = await createAppJwt(credentials);
  const octokit = createOctokit(jwt);
  try {
    const raw = await octokit.paginate('GET /app/installations', { per_page: 100 });
    return installationApiSchema.array().parse(raw);
  } catch (error) {
    throw toGithubAppError(error, 'la liste des installations');
  }
}

/** One installation of one app, by id (JWT). Returns null on 404 (not an installation of this app). */
export async function fetchInstallation(installationId: number, credentials: AppCredentials): Promise<InstallationApi | null> {
  const jwt = await createAppJwt(credentials);
  const octokit = createOctokit(jwt);
  try {
    const { data } = await octokit.request('GET /app/installations/{installation_id}', { installation_id: installationId });
    return installationApiSchema.parse(data);
  } catch (error) {
    if (githubErrorStatus(error) === 404) return null;
    throw toGithubAppError(error, "la vérification de l'installation");
  }
}

export function toInstallationRecord(
  installation: InstallationApi,
  previous?: GithubInstallationRecord,
): GithubInstallationRecord {
  return {
    id: installation.id,
    accountId: installation.account?.id ?? 0,
    accountLogin: installation.account?.login ?? '',
    accountType: installation.account?.type ?? 'User',
    repositorySelection: installation.repository_selection ?? 'selected',
    permissions: installation.permissions ?? {},
    suspendedAt: installation.suspended_at ?? null,
    suspendedBy: installation.suspended_by?.login ?? null,
    htmlUrl: installation.html_url ?? null,
    repoCount: previous?.repoCount ?? null,
    lastSyncAt: new Date().toISOString(),
  };
}

/** Splits installations into allow-listed and ignored ones (research §2.2 « Ownership alternative »). */
export function partitionInstallations(config: GithubConfig, installations: InstallationApi[]) {
  const allowed = new Set(config.allowedAccountIds);
  const kept = installations.filter((item) => item.account && allowed.has(item.account.id));
  return { kept, ignored: installations.length - kept.length };
}

/** Refreshes the recorded installations of one source from GitHub (JWT) and stores them. */
export async function syncInstallations(scope: GithubSourceScope): Promise<StoredGithubSource> {
  const source = await findGithubSource(scope);
  if (!source) throw new AppError('CONFLICT', "GitHub n'est pas connecté.");
  const installations = await fetchInstallations(getAppCredentials(source));
  return updateGithubSource(scope, (config) => {
    const { kept, ignored } = partitionInstallations(config, installations);
    const previous = new Map(config.installations.map((item) => [item.id, item]));
    return {
      ...config,
      installations: kept.map((item) => toInstallationRecord(item, previous.get(item.id))),
      ignoredInstallations: ignored,
    };
  });
}

/** Usable installation (allow-listed, not suspended) that covers `owner`. */
export function findInstallationForOwner(config: GithubConfig, owner: string): GithubInstallationRecord | null {
  const login = owner.toLowerCase();
  return (
    config.installations.find(
      (item) => item.accountLogin.toLowerCase() === login && !item.suspendedAt && config.allowedAccountIds.includes(item.accountId),
    ) ?? null
  );
}

export interface ResolvedInstallation {
  source: StoredGithubSource;
  installation: GithubInstallationRecord;
  owner: string;
  repo: string;
}

/**
 * Installation of ONE source that covers `owner/repo`: the recorded installation of the owner,
 * otherwise a fresh `GET /repos/{owner}/{repo}/installation` (JWT of that app), accepted only for an
 * allow-listed account (then recorded).
 */
export async function resolveInstallationInSource(source: StoredGithubSource, fullName: string): Promise<ResolvedInstallation> {
  const { owner, repo } = parseFullName(fullName);
  const known = findInstallationForOwner(source.config, owner);
  if (known) return { source, installation: known, repo, owner };

  const jwt = await createAppJwt(getAppCredentials(source));
  const octokit = createOctokit(jwt);
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
    const installation = installationApiSchema.parse(data);
    if (!installation.account || !source.config.allowedAccountIds.includes(installation.account.id)) {
      throw new AppError('FORBIDDEN', `Le compte ${owner} n'est pas autorisé dans Nuera Dev.`, {
        detail: "Installez l'application GitHub sur ce compte depuis Intégrations.",
      });
    }
    if (installation.suspended_at) {
      throw new AppError('FORBIDDEN', `L'installation GitHub du compte ${owner} est suspendue.`);
    }
    const record = toInstallationRecord(installation);
    const updated = await updateGithubSource({ spaceId: source.spaceId, sourceId: source.id }, (config) => ({
      ...config,
      installations: [...config.installations.filter((item) => item.id !== record.id), record],
    }));
    return { source: updated, installation: record, repo, owner };
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (githubErrorStatus(error) === 404) {
      throw new AppError('FORBIDDEN', `Le dépôt ${owner}/${repo} n'est pas accessible à l'application GitHub de Nuera Dev.`, {
        detail: "Ajoutez-le à l'installation depuis « Gérer l'accès ».",
      });
    }
    throw toGithubAppError(error, "la recherche de l'installation du dépôt");
  }
}

export function notAccessibleInSpace(fullName: string): AppError {
  return new AppError('FORBIDDEN', `Le dépôt ${fullName} n'est accessible à aucune source GitHub de votre espace.`, {
    detail: "Ajoutez-le à une installation depuis « Gérer l'accès », ou connectez une autre source GitHub.",
  });
}

/**
 * Candidate installations of the space for `owner/repo`, in order: with `sourceId`, that source only
 * (NOT_FOUND for a source of another space); otherwise every source of the space, those with a
 * recorded installation of the owner first (oldest source first), then a JWT lookup in the others.
 * A single source keeps its historical errors; several sources answer « …accessible à aucune
 * source GitHub de votre espace. ».
 */
export async function resolveRepoInstallations(
  scope: { spaceId: string; sourceId?: string | null },
  fullName: string,
): Promise<ResolvedInstallation[]> {
  const { owner, repo } = parseFullName(fullName);
  let sources: StoredGithubSource[];
  if (scope.sourceId) {
    const source = await findGithubSource({ spaceId: scope.spaceId, sourceId: scope.sourceId });
    if (!source) throw new AppError('NOT_FOUND', 'Source GitHub introuvable.');
    sources = [source];
  } else {
    sources = (await listGithubSources(scope.spaceId)).sources;
  }
  if (sources.length === 0) {
    throw new AppError('CONFLICT', "GitHub n'est pas connecté : créez l'application GitHub depuis Intégrations.");
  }
  const recorded: ResolvedInstallation[] = [];
  for (const source of sources) {
    const installation = findInstallationForOwner(source.config, owner);
    if (installation) recorded.push({ source, installation, owner, repo });
  }
  if (recorded.length > 0) return recorded;
  if (sources.length === 1) return [await resolveInstallationInSource(sources[0]!, fullName)];
  for (const source of sources) {
    try {
      return [await resolveInstallationInSource(source, fullName)];
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'FORBIDDEN') throw error;
    }
  }
  throw notAccessibleInSpace(`${owner}/${repo}`);
}

/**
 * Source of the space that owns installation `installationId` (stateless setup redirect): asks
 * GitHub with the JWT of each source of the space (installation ids are unique on GitHub and an
 * app only sees its own installations). Never a source of another space.
 */
export async function findSourceForInstallation(input: { spaceId: string; installationId: number }): Promise<{ source: StoredGithubSource; installation: InstallationApi } | null> {
  const { sources } = await listGithubSources(input.spaceId);
  const recorded = sources.find((source) => source.config.installations.some((item) => item.id === input.installationId));
  const ordered = recorded ? [recorded, ...sources.filter((item) => item !== recorded)] : sources;
  for (const source of ordered) {
    let installation: InstallationApi | null;
    try {
      installation = await fetchInstallation(input.installationId, getAppCredentials(source));
    } catch {
      continue;
    }
    if (installation && (installation.app_id === undefined || installation.app_id === source.config.appId)) return { source, installation };
  }
  return null;
}

/** « Gérer l'accès » — the app's installation page lists every account with its « Configure » link. */
export function manageAccessUrl(slug: string): string {
  return `${githubWebUrl()}/apps/${encodeURIComponent(slug)}/installations/new`;
}

/** Install page of the app on a new account, with an optional signed `state`. */
export function installUrl(slug: string, state?: string): string {
  const url = new URL(`${githubWebUrl()}/apps/${encodeURIComponent(slug)}/installations/new`);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}
