import 'server-only';
import { projects } from '@nuera/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getOctokitForProject, getOctokitForRepo, GITHUB_NOT_CONNECTED, REPO_READ_PERMISSIONS } from './access';
import { createOctokit, toGithubAppError } from './client';
import { fallbackTokenFor, githubWebUrl, parseFullName } from './config';
import { manageAccessUrl } from './installations';
import { listGithubSources, updateGithubSource, type StoredGithubSource } from './store';
import { getAppCredentials, mintInstallationToken } from './tokens';
import {
  repositoryApiSchema,
  type AccessibleRepo,
  type AccessibleReposAccount,
  type AccessibleReposResult,
  type AccessibleReposSource,
  type GithubBranch,
  type GithubProjectRef,
  type GithubRepoInfo,
  type GithubRepoRef,
  type RepositoryApi,
} from './types';

const MAX_PAGES = 20; // 2,000 repositories per installation: far beyond a personal setup.

type ClonedIndex = { byId: Map<number, AccessibleRepo['clonedProject']>; byName: Map<string, AccessibleRepo['clonedProject']> };

/** Projects of THIS space (« Déjà cloné »): another space's projects are never visible here. */
async function clonedIndex(spaceId: string): Promise<ClonedIndex> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      slug: projects.slug,
      githubRepoId: projects.githubRepoId,
      githubFullName: projects.githubFullName,
    })
    .from(projects)
    .where(and(eq(projects.spaceId, spaceId), isNull(projects.archivedAt)));
  const byId = new Map<number, AccessibleRepo['clonedProject']>();
  const byName = new Map<string, AccessibleRepo['clonedProject']>();
  for (const row of rows) {
    const project = { id: row.id, name: row.name, slug: row.slug };
    if (row.githubRepoId) byId.set(row.githubRepoId, project);
    byName.set(row.githubFullName.toLowerCase(), project);
  }
  return { byId, byName };
}

function toAccessibleRepo(
  repo: RepositoryApi,
  via: { installationId: number | null; sourceId: string | null; sourceLabel: string | null },
  cloned: ClonedIndex,
): AccessibleRepo {
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
    installationId: via.installationId,
    sourceId: via.sourceId,
    sourceLabel: via.sourceLabel,
    sources:
      via.sourceId && via.installationId !== null
        ? [{ sourceId: via.sourceId, sourceLabel: via.sourceLabel ?? '', installationId: via.installationId }]
        : [],
    clonedProject,
  };
}

const byRecentPush = (a: AccessibleRepo, b: AccessibleRepo) =>
  Date.parse(b.pushedAt ?? b.updatedAt ?? '1970-01-01') - Date.parse(a.pushedAt ?? a.updatedAt ?? '1970-01-01');

type AccountMeta = Omit<AccessibleReposAccount, 'count' | 'repos'>;

/** One group per account login (sources merged): largest first. */
function group(repos: AccessibleRepo[], accounts: Map<string, AccountMeta>): AccessibleReposAccount[] {
  const result = new Map<string, AccessibleReposAccount>();
  for (const repo of repos) {
    const key = repo.owner.toLowerCase();
    const meta: AccountMeta = accounts.get(key) ?? {
      login: repo.owner,
      type: repo.ownerType,
      installationId: repo.installationId,
      sourceId: repo.sourceId,
      sourceLabel: repo.sourceLabel,
      manageUrl: null,
    };
    const entry = result.get(key) ?? { ...meta, count: 0, repos: [] };
    entry.repos.push(repo);
    entry.count += 1;
    result.set(key, entry);
  }
  // Largest account first (« nuera-studio · 11 », then « ethanthedevelop · 1 »).
  return [...result.values()].sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
}

/** Repositories of the usable installations of one source (metadata-only tokens). */
async function listSourceRepos(
  source: StoredGithubSource,
  cloned: ClonedIndex,
): Promise<{ repos: AccessibleRepo[]; accounts: AccountMeta[]; counts: Map<number, number> }> {
  const usable = source.config.installations.filter(
    (item) => !item.suspendedAt && source.config.allowedAccountIds.includes(item.accountId),
  );
  const credentials = getAppCredentials(source);
  const repos: AccessibleRepo[] = [];
  const accounts: AccountMeta[] = [];
  const counts = new Map<number, number>();
  for (const installation of usable) {
    accounts.push({
      login: installation.accountLogin,
      type: installation.accountType,
      installationId: installation.id,
      sourceId: source.id,
      sourceLabel: source.label,
      manageUrl: installation.htmlUrl,
    });
    // Listing only needs metadata: the narrowest token possible.
    const { token } = await mintInstallationToken({ installationId: installation.id, permissions: { metadata: 'read' }, credentials });
    const octokit = createOctokit(token);
    let total = 0;
    // Counted per installation.
    let fetched = 0;
    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { data } = await octokit.request('GET /installation/repositories', { per_page: 100, page });
        const list = repositoryApiSchema.array().parse(data.repositories);
        total = data.total_count;
        fetched += list.length;
        repos.push(...list.map((repo) => toAccessibleRepo(repo, { installationId: installation.id, sourceId: source.id, sourceLabel: source.label }, cloned)));
        if (list.length < 100 || fetched >= total) break;
      }
    } catch (error) {
      throw toGithubAppError(error, `la liste des dépôts de ${installation.accountLogin}`);
    }
    counts.set(installation.id, total);
  }
  return { repos, accounts, counts };
}

/**
 * Repositories the space authorised (A1 « Choix du dépôt »), from every source of the space (oldest
 * first) — or GITHUB_FALLBACK_TOKEN for the space of the default server without source —, grouped by
 * account, one entry per repository id (`sources` lists every source that reaches it), with the
 * « Déjà cloné » flag of THIS space. A source that fails is reported in `failures`; CONFLICT only
 * when no source has a usable installation.
 */
export async function listAccessibleRepos(input: { spaceId: string; sourceId?: string | null }): Promise<AccessibleReposResult> {
  const fetchedAt = new Date().toISOString();
  const { sources: all } = await listGithubSources(input.spaceId);
  const cloned = await clonedIndex(input.spaceId);

  if (all.length > 0) {
    const sources = input.sourceId ? all.filter((source) => source.id === input.sourceId) : all;
    if (input.sourceId && sources.length === 0) throw new AppError('NOT_FOUND', 'Source GitHub introuvable.');
    const withInstallations = sources.filter((source) =>
      source.config.installations.some((item) => !item.suspendedAt && source.config.allowedAccountIds.includes(item.accountId)),
    );
    if (withInstallations.length === 0) {
      throw new AppError('CONFLICT', "L'application GitHub n'est installée sur aucun compte.", {
        detail: 'Installez-la depuis Intégrations pour choisir les dépôts accessibles.',
      });
    }
    const byId = new Map<number, AccessibleRepo>();
    const accounts = new Map<string, AccountMeta>();
    const listed: AccessibleReposSource[] = [];
    const failures: AccessibleReposResult['failures'] = [];
    let lastError: unknown = null;
    for (const source of withInstallations) {
      try {
        const result = await listSourceRepos(source, cloned);
        listed.push({ id: source.id, label: source.label, appSlug: source.config.slug, manageAccessUrl: manageAccessUrl(source.config.slug) });
        for (const account of result.accounts) {
          const key = account.login.toLowerCase();
          if (!accounts.has(key)) accounts.set(key, account);
        }
        for (const repo of result.repos) {
          const existing = byId.get(repo.id);
          if (!existing) byId.set(repo.id, repo);
          else if (!existing.sources.some((item) => item.sourceId === source.id)) existing.sources.push(...repo.sources);
        }
        await updateGithubSource({ spaceId: source.spaceId, sourceId: source.id }, (config) => ({
          ...config,
          installations: config.installations.map((item) =>
            result.counts.has(item.id) ? { ...item, repoCount: result.counts.get(item.id) ?? item.repoCount } : item,
          ),
          repoCount: [...result.counts.values()].reduce((sum, value) => sum + value, 0),
        })).catch(() => undefined);
      } catch (error) {
        lastError = error;
        failures.push({ sourceId: source.id, label: source.label, message: error instanceof AppError ? error.message : 'GitHub ne répond pas.' });
      }
    }
    // Every source failed: the error of the last one (as with a single source).
    if (listed.length === 0 && lastError) throw lastError;
    const sorted = [...byId.values()].sort(byRecentPush);
    return {
      total: sorted.length,
      accounts: group(sorted, accounts),
      repos: sorted,
      manageAccessUrl: listed.length === 1 && all.length === 1 ? listed[0]!.manageAccessUrl : null,
      sources: listed,
      failures,
      fetchedAt,
    };
  }

  const token = input.sourceId ? null : await fallbackTokenFor(input.spaceId);
  if (input.sourceId) throw new AppError('NOT_FOUND', 'Source GitHub introuvable.');
  if (token) {
    const octokit = createOctokit(token);
    try {
      const raw = await octokit.paginate('GET /user/repos', { per_page: 100, affiliation: 'owner,organization_member' });
      const list = repositoryApiSchema
        .array()
        .parse(raw)
        .map((repo) => toAccessibleRepo(repo, { installationId: null, sourceId: null, sourceLabel: null }, cloned));
      const sorted = list.sort(byRecentPush);
      return { total: sorted.length, accounts: group(sorted, new Map()), repos: sorted, manageAccessUrl: null, sources: [], failures: [], fetchedAt };
    } catch (error) {
      throw toGithubAppError(error, 'la liste des dépôts');
    }
  }

  throw new AppError('CONFLICT', GITHUB_NOT_CONNECTED);
}

function toRepoInfo(parsed: RepositoryApi): GithubRepoInfo {
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
}

/** A repository reference of a space, or the fields of a project row (its own source). */
export type RepoTarget = GithubRepoRef | GithubProjectRef;

function isProject(target: RepoTarget): target is GithubProjectRef {
  return 'githubFullName' in target;
}

function fullNameOf(target: RepoTarget): string {
  return isProject(target) ? target.githubFullName : target.fullName;
}

function octokitFor(target: RepoTarget, permissions: Parameters<typeof getOctokitForRepo>[1]) {
  return isProject(target) ? getOctokitForProject(target, permissions) : getOctokitForRepo(target, permissions);
}

export async function getRepo(target: RepoTarget): Promise<GithubRepoInfo> {
  const { owner, repo } = parseFullName(fullNameOf(target));
  const octokit = await octokitFor(target, { metadata: 'read' });
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
    return toRepoInfo(repositoryApiSchema.parse(data));
  } catch (error) {
    throw toGithubAppError(error, `la lecture du dépôt ${owner}/${repo}`);
  }
}

export async function listBranches(target: RepoTarget): Promise<GithubBranch[]> {
  const { owner, repo } = parseFullName(fullNameOf(target));
  const octokit = await octokitFor(target, REPO_READ_PERMISSIONS);
  try {
    const raw = await octokit.paginate('GET /repos/{owner}/{repo}/branches', { owner, repo, per_page: 100 });
    return raw.map((branch) => ({ name: branch.name, sha: branch.commit.sha, protected: Boolean(branch.protected) }));
  } catch (error) {
    throw toGithubAppError(error, `la liste des branches de ${owner}/${repo}`);
  }
}

const protectedCache = new Map<string, { at: number; names: string[] }>();
const PROTECTED_CACHE_MS = 60_000;

export interface ProtectedBranchesOptions {
  maxAgeMs?: number;
  listImpl?: (target: RepoTarget) => Promise<GithubBranch[]>;
}

/**
 * Branches the runner must refuse to push to: the default branch (always: it evolves by pull
 * request) plus the branches protected on GitHub. GitHub unreachable or the App without access →
 * the default branch alone (GitHub still enforces its own protection on the push itself).
 * `maxAgeMs: 0` reads GitHub again (a push), listings accept a minute-old answer. The cache is per
 * space and source: another space never reads this one's answer.
 *
 *   listProtectedBranches({ spaceId, sourceId, fullName, defaultBranch })
 *   listProtectedBranches(project, project.defaultBranch, { maxAgeMs: 0 })
 */
export async function listProtectedBranches(
  target: RepoTarget & { defaultBranch?: string | null },
  defaultBranchOrOptions?: string | ProtectedBranchesOptions,
  maybeOptions: ProtectedBranchesOptions = {},
): Promise<string[]> {
  const options = typeof defaultBranchOrOptions === 'object' ? defaultBranchOrOptions : maybeOptions;
  const defaultBranch = (typeof defaultBranchOrOptions === 'string' ? defaultBranchOrOptions : target.defaultBranch) || 'main';
  const sourceKey = (isProject(target) ? target.githubSourceId : target.sourceId) ?? 'auto';
  const key = `${target.spaceId}:${sourceKey}:${fullNameOf(target).toLowerCase()}`;
  const maxAge = options.maxAgeMs ?? PROTECTED_CACHE_MS;
  const cached = protectedCache.get(key);
  let names = cached && Date.now() - cached.at < maxAge ? cached.names : null;
  if (!names) {
    try {
      names = (await (options.listImpl ?? listBranches)(target)).filter((branch) => branch.protected).map((branch) => branch.name);
      protectedCache.set(key, { at: Date.now(), names });
    } catch {
      names = cached?.names ?? [];
    }
  }
  return [...new Set([defaultBranch, ...names])].slice(0, 50);
}
