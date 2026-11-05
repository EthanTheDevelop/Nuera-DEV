import 'server-only';
import { projects } from '@nuera/db/schema';
import { isNull } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getOctokitForRepo, getGithubMode, REPO_READ_PERMISSIONS } from './access';
import { createOctokit, toGithubAppError } from './client';
import { fallbackToken, githubWebUrl, parseFullName } from './config';
import { manageAccessUrl } from './installations';
import { getStoredGithubApp, updateGithubApp } from './store';
import { mintInstallationToken } from './tokens';
import {
  repositoryApiSchema,
  type AccessibleRepo,
  type AccessibleReposAccount,
  type AccessibleReposResult,
  type GithubBranch,
  type GithubRepoInfo,
  type RepositoryApi,
} from './types';

const MAX_PAGES = 20; // 2,000 repositories per installation: far beyond a personal setup.

type ClonedIndex = { byId: Map<number, AccessibleRepo['clonedProject']>; byName: Map<string, AccessibleRepo['clonedProject']> };

async function clonedIndex(): Promise<ClonedIndex> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      githubRepoId: projects.githubRepoId,
      githubFullName: projects.githubFullName,
    })
    .from(projects)
    .where(isNull(projects.archivedAt));
  const byId = new Map<number, AccessibleRepo['clonedProject']>();
  const byName = new Map<string, AccessibleRepo['clonedProject']>();
  for (const row of rows) {
    const project = { id: row.id, name: row.name, slug: row.slug };
    if (row.githubRepoId) byId.set(row.githubRepoId, project);
    byName.set(row.githubFullName.toLowerCase(), project);
  }
  return { byId, byName };
}

function toAccessibleRepo(repo: RepositoryApi, installationId: number | null, cloned: ClonedIndex): AccessibleRepo {
  // Match by id first: a repository can be renamed (research §2.6).
  const clonedProject = cloned.byId.get(repo.id) ?? cloned.byName.get(repo.full_name.toLowerCase()) ?? null;
  return {
    id: repo.id,
    fullName: repo.full_name,
    name: repo.name,
    owner: repo.owner.login,
    ownerType: repo.owner.type ?? 'User',
    private: repo.private,
    description: repo.description ?? null,
    language: repo.language ?? null,
    pushedAt: repo.pushed_at ?? null,
    updatedAt: repo.updated_at ?? null,
    defaultBranch: repo.default_branch ?? 'main',
    // Never a URL with credentials: git auth goes through the per-process extraheader.
    cloneUrl: repo.clone_url ?? `${githubWebUrl()}/${repo.full_name}.git`,
    htmlUrl: repo.html_url,
    archived: repo.archived ?? false,
    installationId,
    clonedProject,
  };
}

const byRecentPush = (a: AccessibleRepo, b: AccessibleRepo) =>
  Date.parse(b.pushedAt ?? b.updatedAt ?? '1970-01-01') - Date.parse(a.pushedAt ?? a.updatedAt ?? '1970-01-01');

function group(repos: AccessibleRepo[], accounts: Map<string, Omit<AccessibleReposAccount, 'count' | 'repos'>>): AccessibleReposAccount[] {
  const result = new Map<string, AccessibleReposAccount>();
  for (const repo of repos) {
    const key = repo.owner.toLowerCase();
    const meta = accounts.get(key) ?? { login: repo.owner, type: repo.ownerType, installationId: repo.installationId, manageUrl: null };
    const entry = result.get(key) ?? { ...meta, count: 0, repos: [] };
    entry.repos.push(repo);
    entry.count += 1;
    result.set(key, entry);
  }
  // Largest account first (« nuera-studio · 11 », then « ethanthedevelop · 1 »).
  return [...result.values()].sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
}

/**
 * Repositories the owner authorised (A1 « Choix du dépôt »), grouped by account, with the
 * « Déjà cloné » flag computed from the projects table.
 */
export async function listAccessibleRepos(): Promise<AccessibleReposResult> {
  const mode = await getGithubMode();
  const cloned = await clonedIndex();
  const fetchedAt = new Date().toISOString();

  if (mode === 'app') {
    const stored = (await getStoredGithubApp())!;
    const usable = stored.config.installations.filter(
      (item) => !item.suspendedAt && stored.config.allowedAccountIds.includes(item.accountId),
    );
    if (usable.length === 0) {
      throw new AppError('CONFLICT', "L'application GitHub n'est installée sur aucun compte.", {
        detail: 'Installez-la depuis Intégrations pour choisir les dépôts accessibles.',
      });
    }
    const repos: AccessibleRepo[] = [];
    const accounts = new Map<string, Omit<AccessibleReposAccount, 'count' | 'repos'>>();
    const counts = new Map<number, number>();
    for (const installation of usable) {
      accounts.set(installation.accountLogin.toLowerCase(), {
        login: installation.accountLogin,
        type: installation.accountType,
        installationId: installation.id,
        manageUrl: installation.htmlUrl,
      });
      // Listing only needs metadata: the narrowest token possible.
      const { token } = await mintInstallationToken({ installationId: installation.id, permissions: { metadata: 'read' } });
      const octokit = createOctokit(token);
      let total = 0;
      // Counted per installation: `repos` also holds the repositories of the previous accounts.
      let fetched = 0;
      try {
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const { data } = await octokit.request('GET /installation/repositories', { per_page: 100, page });
          const list = repositoryApiSchema.array().parse(data.repositories);
          total = data.total_count;
          fetched += list.length;
          repos.push(...list.map((repo) => toAccessibleRepo(repo, installation.id, cloned)));
          if (list.length < 100 || fetched >= total) break;
        }
      } catch (error) {
        throw toGithubAppError(error, `la liste des dépôts de ${installation.accountLogin}`);
      }
      counts.set(installation.id, total);
    }
    await updateGithubApp((config) => ({
      ...config,
      installations: config.installations.map((item) =>
        counts.has(item.id) ? { ...item, repoCount: counts.get(item.id) ?? item.repoCount } : item,
      ),
      repoCount: [...counts.values()].reduce((sum, value) => sum + value, 0),
    })).catch(() => undefined);
    const sorted = repos.sort(byRecentPush);
    return {
      total: sorted.length,
      accounts: group(sorted, accounts),
      repos: sorted,
      manageAccessUrl: manageAccessUrl(stored.config.slug),
      fetchedAt,
    };
  }

  if (mode === 'fallback_token') {
    const octokit = createOctokit(fallbackToken()!);
    try {
      const raw = await octokit.paginate('GET /user/repos', { per_page: 100, affiliation: 'owner,organization_member' });
      const list = repositoryApiSchema.array().parse(raw).map((repo) => toAccessibleRepo(repo, null, cloned));
      const sorted = list.sort(byRecentPush);
      return { total: sorted.length, accounts: group(sorted, new Map()), repos: sorted, manageAccessUrl: null, fetchedAt };
    } catch (error) {
      throw toGithubAppError(error, 'la liste des dépôts');
    }
  }

  throw new AppError('CONFLICT', "GitHub n'est pas connecté : créez l'application GitHub depuis Intégrations.");
}

export async function getRepo(fullName: string): Promise<GithubRepoInfo> {
  const { owner, repo } = parseFullName(fullName);
  const octokit = await getOctokitForRepo(fullName, { metadata: 'read' });
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
    const parsed = repositoryApiSchema.parse(data);
    return {
      id: parsed.id,
      fullName: parsed.full_name,
      name: parsed.name,
      owner: parsed.owner.login,
      private: parsed.private,
      description: parsed.description ?? null,
      language: parsed.language ?? null,
      defaultBranch: parsed.default_branch ?? 'main',
      htmlUrl: parsed.html_url,
      cloneUrl: parsed.clone_url ?? `${githubWebUrl()}/${parsed.full_name}.git`,
      pushedAt: parsed.pushed_at ?? null,
      archived: parsed.archived ?? false,
    };
  } catch (error) {
    throw toGithubAppError(error, `la lecture du dépôt ${owner}/${repo}`);
  }
}

export async function listBranches(fullName: string): Promise<GithubBranch[]> {
  const { owner, repo } = parseFullName(fullName);
  const octokit = await getOctokitForRepo(fullName, REPO_READ_PERMISSIONS);
  try {
    const raw = await octokit.paginate('GET /repos/{owner}/{repo}/branches', { owner, repo, per_page: 100 });
    return raw.map((branch) => ({ name: branch.name, sha: branch.commit.sha, protected: Boolean(branch.protected) }));
  } catch (error) {
    throw toGithubAppError(error, `la liste des branches de ${owner}/${repo}`);
  }
}
