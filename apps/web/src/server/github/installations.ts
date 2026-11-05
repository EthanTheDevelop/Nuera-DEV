import 'server-only';
import { AppError } from '@/server/errors';
import { createOctokit, githubErrorStatus, toGithubAppError } from './client';
import { githubWebUrl, parseFullName } from './config';
import { getStoredGithubApp, updateGithubApp, type StoredGithubApp } from './store';
import { createAppJwt, getAppCredentials, type AppCredentials } from './tokens';
import {
  installationApiSchema,
  type GithubConfig,
  type GithubInstallationRecord,
  type InstallationApi,
} from './types';

/** Lists the installations of the app (JWT). Every account, allow-listed or not. */
export async function fetchInstallations(credentials?: AppCredentials): Promise<InstallationApi[]> {
  const jwt = await createAppJwt(credentials ?? (await getAppCredentials()));
  const octokit = createOctokit(jwt);
  try {
    const raw = await octokit.paginate('GET /app/installations', { per_page: 100 });
    return installationApiSchema.array().parse(raw);
  } catch (error) {
    throw toGithubAppError(error, 'la liste des installations');
  }
}

/** One installation by id (JWT). Returns null on 404. */
export async function fetchInstallation(installationId: number, credentials?: AppCredentials): Promise<InstallationApi | null> {
  const jwt = await createAppJwt(credentials ?? (await getAppCredentials()));
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

/** Refreshes the recorded installations from GitHub (JWT) and stores them. */
export async function syncInstallations(): Promise<StoredGithubApp> {
  const stored = await getStoredGithubApp();
  if (!stored) throw new AppError('CONFLICT', "GitHub n'est pas connecté.");
  const installations = await fetchInstallations();
  return updateGithubApp((config) => {
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

/**
 * Installation that covers `owner/repo`: the recorded installation of the owner, otherwise a fresh
 * `GET /repos/{owner}/{repo}/installation` (JWT), accepted only for allow-listed accounts.
 */
export async function resolveInstallationForRepo(fullName: string): Promise<{ installation: GithubInstallationRecord; repo: string; owner: string }> {
  const { owner, repo } = parseFullName(fullName);
  const stored = await getStoredGithubApp();
  if (!stored) throw new AppError('CONFLICT', "GitHub n'est pas connecté : créez l'application GitHub depuis Intégrations.");
  const known = findInstallationForOwner(stored.config, owner);
  if (known) return { installation: known, repo, owner };

  const jwt = await createAppJwt();
  const octokit = createOctokit(jwt);
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/installation', { owner, repo });
    const installation = installationApiSchema.parse(data);
    if (!installation.account || !stored.config.allowedAccountIds.includes(installation.account.id)) {
      throw new AppError('FORBIDDEN', `Le compte ${owner} n'est pas autorisé dans Nuera Dev.`, {
        detail: "Installez l'application GitHub sur ce compte depuis Intégrations.",
      });
    }
    if (installation.suspended_at) {
      throw new AppError('FORBIDDEN', `L'installation GitHub du compte ${owner} est suspendue.`);
    }
    const record = toInstallationRecord(installation);
    await updateGithubApp((config) => ({
      ...config,
      installations: [...config.installations.filter((item) => item.id !== record.id), record],
    }));
    return { installation: record, repo, owner };
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
