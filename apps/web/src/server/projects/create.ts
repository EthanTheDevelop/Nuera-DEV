import 'server-only';
import { projects } from '@nuera/db/schema';
import { isValidBranchName, isValidRepoFullName, slugify } from '@nuera/shared/paths';
import { and, eq, isNull, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import {
  getGitAuthForProject,
  getGitAuthForRepo,
  getOctokitForRepo,
  getRepo,
  listAccessibleRepos,
  listBranches,
  parseFullName,
  resolveSourceForRepo,
} from '@/server/github';
import { RunnerError, type RunnerClient } from '@/server/runner/client';
import { requireEnvironment, type RequestContext } from '@/server/tenancy/context';
import { auditIn, ofSpace } from '@/server/tenancy/scope';
import { requireProject, type ProjectContext } from './access';
import { ProjectError } from './errors';
import { getProjectsDisk } from './list';
import type { AddRepoAccount, AddRepoItem, AddRepoSource, AddReposResult, CreateProjectResult, DestinationView, ProjectCommands, RepoPreview } from './types';

/*
 * Add flow (A1 → D03 → A2/A4) in the space of the request context, on ITS server: the repository
 * list and the « Déjà cloné » marks come from the space's GitHub sources and projects, the
 * destination is checked by the space's runner, slugs, paths and tracked repositories are unique
 * per server, and nothing in an answer ever names a project of another space.
 */

export const repoFullNameSchema = z
  .string()
  .trim()
  .refine(isValidRepoFullName, { message: 'dépôt GitHub invalide (propriétaire/dépôt)' });

/** Id of a GitHub source of the space (`?source=`, body `sourceId`). */
export const githubSourceIdSchema = z.uuid('source GitHub invalide');

const commandField = z
  .string()
  .trim()
  .max(1000)
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional();

export const createProjectInputSchema = z.object({
  fullName: repoFullNameSchema,
  /**
   * GitHub source to read and clone with, when the repository is reachable through several sources
   * of the space (D03 « Source GitHub »). Absent: the source GitHub resolves for the repository.
   */
  sourceId: githubSourceIdSchema.optional(),
  /** Branch to check out (default: the repository's default branch). */
  branch: z.string().trim().min(1).max(250).refine(isValidBranchName, { message: 'nom de branche invalide' }).optional(),
  name: z.string().trim().min(1, 'nom requis').max(120, '120 caractères au maximum'),
  /** Absolute path under the projects root, or relative to it. */
  destination: z.string().trim().min(1, 'destination requise').max(4096),
  installDeps: z.boolean().default(true),
  worktreePerSession: z.boolean().default(true),
  readClaudeMd: z.boolean().default(true),
  /** Commands confirmed (or typed) by the owner; empty = detected by the runner after the clone. */
  commands: z
    .object({ install: commandField, dev: commandField, build: commandField, test: commandField, lint: commandField })
    .partial()
    .default({}),
});
export type CreateProjectInput = z.input<typeof createProjectInputSchema>;

export const destinationCheckInputSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  fullName: repoFullNameSchema.optional(),
});

type SpaceContext = Pick<RequestContext, 'space'>;

/** GitHub address of a repository in the space, read through `sourceId` when given. */
function repoRef(ctx: SpaceContext, fullName: string, sourceId?: string | null) {
  return { spaceId: ctx.space.id, fullName, ...(sourceId ? { sourceId } : {}) };
}

// ---------------------------------------------------------------------------------------------
// A1 — repositories
// ---------------------------------------------------------------------------------------------

/** Non-archived projects of the space by repository (« Déjà cloné »), case-insensitive. */
async function trackedInSpace(ctx: SpaceContext): Promise<Map<string, { id: string; name: string }>> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, fullName: projects.githubFullName })
    .from(projects)
    .where(ofSpace(ctx, isNull(projects.archivedAt)));
  return new Map(rows.map((row) => [row.fullName.toLowerCase(), { id: row.id, name: row.name }]));
}

/**
 * A1 « Choix du dépôt »: repositories the GitHub sources of the space can read (one entry per
 * repository, with every source reaching it), grouped by account, with « Déjà cloné » for the
 * projects of THIS space. GitHub not connected (no source, or installed nowhere) is a STATE, not an
 * error: the step shows the T7-style call to action towards Intégrations. A source that could not
 * be listed is reported (`failures`) while the others still are.
 */
export async function listAddProjectRepos(ctx: SpaceContext): Promise<AddReposResult> {
  let result: Awaited<ReturnType<typeof listAccessibleRepos>>;
  try {
    result = await listAccessibleRepos({ spaceId: ctx.space.id });
  } catch (error) {
    if (error instanceof AppError && error.code === 'CONFLICT') {
      return { connected: false, message: error.message, detail: error.detail ?? null };
    }
    throw error;
  }
  const tracked = await trackedInSpace(ctx);

  const sources: AddRepoSource[] = result.sources.map((source) => ({ id: source.id, label: source.label }));
  const accounts: AddRepoAccount[] = result.accounts.map((account) => ({
    key: `${account.sourceId ?? ''}:${account.login.toLowerCase()}`,
    login: account.login,
    count: account.count,
    manageUrl: account.manageUrl,
    sourceId: account.sourceId ?? '',
    sourceLabel: account.sourceLabel ?? account.login,
  }));
  const repos: AddRepoItem[] = result.repos.map((repo) => {
    const via: AddRepoSource[] = [];
    for (const item of repo.sources) if (!via.some((known) => known.id === item.sourceId)) via.push({ id: item.sourceId, label: item.sourceLabel });
    return {
      id: repo.id,
      fullName: repo.fullName,
      owner: repo.owner,
      name: repo.name,
      private: repo.private,
      language: repo.language,
      pushedAt: repo.pushedAt ?? repo.updatedAt,
      defaultBranch: repo.defaultBranch,
      archived: repo.archived,
      clonedProject: tracked.get(repo.fullName.toLowerCase()) ?? null,
      sourceId: repo.sourceId,
      sources: via,
    };
  });
  return {
    connected: true,
    total: repos.length,
    sources,
    accounts,
    repos,
    manageAccessUrl: result.manageAccessUrl,
    failures: result.failures.map((failure) => ({ label: failure.label, message: failure.message })),
  };
}

// ---------------------------------------------------------------------------------------------
// D03 — preview of the chosen repository + destination
// ---------------------------------------------------------------------------------------------

const LOCKFILES: Array<{ file: string; manager: 'npm' | 'pnpm' | 'yarn' | 'bun'; install: string }> = [
  { file: 'pnpm-lock.yaml', manager: 'pnpm', install: 'pnpm install --frozen-lockfile' },
  { file: 'yarn.lock', manager: 'yarn', install: 'yarn install --frozen-lockfile' },
  { file: 'bun.lockb', manager: 'bun', install: 'bun install --frozen-lockfile' },
  { file: 'bun.lock', manager: 'bun', install: 'bun install --frozen-lockfile' },
  { file: 'package-lock.json', manager: 'npm', install: 'npm ci' },
  { file: 'npm-shrinkwrap.json', manager: 'npm', install: 'npm ci' },
];

/**
 * Root of the repository through the GitHub contents API (read token of the space's source):
 * CLAUDE.md, lockfile and the package.json scripts, with the same rules as the runner's post-clone
 * inspection. Null when GitHub does not serve it (the runner detects everything after the clone).
 */
async function inspectRepository(ctx: SpaceContext, fullName: string, sourceId: string | null, ref: string): Promise<RepoPreview['inspection']> {
  const { owner, repo } = parseFullName(fullName);
  try {
    const octokit = await getOctokitForRepo(repoRef(ctx, fullName, sourceId));
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path: '', ref });
    if (!Array.isArray(data)) return null;
    const files = new Set(data.filter((entry) => entry.type === 'file').map((entry) => entry.name));
    const claudeMd = files.has('CLAUDE.md');
    if (!files.has('package.json')) return { claudeMd, packageManager: null, lockfile: null, commands: {} };
    const lock = LOCKFILES.find((item) => files.has(item.file)) ?? null;
    const manager = lock?.manager ?? 'npm';
    let scripts: string[] = [];
    try {
      const { data: pkg } = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path: 'package.json', ref });
      if (!Array.isArray(pkg) && pkg.type === 'file' && 'content' in pkg && typeof pkg.content === 'string' && pkg.size < 512 * 1024) {
        const json = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8')) as { scripts?: Record<string, unknown> };
        scripts = Object.keys(json.scripts ?? {}).filter((key) => typeof json.scripts?.[key] === 'string');
      }
    } catch {
      scripts = [];
    }
    const cmd = (name: string) => (scripts.includes(name) ? `${manager} run ${name}` : null);
    const commands: ProjectCommands = {
      install: lock?.install ?? 'npm install',
      dev: cmd('dev') ?? cmd('start'),
      build: cmd('build'),
      test: cmd('test'),
      lint: cmd('lint'),
    };
    return { claudeMd, packageManager: manager, lockfile: lock?.file ?? null, commands };
  } catch {
    return null;
  }
}

/** Nuera project of THIS space registered at `path` on `environmentId` (A4 « Ouvrir le projet existant »). */
async function existingProjectAt(ctx: SpaceContext, environmentId: string, path: string): Promise<DestinationView['existingProject']> {
  const [row] = await db
    .select({ id: projects.id, name: projects.name, archivedAt: projects.archivedAt })
    .from(projects)
    .where(ofSpace(ctx, eq(projects.environmentId, environmentId), eq(projects.path, path)))
    .limit(1);
  return row ? { id: row.id, name: row.name, archived: row.archivedAt !== null } : null;
}

/** Destination check by `runner` (never writes anything) + the project of the space already there. */
async function checkDestinationOn(
  ctx: SpaceContext,
  server: { id: string; runner: RunnerClient },
  input: z.input<typeof destinationCheckInputSchema>,
): Promise<DestinationView> {
  const parsed = destinationCheckInputSchema.parse(input);
  // `spaceId` (lot P1): on a shared server, the account's own folder (`espaces/<space id>/`) unless it
  // is the server's first account — two accounts can then clone the same repository.
  const check = await server.runner.checkDestination({
    body: { path: parsed.path, spaceId: ctx.space.id, ...(parsed.fullName ? { fullName: parsed.fullName } : {}) },
  });
  return {
    path: check.path,
    available: check.available,
    exists: check.exists,
    empty: check.empty,
    fileCount: check.fileCount,
    suggestedPath: check.suggestedPath,
    existingClone: check.existingClone
      ? { fullName: check.existingClone.fullName, branch: check.existingClone.branch, sameRepository: check.existingClone.sameRepository }
      : null,
    existingProject: check.exists ? await existingProjectAt(ctx, server.id, check.path) : null,
  };
}

/**
 * D03 live check / A4, on the server of the space (CONFLICT NO_ENVIRONMENT when none is assigned).
 * `existingProject` only ever names a project of the space.
 */
export async function checkProjectDestination(
  ctx: Pick<RequestContext, 'space' | 'environment'>,
  input: z.input<typeof destinationCheckInputSchema>,
): Promise<DestinationView> {
  const { environment, runner } = requireEnvironment(ctx);
  return checkDestinationOn(ctx, { id: environment.id, runner }, input);
}

/** Folder name proposed for a repository (`roux-conseil`), as the runner resolves it under its root. */
export function defaultFolderName(fullName: string): string {
  return slugify(parseFullName(fullName).repo) || 'projet';
}

/**
 * D03 « Configuration »: what the step shows about the chosen repository — branches, visibility,
 * language, size, CLAUDE.md and lockfile when GitHub serves the root (through the space's source,
 * `sourceId` when the owner picked one), the default destination (checked by the space's runner)
 * and its free disk space. Each part degrades on its own.
 */
export async function getRepoPreview(ctx: Pick<RequestContext, 'space' | 'environment'>, fullName: string, sourceId?: string | null): Promise<RepoPreview> {
  const name = repoFullNameSchema.parse(fullName);
  const source = sourceId ? githubSourceIdSchema.parse(sourceId) : null;
  const info = await getRepo(repoRef(ctx, name, source));
  const resolved = source ?? (await resolveSourceForRepo({ spaceId: ctx.space.id, fullName: info.fullName }).catch(() => null))?.sourceId ?? null;
  const [branches, sizeBytes, disk, destination] = await Promise.all([
    listBranches(repoRef(ctx, name, resolved))
      .then((list) => list.map((branch) => branch.name))
      .catch(() => [info.defaultBranch]),
    repositorySize(ctx, name, resolved),
    getProjectsDisk(ctx),
    ctx.environment ? checkProjectDestination(ctx, { path: defaultFolderName(name), fullName: name }).catch(() => null) : Promise.resolve(null),
  ]);
  const inspection = await inspectRepository(ctx, name, resolved, info.defaultBranch);
  const sorted = [info.defaultBranch, ...branches.filter((branch) => branch !== info.defaultBranch).sort((a, b) => a.localeCompare(b))];
  return {
    fullName: info.fullName,
    sourceId: resolved,
    private: info.private,
    language: info.language,
    pushedAt: info.pushedAt,
    defaultBranch: info.defaultBranch,
    sizeBytes,
    branches: sorted,
    inspection,
    destination,
    disk: disk.disk,
  };
}

async function repositorySize(ctx: SpaceContext, fullName: string, sourceId: string | null): Promise<number | null> {
  const { owner, repo } = parseFullName(fullName);
  try {
    const octokit = await getOctokitForRepo(repoRef(ctx, fullName, sourceId), { metadata: 'read' });
    const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
    const size = (data as { size?: unknown }).size;
    // GitHub reports kilobytes.
    return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size * 1024 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// D03 « Cloner sur {serveur} » → A2
// ---------------------------------------------------------------------------------------------

/** Free slug on the server (`roux-conseil`, then `roux-conseil-2`…): unique per server only. */
async function uniqueSlug(environmentId: string, base: string): Promise<string> {
  const root = slugify(base) || 'projet';
  const rows = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(and(eq(projects.environmentId, environmentId), like(projects.slug, `${root}%`)));
  const taken = new Set(rows.map((row) => row.slug));
  if (!taken.has(root)) return root;
  for (let i = 2; i < 1000; i += 1) if (!taken.has(`${root}-${i}`)) return `${root}-${i}`;
  return `${root}-${Date.now().toString(36)}`;
}

function destinationConflict(check: DestinationView): ProjectError {
  const message = check.exists && !check.empty ? "Le dossier de destination n'est pas vide" : "Le dossier de destination n'est pas utilisable";
  return new ProjectError('CONFLICT', message, {
    reason: 'DESTINATION_NOT_EMPTY',
    untouched: "Rien n'a été écrasé.",
    data: {
      path: check.path,
      fileCount: check.fileCount,
      exists: check.exists,
      empty: check.empty,
      suggestedPath: check.suggestedPath,
      existingClone: check.existingClone,
      existingProject: check.existingProject,
    },
  });
}

/** « owner/repo est déjà cloné dans votre espace (« Projet »). » — only ever a project of the space. */
function alreadyTracked(fullName: string, project: { id: string; name: string }): ProjectError {
  return new ProjectError('CONFLICT', `${fullName} est déjà cloné dans votre espace (« ${project.name} »).`, {
    reason: 'ALREADY_TRACKED',
    untouched: "Rien n'a été cloné.",
    data: { existingProject: { id: project.id, name: project.name, archived: false } },
  });
}

/** Unique violation (23505) and the constraint it hit. */
function uniqueViolation(error: unknown): { constraint: string | null } | null {
  const candidates = [error, (error as { cause?: unknown } | null)?.cause];
  for (const candidate of candidates) {
    const value = candidate as { code?: unknown; constraint_name?: unknown; constraint?: unknown } | null | undefined;
    if (value?.code === '23505') {
      const constraint = typeof value.constraint_name === 'string' ? value.constraint_name : typeof value.constraint === 'string' ? value.constraint : null;
      return { constraint };
    }
  }
  return null;
}

/** Project of the space tracking `fullName` (not archived), if any. */
async function trackedProject(ctx: SpaceContext, fullName: string): Promise<{ id: string; name: string } | null> {
  const [row] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(ofSpace(ctx, isNull(projects.archivedAt), sql`lower(${projects.githubFullName}) = lower(${fullName})`))
    .limit(1);
  return row ?? null;
}

/** Starts the clone of an existing project row (create or retry). Throws with the runner reason. */
async function startClone(
  ctx: ProjectContext,
  server: { id: string; runner: RunnerClient },
  project: { id: string; githubFullName: string; path: string },
  extraHeader: string,
  options: { branch?: string | undefined; installDeps: boolean; installCommand?: string | null | undefined },
): Promise<string> {
  try {
    const started = await server.runner.cloneRepo({
      body: {
        projectId: project.id,
        fullName: project.githubFullName,
        ...(options.branch ? { branch: options.branch } : {}),
        destination: project.path,
        extraHeader,
        installDeps: options.installDeps,
        ...(options.installCommand ? { installCommand: options.installCommand } : {}),
        actorUserId: ctx.user.id,
      },
    });
    return started.operationId;
  } catch (error) {
    if (error instanceof RunnerError && error.reason === 'DESTINATION_NOT_EMPTY') {
      const data = (error.data ?? {}) as Partial<DestinationView>;
      throw destinationConflict({
        path: data.path ?? project.path,
        available: false,
        exists: data.exists ?? true,
        empty: data.empty ?? false,
        fileCount: data.fileCount ?? 0,
        suggestedPath: data.suggestedPath ?? null,
        existingClone: data.existingClone ?? null,
        existingProject: await existingProjectAt(ctx, server.id, data.path ?? project.path),
      });
    }
    throw error;
  }
}

/**
 * Creates the project row on the server of the space (status `cloning`, slug unique on that
 * server, path validated by its runner, GitHub source bound) then starts its `cloneRepo` with a
 * READ token of that repository only. Nothing is written when the repository is already tracked
 * in the space or the destination is not usable (A4: reason DESTINATION_NOT_EMPTY + suggestions);
 * a runner refusal removes the row again (nothing was cloned).
 */
export async function createProject(ctx: ProjectContext, input: CreateProjectInput): Promise<CreateProjectResult> {
  const parsed = createProjectInputSchema.parse(input);
  const { environment, runner } = requireEnvironment(ctx);
  const server = { id: environment.id, runner };
  const info = await getRepo(repoRef(ctx, parsed.fullName, parsed.sourceId));

  const tracked = await trackedProject(ctx, info.fullName);
  if (tracked) throw alreadyTracked(info.fullName, tracked);

  // The chosen source (checked in the space) or the first one reaching the repository.
  const binding = await resolveSourceForRepo(repoRef(ctx, info.fullName, parsed.sourceId));
  const sourceId = binding.sourceId;

  const check = await checkDestinationOn(ctx, server, { path: parsed.destination, fullName: info.fullName });
  if (!check.available) throw destinationConflict(check);

  const branch = parsed.branch && parsed.branch !== info.defaultBranch ? parsed.branch : undefined;
  const commands = Object.fromEntries(Object.entries(parsed.commands).filter(([, value]) => typeof value === 'string' && value)) as ProjectCommands;
  const slug = await uniqueSlug(environment.id, parseFullName(info.fullName).repo);

  let row: typeof projects.$inferSelect | undefined;
  try {
    [row] = await db
      .insert(projects)
      .values({
        spaceId: ctx.space.id,
        environmentId: environment.id,
        githubSourceId: sourceId,
        githubInstallationId: binding.installationId,
        createdByUserId: ctx.user.id,
        slug,
        name: parsed.name,
        description: info.description,
        githubFullName: info.fullName,
        githubRepoId: info.id,
        cloneUrl: info.cloneUrl,
        htmlUrl: info.htmlUrl,
        isPrivate: info.private,
        primaryLanguage: info.language,
        defaultBranch: info.defaultBranch,
        path: check.path,
        // Branch chosen in D03, kept for a retry; the runner writes the real one after the clone.
        currentBranch: branch ?? null,
        status: 'cloning',
        commands,
        options: { installDeps: parsed.installDeps, worktreePerSession: parsed.worktreePerSession, readClaudeMd: parsed.readClaudeMd },
      })
      .returning();
  } catch (error) {
    const violation = uniqueViolation(error);
    if (violation) {
      // Lost a race with a concurrent creation in the space (same repository or same folder).
      const again = violation.constraint === 'projects_environment_repo_active_idx' ? await trackedProject(ctx, info.fullName) : null;
      if (again) throw alreadyTracked(info.fullName, again);
      throw destinationConflict({ ...check, available: false, existingProject: await existingProjectAt(ctx, environment.id, check.path) });
    }
    throw error;
  }
  if (!row) throw new AppError('INTERNAL');

  let operationId: string;
  try {
    const { extraHeader } = await getGitAuthForRepo(repoRef(ctx, info.fullName, sourceId), 'read');
    operationId = await startClone(ctx, server, row, extraHeader, { branch, installDeps: parsed.installDeps, installCommand: commands.install });
  } catch (error) {
    // Nothing was cloned: the project must not stay in the list as « Clonage… ».
    await db.delete(projects).where(eq(projects.id, row.id)).catch(() => undefined);
    throw error;
  }

  await auditIn(ctx, {
    action: 'project.created',
    summary: `projet ${parsed.name} ajouté : clonage de ${info.fullName}${branch ? ` (${branch})` : ''} dans ${check.path}`,
    targetType: 'project',
    targetId: row.id,
    environmentId: environment.id,
    metadata: { fullName: info.fullName, path: check.path, branch: branch ?? info.defaultBranch, installDeps: parsed.installDeps, operationId, sourceId },
  });
  return { projectId: row.id, operationId };
}

export const retryCloneInputSchema = z.object({
  /** A4 « Utiliser … »: another destination for the retry. */
  destination: z.string().trim().min(1).max(4096).optional(),
});

/**
 * Retries the clone of a project whose clone FAILED (status `error`: the runner left nothing on
 * disk), on the project's own server, optionally into another folder. A project whose
 * dependencies failed is `ready`: its installation is re-run from the project page.
 */
export async function retryProjectClone(ctx: ProjectContext, projectId: string, input: z.input<typeof retryCloneInputSchema>): Promise<CreateProjectResult> {
  const parsed = retryCloneInputSchema.parse(input);
  const handle = await requireProject(ctx, projectId);
  const project = handle.row;
  if (project.archivedAt) throw new AppError('CONFLICT', 'Ce projet est archivé.');
  if (project.status === 'cloning') throw new AppError('CONFLICT', 'Le clonage de ce projet est déjà en cours.');
  if (project.status !== 'error') throw new AppError('CONFLICT', `Ce projet est déjà cloné sur ${handle.environment.name}.`);
  const server = { id: handle.environment.id, runner: handle.runner };
  const check = await checkDestinationOn(ctx, server, { path: parsed.destination ?? project.path, fullName: project.githubFullName });
  if (!check.available) throw destinationConflict(check);
  if (check.path !== project.path) {
    try {
      await db.update(projects).set({ path: check.path }).where(and(eq(projects.id, project.id), eq(projects.spaceId, ctx.space.id)));
    } catch (error) {
      if (uniqueViolation(error)) throw destinationConflict({ ...check, available: false, existingProject: await existingProjectAt(ctx, server.id, check.path) });
      throw error;
    }
  }
  const { extraHeader } = await getGitAuthForProject(project, 'read');
  const operationId = await startClone(ctx, server, { id: project.id, githubFullName: project.githubFullName, path: check.path }, extraHeader, {
    branch: project.currentBranch && project.currentBranch !== project.defaultBranch ? project.currentBranch : undefined,
    installDeps: project.options.installDeps,
    installCommand: project.commands.install,
  });
  await auditIn(ctx, {
    action: 'project.clone_retried',
    summary: `nouveau clonage de ${project.githubFullName} pour ${project.name} dans ${check.path}`,
    targetType: 'project',
    targetId: project.id,
    environmentId: server.id,
    metadata: { path: check.path, operationId },
  });
  return { projectId: project.id, operationId };
}
