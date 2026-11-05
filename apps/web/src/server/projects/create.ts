import 'server-only';
import { projects } from '@nuera/db/schema';
import { isValidBranchName, isValidRepoFullName, slugify } from '@nuera/shared/paths';
import { and, eq, isNull, like } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getGitAuthForRepo, getOctokitForRepo, getRepo, listAccessibleRepos, listBranches, parseFullName } from '@/server/github';
import { RunnerError, runner } from '@/server/runner/client';
import { audit } from '@/server/security/audit';
import { ProjectError } from './errors';
import { getProjectsDisk } from './list';
import { requireProjectRow } from './queries';
import type { AddReposResult, CreateProjectResult, DestinationView, ProjectCommands, RepoPreview } from './types';

type Actor = { id: string };

export const repoFullNameSchema = z
  .string()
  .trim()
  .refine(isValidRepoFullName, { message: 'dépôt GitHub invalide (propriétaire/dépôt)' });

const commandField = z
  .string()
  .trim()
  .max(1000)
  .transform((value) => (value === '' ? null : value))
  .nullable()
  .optional();

export const createProjectInputSchema = z.object({
  fullName: repoFullNameSchema,
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

// ---------------------------------------------------------------------------------------------
// A1 — repositories
// ---------------------------------------------------------------------------------------------

/**
 * A1 « Choix du dépôt »: repositories the GitHub App can read, grouped by account, with « Déjà
 * cloné ». GitHub not connected (or the app installed nowhere) is a STATE, not an error: the step
 * shows the T7-style call to action towards Intégrations.
 */
export async function listAddProjectRepos(): Promise<AddReposResult> {
  try {
    const result = await listAccessibleRepos();
    return {
      connected: true,
      total: result.total,
      accounts: result.accounts.map((account) => ({ login: account.login, count: account.count, manageUrl: account.manageUrl })),
      repos: result.repos.map((repo) => ({
        id: repo.id,
        fullName: repo.fullName,
        owner: repo.owner,
        name: repo.name,
        private: repo.private,
        language: repo.language,
        pushedAt: repo.pushedAt ?? repo.updatedAt,
        defaultBranch: repo.defaultBranch,
        archived: repo.archived,
        clonedProject: repo.clonedProject ? { id: repo.clonedProject.id, name: repo.clonedProject.name } : null,
      })),
      manageAccessUrl: result.manageAccessUrl,
    };
  } catch (error) {
    if (error instanceof AppError && error.code === 'CONFLICT') {
      return { connected: false, message: error.message, detail: error.detail ?? null };
    }
    throw error;
  }
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
 * Root of the repository through the GitHub contents API (read token): CLAUDE.md, lockfile and the
 * package.json scripts, with the same rules as the runner's post-clone inspection. Null when GitHub
 * does not serve it (the runner detects everything after the clone anyway).
 */
async function inspectRepository(fullName: string, ref: string): Promise<RepoPreview['inspection']> {
  const { owner, repo } = parseFullName(fullName);
  try {
    const octokit = await getOctokitForRepo(fullName);
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

async function existingProjectAt(path: string): Promise<DestinationView['existingProject']> {
  const [row] = await db
    .select({ id: projects.id, name: projects.name, archivedAt: projects.archivedAt })
    .from(projects)
    .where(eq(projects.path, path))
    .limit(1);
  return row ? { id: row.id, name: row.name, archived: row.archivedAt !== null } : null;
}

/** Destination check by the runner (never writes anything) + the Nuera project already there. */
export async function checkProjectDestination(input: z.input<typeof destinationCheckInputSchema>): Promise<DestinationView> {
  const parsed = destinationCheckInputSchema.parse(input);
  const check = await runner.checkDestination({ body: { path: parsed.path, ...(parsed.fullName ? { fullName: parsed.fullName } : {}) } });
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
    existingProject: check.exists ? await existingProjectAt(check.path) : null,
  };
}

/** Folder name proposed for a repository (`roux-conseil`), as the runner resolves it under its root. */
export function defaultFolderName(fullName: string): string {
  return slugify(parseFullName(fullName).repo) || 'projet';
}

/**
 * D03 « Configuration »: what the step shows about the chosen repository — branches, visibility,
 * language, size, CLAUDE.md and lockfile when GitHub serves the root, the default destination
 * (checked by the runner) and the free disk space. Each part degrades on its own.
 */
export async function getRepoPreview(fullName: string): Promise<RepoPreview> {
  const name = repoFullNameSchema.parse(fullName);
  const info = await getRepo(name);
  const [branches, sizeBytes, disk, destination] = await Promise.all([
    listBranches(name)
      .then((list) => list.map((branch) => branch.name))
      .catch(() => [info.defaultBranch]),
    repositorySize(name),
    getProjectsDisk(),
    checkProjectDestination({ path: defaultFolderName(name), fullName: name }).catch(() => null),
  ]);
  const inspection = await inspectRepository(name, info.defaultBranch);
  const sorted = [info.defaultBranch, ...branches.filter((branch) => branch !== info.defaultBranch).sort((a, b) => a.localeCompare(b))];
  return {
    fullName: info.fullName,
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

async function repositorySize(fullName: string): Promise<number | null> {
  const { owner, repo } = parseFullName(fullName);
  try {
    const octokit = await getOctokitForRepo(fullName, { metadata: 'read' });
    const { data } = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
    const size = (data as { size?: unknown }).size;
    // GitHub reports kilobytes.
    return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size * 1024 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// D03 « Cloner sur VPS-3 » → A2
// ---------------------------------------------------------------------------------------------

async function uniqueSlug(base: string): Promise<string> {
  const root = slugify(base) || 'projet';
  const rows = await db.select({ slug: projects.slug }).from(projects).where(like(projects.slug, `${root}%`));
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

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code ?? (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return code === '23505';
}

/** Starts the clone of an existing project row (create or retry). Throws with the runner reason. */
async function startClone(
  project: { id: string; githubFullName: string; path: string },
  options: { branch?: string | undefined; installDeps: boolean; installCommand?: string | null | undefined },
  actor: Actor,
): Promise<string> {
  const { extraHeader } = await getGitAuthForRepo(project.githubFullName, 'read');
  try {
    const started = await runner.cloneRepo({
      body: {
        projectId: project.id,
        fullName: project.githubFullName,
        ...(options.branch ? { branch: options.branch } : {}),
        destination: project.path,
        extraHeader,
        installDeps: options.installDeps,
        ...(options.installCommand ? { installCommand: options.installCommand } : {}),
        actorUserId: actor.id,
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
        existingProject: await existingProjectAt(data.path ?? project.path),
      });
    }
    throw error;
  }
}

/**
 * Creates the project row (status `cloning`, unique slug, path validated by the runner) then
 * starts `runner.cloneRepo` with a READ token of that repository only. Nothing is written when the
 * destination is not usable (A4: reason DESTINATION_NOT_EMPTY + suggestions); a runner refusal
 * removes the row again (nothing was cloned).
 */
export async function createProject(input: CreateProjectInput, actor: Actor): Promise<CreateProjectResult> {
  const parsed = createProjectInputSchema.parse(input);
  const info = await getRepo(parsed.fullName);

  const [tracked] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.githubFullName, info.fullName), isNull(projects.archivedAt)))
    .limit(1);
  if (tracked) {
    throw new ProjectError('CONFLICT', `${info.fullName} est déjà cloné sur VPS-3 (« ${tracked.name} »).`, {
      reason: 'ALREADY_TRACKED',
      untouched: "Rien n'a été cloné.",
      data: { existingProject: { id: tracked.id, name: tracked.name, archived: false } },
    });
  }

  const check = await checkProjectDestination({ path: parsed.destination, fullName: info.fullName });
  if (!check.available) throw destinationConflict(check);

  const branch = parsed.branch && parsed.branch !== info.defaultBranch ? parsed.branch : undefined;
  const commands = Object.fromEntries(Object.entries(parsed.commands).filter(([, value]) => typeof value === 'string' && value)) as ProjectCommands;
  const slug = await uniqueSlug(parseFullName(info.fullName).repo);

  let row: typeof projects.$inferSelect | undefined;
  try {
    [row] = await db
      .insert(projects)
      .values({
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
    if (isUniqueViolation(error)) throw destinationConflict({ ...check, available: false, existingProject: await existingProjectAt(check.path) });
    throw error;
  }
  if (!row) throw new AppError('INTERNAL');

  let operationId: string;
  try {
    operationId = await startClone(row, { branch, installDeps: parsed.installDeps, installCommand: commands.install }, actor);
  } catch (error) {
    // Nothing was cloned: the project must not stay in the list as « Clonage… ».
    await db.delete(projects).where(eq(projects.id, row.id)).catch(() => undefined);
    throw error;
  }

  await audit({
    action: 'project.created',
    summary: `projet ${parsed.name} ajouté : clonage de ${info.fullName}${branch ? ` (${branch})` : ''} dans ${check.path}`,
    targetType: 'project',
    targetId: row.id,
    metadata: { fullName: info.fullName, path: check.path, branch: branch ?? info.defaultBranch, installDeps: parsed.installDeps, operationId },
    actorUserId: actor.id,
  });
  return { projectId: row.id, operationId };
}

export const retryCloneInputSchema = z.object({
  /** A4 « Utiliser … »: another destination for the retry. */
  destination: z.string().trim().min(1).max(4096).optional(),
});

/**
 * Retries the clone of a project whose clone FAILED (status `error`: the runner left nothing on
 * disk), optionally into another folder. A project whose dependencies failed is `ready`: its
 * installation is re-run from the project page (« Lancer » Installation).
 */
export async function retryProjectClone(projectId: string, input: z.input<typeof retryCloneInputSchema>, actor: Actor): Promise<CreateProjectResult> {
  const parsed = retryCloneInputSchema.parse(input);
  const project = await requireProjectRow(projectId);
  if (project.archivedAt) throw new AppError('CONFLICT', 'Ce projet est archivé.');
  if (project.status === 'cloning') throw new AppError('CONFLICT', 'Le clonage de ce projet est déjà en cours.');
  if (project.status !== 'error') throw new AppError('CONFLICT', 'Ce projet est déjà cloné sur VPS-3.');
  const check = await checkProjectDestination({ path: parsed.destination ?? project.path, fullName: project.githubFullName });
  if (!check.available) throw destinationConflict(check);
  if (check.path !== project.path) {
    try {
      await db.update(projects).set({ path: check.path }).where(eq(projects.id, project.id));
    } catch (error) {
      if (isUniqueViolation(error)) throw destinationConflict({ ...check, available: false, existingProject: await existingProjectAt(check.path) });
      throw error;
    }
  }
  const operationId = await startClone(
    { id: project.id, githubFullName: project.githubFullName, path: check.path },
    {
      branch: project.currentBranch && project.currentBranch !== project.defaultBranch ? project.currentBranch : undefined,
      installDeps: project.options.installDeps,
      installCommand: project.commands.install,
    },
    actor,
  );
  await audit({
    action: 'project.clone_retried',
    summary: `nouveau clonage de ${project.githubFullName} pour ${project.name} dans ${check.path}`,
    targetType: 'project',
    targetId: project.id,
    metadata: { path: check.path, operationId },
    actorUserId: actor.id,
  });
  return { projectId: project.id, operationId };
}

/** A2 reopened (`?operation=`): the operation of a project's clone, null when the runner does not know it. */
export async function getCloneOperation(operationId: string) {
  try {
    return await runner.getOperation({ params: { operationId } });
  } catch (error) {
    if (error instanceof RunnerError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}
