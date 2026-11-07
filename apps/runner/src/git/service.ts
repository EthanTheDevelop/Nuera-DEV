import { readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import { projects, worktrees, type Database } from '@nuera/db';
import { isValidBranchName, worktreeNameFromBranch } from '@nuera/shared/paths';
import type {
  AheadBehind,
  Branch,
  ChangedFile,
  ChangesResponse,
  CommitResult,
  CommitSummary,
  FileDiff,
  GitIdentity,
  GitStatus,
  PullResult,
  PushResult,
  SyncStatus,
  WorktreeDto,
} from '@nuera/shared/runner';
import type { Logger } from 'pino';
import {
  ensurePrimaryWorktree,
  getProject,
  getReadyProject,
  getSessionRow,
  getWorktree,
  listActiveWorktrees,
  worktreeRowToDto,
  type ProjectRow,
  type WorktreeRow,
} from '../db/lookups';
import type { EnvironmentScope } from '../environment';
import { RunnerError } from '../errors';
import type { OperationService } from '../operations/service';
import type { PathGuard } from '../safety/paths';
import type { DiskUsage } from '../system/disk-usage';
import { GitCommandError, type Git } from './git';
import {
  additionDiff,
  changeLetter,
  parseNameStatusZ,
  parseNumstatZ,
  parsePushPorcelain,
  parseStatusV2,
  parseTrack,
  parseUnifiedDiff,
  parseWorktreeList,
} from './parse';

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DIFF_OUTPUT_CAP = 4 * 1024 * 1024;
const UNTRACKED_READ_CAP = 2 * 1024 * 1024;
/**
 * `changes()` counts the lines of untracked files within a budget: a huge untracked tree (build
 * output, vendored dependencies not ignored) must not be read file by file at every refresh.
 */
export const UNTRACKED_COUNT_BUDGET = { files: 400, bytes: 16 * 1024 * 1024, ms: 2_500 };

/** `:(literal)path` so that paths never act as glob magic. */
const literal = (p: string) => `:(literal)${p}`;

export interface GitServiceDeps {
  db: Database;
  /** Server of this runner: every project / worktree id is looked up within it. */
  environment: EnvironmentScope;
  git: Git;
  paths: PathGuard;
  ops: OperationService;
  logger: Logger;
  /** Live Claude session attached to a worktree (one at most). */
  liveSessionForWorktree: (worktreeId: string) => string | null;
  /** Project commands still running in a worktree (dev server, tests…). */
  liveRunsForWorktree?: (worktreeId: string) => number;
  /** Folder sizes (`?sizes=1`, clone removal). */
  diskUsage?: DiskUsage;
}

export interface ResolvedWorktree {
  project: ProjectRow;
  worktree: WorktreeRow;
  cwd: string;
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

export class GitService {
  /** Line-count budget of `changes()` for untracked files (tests lower it). */
  untrackedBudget = { ...UNTRACKED_COUNT_BUDGET };

  constructor(private readonly deps: GitServiceDeps) {}

  private get git() {
    return this.deps.git;
  }
  private get db() {
    return this.deps.db;
  }
  /** Id of this runner's server (throws while it does not serve). */
  private get envId(): string {
    return this.deps.environment.id;
  }

  // -------------------------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------------------------

  async projectCwd(project: ProjectRow): Promise<string> {
    const cwd = await this.deps.paths.confineProjectPath(project.path).catch((error: unknown) => {
      if (error instanceof RunnerError && error.code === 'NOT_FOUND') {
        throw new RunnerError('NOT_FOUND', 'Le dossier du projet est introuvable sur le serveur.', { reason: 'WORKTREE_MISSING' });
      }
      throw error;
    });
    return cwd;
  }

  async worktreeCwd(row: WorktreeRow): Promise<string> {
    try {
      const cwd = await this.deps.paths.confineProjectPath(row.path);
      // Back on disk (a volume mounted late, a folder restored): « missing » was only a moment.
      if (row.status === 'missing') {
        await this.db.update(worktrees).set({ status: 'active' }).where(and(eq(worktrees.id, row.id), eq(worktrees.status, 'missing')));
      }
      return cwd;
    } catch (error) {
      if (error instanceof RunnerError && error.code === 'NOT_FOUND') {
        if (row.status === 'active') {
          await this.db.update(worktrees).set({ status: 'missing' }).where(eq(worktrees.id, row.id));
        }
        throw new RunnerError('NOT_FOUND', `Le worktree ${row.name} est introuvable sur le disque.`, { reason: 'WORKTREE_MISSING' });
      }
      throw error;
    }
  }

  /** A session id recorded on an operation must be one of this server's sessions. */
  private async assertOwnSession(sessionId: string | null | undefined): Promise<void> {
    if (sessionId) await getSessionRow(this.db, this.envId, sessionId);
  }

  async resolveWorktree(worktreeId: string): Promise<ResolvedWorktree> {
    const worktree = await getWorktree(this.db, this.envId, worktreeId);
    const project = await getProject(this.db, this.envId, worktree.projectId);
    const cwd = await this.worktreeCwd(worktree);
    return { project, worktree, cwd };
  }

  /** Worktree of a project: the given one, or the primary clone. */
  async resolveProjectWorktree(projectId: string, worktreeId?: string): Promise<ResolvedWorktree> {
    if (worktreeId) {
      const resolved = await this.resolveWorktree(worktreeId);
      if (resolved.project.id !== projectId) throw new RunnerError('NOT_FOUND', 'Worktree introuvable pour ce projet.');
      return resolved;
    }
    const project = await getReadyProject(this.db, this.envId, projectId);
    const cwd = await this.projectCwd(project);
    const branch = await this.currentBranch(cwd);
    const worktree = await ensurePrimaryWorktree(this.db, project, branch);
    return { project, worktree, cwd };
  }

  // -------------------------------------------------------------------------------------------
  // Read helpers
  // -------------------------------------------------------------------------------------------

  async currentBranch(cwd: string): Promise<string | null> {
    return this.git.tryOutput(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
  }

  async headSha(cwd: string): Promise<string | null> {
    return this.git.tryOutput(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd });
  }

  async refExists(cwd: string, ref: string): Promise<boolean> {
    // A ref coming from a request must never be read as an option (`--output=…`).
    if (!ref || ref.startsWith('-')) return false;
    return (await this.git.tryOutput(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })) !== null;
  }

  async status(cwd: string): Promise<GitStatus> {
    const out = await this.git.output(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd, timeoutMs: 30_000 });
    return parseStatusV2(out);
  }

  async repoStatus(projectId: string, worktreeId?: string): Promise<GitStatus> {
    const { cwd } = await this.resolveProjectWorktree(projectId, worktreeId);
    return this.status(cwd);
  }

  async worktreeStatus(worktreeId: string): Promise<GitStatus> {
    const { cwd } = await this.resolveWorktree(worktreeId);
    return this.status(cwd);
  }

  /** `origin/<base>` when it exists, else the local branch; null when neither exists. */
  async resolveBaseRef(cwd: string, base: string): Promise<string | null> {
    if (await this.refExists(cwd, `refs/remotes/origin/${base}`)) return `refs/remotes/origin/${base}`;
    if (await this.refExists(cwd, `refs/heads/${base}`)) return `refs/heads/${base}`;
    if (await this.refExists(cwd, base)) return base;
    return null;
  }

  async countAheadBehind(cwd: string, base: string, head = 'HEAD'): Promise<{ ahead: number; behind: number }> {
    const out = await this.git.output(['rev-list', '--left-right', '--count', `${base}...${head}`], { cwd });
    const [behind, ahead] = out.split(/\s+/).map(Number);
    return { ahead: ahead ?? 0, behind: behind ?? 0 };
  }

  /** Upstream of the current branch (`branch.<b>.merge`), defaulting to `origin/<branch>`. */
  async upstreamRef(cwd: string, branch: string | null): Promise<{ name: string; ref: string } | null> {
    if (!branch) return null;
    const merge = await this.git.tryOutput(['config', '--get', `branch.${branch}.merge`], { cwd });
    const remoteBranch = merge?.startsWith('refs/heads/') ? merge.slice('refs/heads/'.length) : branch;
    const ref = `refs/remotes/origin/${remoteBranch}`;
    if (!(await this.refExists(cwd, ref))) return null;
    return { name: `origin/${remoteBranch}`, ref };
  }

  async syncStatusFor(project: ProjectRow, cwd: string): Promise<SyncStatus> {
    const [branch, status] = await Promise.all([this.currentBranch(cwd), this.status(cwd)]);
    const upstream = await this.upstreamRef(cwd, branch);
    let ahead = 0;
    let behind = 0;
    let state: SyncStatus['state'] = 'no_upstream';
    if (upstream && status.headSha) {
      ({ ahead, behind } = await this.countAheadBehind(cwd, upstream.ref));
      state = ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'up_to_date';
    }
    const head = status.headSha
      ? await this.git.tryOutput(['log', '-1', '--format=%H%x1f%s%x1f%cI', 'HEAD'], { cwd })
      : null;
    const [sha, message, date] = head ? head.split('\x1f') : [null, null, null];
    return {
      projectId: project.id,
      branch,
      upstream: upstream?.name ?? null,
      ahead,
      behind,
      state,
      lastFetchedAt: project.lastFetchedAt ? project.lastFetchedAt.toISOString() : null,
      headSha: sha ?? null,
      headMessage: message ?? null,
      headDate: date ?? null,
      dirtyFiles: status.files.filter((f) => f.kind !== 'ignored').length,
    };
  }

  async syncStatus(projectId: string): Promise<SyncStatus> {
    const project = await getReadyProject(this.db, this.envId, projectId);
    const cwd = await this.projectCwd(project);
    return this.syncStatusFor(project, cwd);
  }

  private async saveSync(project: ProjectRow, sync: SyncStatus, extra: Partial<typeof projects.$inferInsert> = {}): Promise<void> {
    await this.db
      .update(projects)
      .set({
        syncState: sync.state,
        aheadBy: sync.ahead,
        behindBy: sync.behind,
        currentBranch: sync.branch,
        lastCommitSha: sync.headSha,
        lastCommitMessage: sync.headMessage,
        lastCommitAt: sync.headDate ? new Date(sync.headDate) : null,
        ...extra,
      })
      .where(eq(projects.id, project.id));
  }

  // -------------------------------------------------------------------------------------------
  // Fetch / pull
  // -------------------------------------------------------------------------------------------

  private async fetchOrigin(project: ProjectRow, cwd: string, extraHeader: string | undefined): Promise<string> {
    const url = this.git.remoteUrl(project.githubFullName);
    const result = await this.git.run(['fetch', '--prune', '--no-tags', url, '+refs/heads/*:refs/remotes/origin/*'], {
      cwd,
      network: true,
      extraHeader,
      timeoutMs: 120_000,
    });
    return `${result.stdout}${result.stderr}`;
  }

  /** `git fetch` of the primary clone. `record: false` for the background scheduler. */
  async fetch(projectId: string, input: { extraHeader?: string; actorUserId?: string | null }, options: { record?: boolean } = {}) {
    const project = await getReadyProject(this.db, this.envId, projectId);
    const cwd = await this.projectCwd(project);
    const work = async () => {
      await this.fetchOrigin(project, cwd, input.extraHeader);
      const now = new Date();
      const sync = await this.syncStatusFor({ ...project, lastFetchedAt: now }, cwd);
      await this.saveSync(project, sync, { lastFetchedAt: now, statusDetail: null });
      return sync;
    };
    if (options.record === false) return { operationId: null, sync: await work() };
    const { operationId, value } = await this.deps.ops.run(
      { kind: 'fetch', projectId, title: `Récupération de ${project.githubFullName}`, actorUserId: input.actorUserId },
      async (op) => {
        op.appendLog([`$ git fetch ${this.git.remoteUrl(project.githubFullName)}`]);
        return work();
      },
      (sync) => ({ sync }),
    );
    return { operationId, sync: value };
  }

  async pull(
    projectId: string,
    input: { extraHeader?: string; mode: 'ff-only' | 'rebase' | 'merge'; identity?: GitIdentity; worktreeId?: string; actorUserId?: string | null },
  ): Promise<PullResult> {
    const { project, worktree, cwd } = await this.resolveProjectWorktree(projectId, input.worktreeId);
    const { operationId, value } = await this.deps.ops.run(
      { kind: 'pull', projectId, worktreeId: worktree.id, title: `Mise à jour de ${worktree.name}`, actorUserId: input.actorUserId },
      async (op) => {
        op.appendLog([`$ git fetch ${this.git.remoteUrl(project.githubFullName)}`]);
        await this.fetchOrigin(project, cwd, input.extraHeader);
        const branch = await this.currentBranch(cwd);
        if (!branch) throw new RunnerError('CONFLICT', "Le worktree n'est sur aucune branche (HEAD détachée).", { reason: 'NO_UPSTREAM' });
        const upstream = await this.upstreamRef(cwd, branch);
        if (!upstream) {
          throw new RunnerError('CONFLICT', `La branche ${branch} n'existe pas sur origin.`, {
            reason: 'NO_UPSTREAM',
            untouched: "Aucun fichier local n'a été modifié.",
          });
        }
        const before = await this.headSha(cwd);
        const { ahead, behind } = await this.countAheadBehind(cwd, upstream.ref);
        const status = await this.status(cwd);
        if (status.counts.conflicted > 0) {
          throw new RunnerError('CONFLICT', 'Le worktree contient des conflits non résolus.', { reason: 'PULL_CONFLICT' });
        }
        let outcome: PullResult['outcome'] = 'up_to_date';
        if (behind > 0) {
          if (ahead > 0 && input.mode === 'ff-only') {
            throw new RunnerError('CONFLICT', `${branch} et ${upstream.name} ont divergé : ${ahead} commit(s) locaux, ${behind} distant(s).`, {
              reason: 'PULL_DIVERGED',
              data: { ahead, behind, branch, upstream: upstream.name },
              untouched: "Aucun commit ni fichier local n'a été modifié.",
            });
          }
          if (input.mode !== 'ff-only' && ahead > 0 && !input.identity) {
            throw new RunnerError('VALIDATION', 'Une identité Git est requise pour fusionner ou rebaser.');
          }
          const args =
            ahead === 0 || input.mode === 'ff-only'
              ? ['merge', '--ff-only', upstream.ref]
              : input.mode === 'rebase'
                ? ['rebase', upstream.ref]
                : ['merge', '--no-edit', upstream.ref];
          op.appendLog([`$ git ${args.join(' ')}`]);
          const result = await this.git.run(args, { cwd, allowFailure: true, identity: input.identity, timeoutMs: 120_000 });
          if (result.exitCode !== 0) {
            const after = await this.status(cwd);
            const conflicted = after.files.filter((f) => f.conflicted).map((f) => f.path);
            if (conflicted.length > 0) {
              await this.git.run([args[0] === 'rebase' ? 'rebase' : 'merge', '--abort'], { cwd, allowFailure: true });
              throw new RunnerError('CONFLICT', `Conflit sur ${conflicted.length} fichier(s) : la mise à jour a été annulée.`, {
                reason: 'PULL_CONFLICT',
                data: { files: conflicted.slice(0, 50) },
                raw: `${result.stdout}\n${result.stderr}`.trim(),
                untouched: "Votre branche est revenue à son état d'avant la mise à jour.",
              });
            }
            throw new RunnerError('CONFLICT', 'Des modifications locales empêchent la mise à jour.', {
              reason: 'PULL_DIRTY',
              raw: `${result.stdout}\n${result.stderr}`.trim(),
              untouched: "Aucun fichier local n'a été modifié.",
            });
          }
          outcome = ahead === 0 || input.mode === 'ff-only' ? 'fast_forward' : input.mode === 'rebase' ? 'rebased' : 'merged';
        }
        const after = await this.headSha(cwd);
        const now = new Date();
        const sync = await this.syncStatusFor({ ...project, lastFetchedAt: now }, cwd);
        if (worktree.isPrimary) await this.saveSync(project, sync, { lastFetchedAt: now, lastSyncedAt: now, statusDetail: null });
        return { outcome, before, after, commits: behind, sync };
      },
      (r) => ({ outcome: r.outcome, before: r.before, after: r.after, commits: r.commits }),
    );
    return { operationId, ...value };
  }

  // -------------------------------------------------------------------------------------------
  // Branches & log
  // -------------------------------------------------------------------------------------------

  async branches(projectId: string, protectedCsv: string | undefined): Promise<{ defaultBranch: string; branches: Branch[] }> {
    const project = await getReadyProject(this.db, this.envId, projectId);
    const cwd = await this.projectCwd(project);
    const protectedSet = new Set(
      (protectedCsv ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    protectedSet.add(project.defaultBranch);
    const format = ['%(refname)', '%(objectname)', '%(subject)', '%(committerdate:iso-strict)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(HEAD)'].join('%1f');
    const out = await this.git.output(['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes'], { cwd });
    const defaultRef = (await this.resolveBaseRef(cwd, project.defaultBranch)) ?? 'HEAD';
    const mergedOut = await this.git.output(['for-each-ref', '--merged', defaultRef, '--format=%(refname)', 'refs/heads', 'refs/remotes'], { cwd });
    const merged = new Set(mergedOut.split(/\r?\n/).filter(Boolean));
    const rows = await listActiveWorktrees(this.db, project);
    const byBranch = new Map(rows.map((w) => [w.branch, w]));
    const branches: Branch[] = [];
    for (const line of out.split(/\r?\n/)) {
      if (!line) continue;
      const [refname = '', sha = '', subject = '', date = '', upstream = '', track = '', head = ''] = line.split('\x1f');
      let kind: Branch['kind'];
      let name: string;
      let remote: string | null = null;
      if (refname.startsWith('refs/heads/')) {
        kind = 'local';
        name = refname.slice('refs/heads/'.length);
      } else {
        const rest = refname.slice('refs/remotes/'.length);
        const slash = rest.indexOf('/');
        remote = slash === -1 ? rest : rest.slice(0, slash);
        name = slash === -1 ? rest : rest.slice(slash + 1);
        if (name === 'HEAD') continue;
        kind = 'remote';
      }
      const t = upstream ? parseTrack(track) : null;
      const wt = kind === 'local' ? byBranch.get(name) : undefined;
      branches.push({
        name,
        kind,
        remote,
        current: head === '*',
        headSha: sha,
        subject,
        committedAt: date || null,
        upstream: upstream || null,
        ahead: t ? t.ahead : null,
        behind: t ? t.behind : null,
        merged: merged.has(refname) && name !== project.defaultBranch,
        protected: protectedSet.has(name),
        isDefault: name === project.defaultBranch,
        worktreeId: wt?.id ?? null,
        worktreeName: wt?.name ?? null,
        sessionId: wt ? this.deps.liveSessionForWorktree(wt.id) : null,
      });
    }
    return { defaultBranch: project.defaultBranch, branches };
  }

  async createBranch(projectId: string, input: { name: string; from?: string; checkout: boolean; worktreeId?: string; actorUserId?: string | null }) {
    const { project, worktree, cwd } = await this.resolveProjectWorktree(projectId, input.worktreeId);
    const { operationId, value } = await this.deps.ops.run(
      { kind: 'branch_create', projectId, worktreeId: worktree.id, title: `Création de la branche ${input.name}`, actorUserId: input.actorUserId },
      async (op) => {
        if (await this.refExists(cwd, `refs/heads/${input.name}`)) {
          throw new RunnerError('CONFLICT', `La branche ${input.name} existe déjà.`, { reason: 'BRANCH_EXISTS' });
        }
        const start = input.from ?? project.defaultBranch;
        const startRef = (await this.resolveBaseRef(cwd, start)) ?? null;
        if (!startRef) throw new RunnerError('NOT_FOUND', `Point de départ introuvable : ${start}.`, { reason: 'BRANCH_NOT_FOUND' });
        op.appendLog([`$ git branch --no-track ${input.name} ${startRef}`]);
        await this.git.run(['branch', '--no-track', input.name, startRef], { cwd });
        if (input.checkout) {
          op.appendLog([`$ git switch ${input.name}`]);
          await this.switchBranch(cwd, input.name);
          await this.afterCheckout(project, worktree, input.name);
        }
        return { branch: input.name, headSha: await this.git.tryOutput(['rev-parse', `refs/heads/${input.name}`], { cwd }) };
      },
    );
    return { operationId, ...value };
  }

  private async switchBranch(cwd: string, branch: string): Promise<void> {
    const result = await this.git.run(['switch', branch], { cwd, allowFailure: true });
    if (result.exitCode !== 0) {
      const output = `${result.stderr}\n${result.stdout}`;
      if (/already (checked out|used by worktree)/i.test(output)) {
        throw new RunnerError('CONFLICT', `La branche ${branch} est déjà ouverte dans un autre worktree.`, { reason: 'WORKTREE_IN_USE', raw: output.trim() });
      }
      if (/would be overwritten|local changes/i.test(output)) {
        throw new RunnerError('CONFLICT', 'Des modifications non commitées empêchent de changer de branche.', {
          reason: 'WORKTREE_DIRTY',
          raw: output.trim(),
          untouched: "Aucun fichier n'a été modifié.",
        });
      }
      throw new GitCommandError(`Impossible de passer sur ${branch}.`, ['switch', branch], result);
    }
  }

  private async afterCheckout(project: ProjectRow, worktree: WorktreeRow, branch: string): Promise<void> {
    await this.db.update(worktrees).set({ branch, lastUsedAt: new Date() }).where(eq(worktrees.id, worktree.id));
    if (worktree.isPrimary) await this.db.update(projects).set({ currentBranch: branch }).where(eq(projects.id, project.id));
  }

  async checkout(projectId: string, input: { branch: string; worktreeId?: string; track: boolean; actorUserId?: string | null }) {
    const { project, worktree, cwd } = await this.resolveProjectWorktree(projectId, input.worktreeId);
    if (worktree.id && this.deps.liveSessionForWorktree(worktree.id)) {
      throw new RunnerError('CONFLICT', 'Une session Claude travaille dans ce worktree : arrêtez-la avant de changer de branche.', {
        reason: 'WORKTREE_IN_USE',
      });
    }
    const { operationId, value } = await this.deps.ops.run(
      { kind: 'checkout', projectId, worktreeId: worktree.id, title: `Passage sur ${input.branch}`, actorUserId: input.actorUserId },
      async (op) => {
        const local = await this.refExists(cwd, `refs/heads/${input.branch}`);
        if (!local) {
          const remote = `refs/remotes/origin/${input.branch}`;
          if (!input.track || !(await this.refExists(cwd, remote))) {
            throw new RunnerError('NOT_FOUND', `La branche ${input.branch} est introuvable.`, { reason: 'BRANCH_NOT_FOUND' });
          }
          op.appendLog([`$ git branch --track ${input.branch} origin/${input.branch}`]);
          await this.git.run(['branch', '--track', input.branch, remote], { cwd });
        }
        op.appendLog([`$ git switch ${input.branch}`]);
        await this.switchBranch(cwd, input.branch);
        await this.afterCheckout(project, worktree, input.branch);
        return { branch: input.branch, headSha: await this.headSha(cwd) };
      },
    );
    return { operationId, ...value };
  }

  async log(projectId: string, query: { n: number; ref?: string; worktreeId?: string }): Promise<{ commits: CommitSummary[] }> {
    const { cwd } = await this.resolveProjectWorktree(projectId, query.worktreeId);
    const ref = query.ref ?? 'HEAD';
    if (ref.startsWith('-')) throw new RunnerError('VALIDATION', 'Référence invalide.');
    if (!(await this.refExists(cwd, ref))) return { commits: [] };
    const out = await this.git.output(['log', `-n${query.n}`, '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e', ref, '--'], { cwd });
    const commits = out
      .split('\x1e')
      .map((record) => record.replace(/^\s+/, ''))
      .filter(Boolean)
      .map((record) => {
        const [sha = '', shortSha = '', authorName = '', authorEmail = '', authoredAt = '', subject = '', body = ''] = record.split('\x1f');
        return { sha, shortSha, authorName, authorEmail, authoredAt, subject, body: body.trim() };
      });
    return { commits };
  }

  // -------------------------------------------------------------------------------------------
  // Worktrees
  // -------------------------------------------------------------------------------------------

  async listWorktrees(projectId: string, options: { sizes?: boolean } = {}): Promise<{ worktrees: WorktreeDto[] }> {
    const project = await getReadyProject(this.db, this.envId, projectId);
    const primaryCwd = await this.projectCwd(project);
    await ensurePrimaryWorktree(this.db, project, await this.currentBranch(primaryCwd));
    const rows = await listActiveWorktrees(this.db, project);
    const listed = parseWorktreeList(await this.git.output(['worktree', 'list', '--porcelain'], { cwd: primaryCwd }));
    const result: WorktreeDto[] = [];
    for (const row of rows) {
      let live: Parameters<typeof worktreeRowToDto>[1] = {
        dirtyFiles: null,
        ahead: null,
        behind: null,
        liveSessionId: this.deps.liveSessionForWorktree(row.id),
      };
      const onDisk = existsSync(row.path) && (row.isPrimary || listed.some((l) => samePath(l.path, row.path)));
      let status = row.status;
      if (!onDisk && row.status === 'active') {
        status = 'missing';
        await this.db.update(worktrees).set({ status: 'missing' }).where(eq(worktrees.id, row.id));
      } else if (onDisk && row.status === 'missing') {
        status = 'active';
        await this.db.update(worktrees).set({ status: 'active' }).where(eq(worktrees.id, row.id));
      }
      if (onDisk) {
        try {
          const cwd = await this.deps.paths.confineProjectPath(row.path);
          const st = await this.status(cwd);
          const baseRef = await this.resolveBaseRef(cwd, row.baseBranch ?? project.defaultBranch);
          const ab = baseRef && st.headSha ? await this.countAheadBehind(cwd, baseRef) : null;
          live = { ...live, dirtyFiles: st.files.filter((f) => f.kind !== 'ignored').length, ahead: ab?.ahead ?? null, behind: ab?.behind ?? null };
          if (st.branch && st.branch !== row.branch) {
            await this.db.update(worktrees).set({ branch: st.branch }).where(eq(worktrees.id, row.id));
            row.branch = st.branch;
          }
        } catch (error) {
          this.deps.logger.debug({ err: error, worktreeId: row.id }, 'état du worktree illisible');
        }
      }
      const dto = worktreeRowToDto({ ...row, status }, live);
      result.push(options.sizes ? { ...dto, sizeBytes: onDisk ? await this.folderSize(row.path) : null } : dto);
    }
    return { worktrees: result };
  }

  /** Disk space of a confined folder, null when unknown (budget spent, unreadable, no meter). */
  private async folderSize(folder: string): Promise<number | null> {
    if (!this.deps.diskUsage) return null;
    try {
      return await this.deps.diskUsage.measure(await this.deps.paths.confineProjectPath(folder));
    } catch {
      return null;
    }
  }

  /**
   * Deletes the primary clone of a project and the folders of its worktrees (T8 « Supprimer aussi le
   * clone de VPS-3 »). Only work that also exists elsewhere may go: refused while a session or a
   * command runs, and when the server holds the only copy of something (uncommitted or untracked
   * files, a stash, commits reachable from a local branch but from no remote-tracking ref).
   * Paths are confined to the projects root (never the root itself). The project row stays.
   */
  async removeClone(projectId: string, input: { actorUserId?: string | null } = {}) {
    const project = await getProject(this.db, this.envId, projectId);
    const rows = await this.db.select().from(worktrees).where(and(eq(worktrees.projectId, project.id), isNull(worktrees.removedAt)));
    for (const row of rows) {
      if (this.deps.liveSessionForWorktree(row.id)) {
        throw new RunnerError('CONFLICT', "Une session Claude tourne encore dans ce projet : arrêtez-la d'abord.", {
          reason: 'WORKTREE_IN_USE',
          untouched: "Rien n'a été supprimé du disque.",
        });
      }
      if ((this.deps.liveRunsForWorktree?.(row.id) ?? 0) > 0) {
        throw new RunnerError('CONFLICT', "Une commande du projet tourne encore : arrêtez-la d'abord.", {
          reason: 'RUN_IN_PROGRESS',
          untouched: "Rien n'a été supprimé du disque.",
        });
      }
    }
    const primaryPath = path.resolve(project.path);
    const present = existsSync(primaryPath);
    const primary = present ? await this.deps.paths.confineProjectPath(primaryPath) : null;
    if (primary && samePath(primary, this.deps.paths.projectsRoot)) {
      throw new RunnerError('VALIDATION', 'Le dossier des projets lui-même ne peut pas être supprimé.', { untouched: "Rien n'a été supprimé du disque." });
    }
    // Every folder to delete, confined first: nothing is removed if one of them escapes the root.
    const folders: Array<{ row: WorktreeRow | null; dir: string }> = primary ? [{ row: rows.find((r) => r.isPrimary) ?? null, dir: primary }] : [];
    for (const row of rows) {
      if (row.isPrimary || !existsSync(row.path)) continue;
      const dir = await this.deps.paths.confineProjectPath(row.path);
      if (samePath(dir, this.deps.paths.projectsRoot)) continue;
      folders.push({ row, dir });
    }
    for (const { row, dir } of folders) {
      const st = await this.status(dir).catch(() => null);
      const name = row?.name ?? project.slug;
      if (!st) {
        throw new RunnerError('CONFLICT', `L'état Git de ${name} est illisible : le clone n'a pas été supprimé.`, {
          reason: 'CLONE_UNREADABLE',
          untouched: "Rien n'a été supprimé du disque.",
        });
      }
      const dirty = st.files.filter((f) => f.kind !== 'ignored');
      if (dirty.length > 0) {
        throw new RunnerError('CONFLICT', `${name} contient ${dirty.length} fichier(s) non commité(s) : ils n'existent que sur le serveur.`, {
          reason: 'CLONE_DIRTY',
          data: { worktree: name, files: dirty.slice(0, 50).map((f) => f.path), count: dirty.length },
          untouched: "Rien n'a été supprimé du disque.",
        });
      }
    }
    if (primary) {
      const unpushed = (await this.git.output(['log', '--branches', '--not', '--remotes', '--format=%h %s', '-n', '20'], { cwd: primary })).trim();
      if (unpushed) {
        const lines = unpushed.split(/\r?\n/);
        throw new RunnerError('CONFLICT', `${lines.length >= 20 ? '20 commits ou plus' : `${lines.length} commit(s)`} n'existe(nt) que sur le serveur : poussez-les d'abord.`, {
          reason: 'CLONE_UNPUSHED',
          data: { commits: lines },
          untouched: "Rien n'a été supprimé du disque.",
        });
      }
      if (await this.refExists(primary, 'refs/stash')) {
        throw new RunnerError('CONFLICT', "Le clone garde des modifications mises de côté (git stash) : récupérez-les d'abord.", {
          reason: 'CLONE_DIRTY',
          untouched: "Rien n'a été supprimé du disque.",
        });
      }
    }
    let freedBytes: number | null = 0;
    for (const { dir } of folders) {
      const size = this.deps.diskUsage ? await this.deps.diskUsage.measure(dir, { fresh: true }) : null;
      freedBytes = freedBytes === null || size === null ? null : freedBytes + size;
    }
    const { operationId, value } = await this.deps.ops.run(
      { kind: 'clone_remove', projectId: project.id, title: `Suppression du clone de ${project.name}`, actorUserId: input.actorUserId },
      async (op) => {
        // Worktrees first (their .git file points into the primary clone), then the clone itself.
        for (const { dir } of folders.toReversed()) {
          op.appendLog([`Suppression de ${dir}`]);
          await rm(dir, { recursive: true, force: true, maxRetries: 3 });
          this.deps.diskUsage?.forget(dir);
          // `.worktrees/<slug>` once empty
          await rmdir(path.dirname(dir)).catch(() => undefined);
        }
        const now = new Date();
        await this.db.update(worktrees).set({ status: 'removed', removedAt: now }).where(and(eq(worktrees.projectId, project.id), isNull(worktrees.removedAt)));
        await this.db.update(projects).set({ status: 'error', statusDetail: 'Clone supprimé du serveur.' }).where(eq(projects.id, project.id));
        return { removed: folders.length > 0, freedBytes: folders.length > 0 ? freedBytes : 0, worktrees: folders.filter((f) => f.row && !f.row.isPrimary).length };
      },
      (r) => ({ ...r }),
    );
    return { operationId, ...value };
  }

  /** `git worktree add` under <projectsRoot>/.worktrees/<slug>/<name> + worktrees row. */
  async createWorktree(
    projectId: string,
    input: { name?: string; branch: string; base?: string; actorUserId?: string | null },
    options: { sessionId?: string | null } = {},
  ): Promise<WorktreeRow> {
    const project = await getReadyProject(this.db, this.envId, projectId);
    await this.deps.environment.assertCanStartWork();
    const primaryCwd = await this.projectCwd(project);
    if (!isValidBranchName(input.branch)) throw new RunnerError('VALIDATION', 'Nom de branche invalide.');
    const existing = await listActiveWorktrees(this.db, project);
    const baseName = input.name ?? worktreeNameFromBranch(input.branch);
    let name = baseName;
    for (let i = 2; existing.some((w) => w.name === name) || name === project.slug; i += 1) name = `${baseName}-${i}`;
    if (existing.some((w) => w.branch === input.branch)) {
      throw new RunnerError('CONFLICT', `La branche ${input.branch} est déjà ouverte dans un worktree.`, { reason: 'WORKTREE_IN_USE' });
    }
    const target = await this.deps.paths.resolveDestination(`.worktrees/${project.slug}/${name}`);
    if (existsSync(target)) {
      throw new RunnerError('CONFLICT', `Le dossier ${target} existe déjà.`, { reason: 'DESTINATION_NOT_EMPTY', untouched: "Rien n'a été écrasé." });
    }
    const base = input.base ?? project.defaultBranch;
    const { value } = await this.deps.ops.run(
      {
        kind: 'worktree_create',
        projectId: project.id,
        sessionId: options.sessionId ?? null,
        title: `Worktree ${name}`,
        actorUserId: input.actorUserId,
      },
      async (op) => {
        let args: string[];
        if (await this.refExists(primaryCwd, `refs/heads/${input.branch}`)) {
          args = ['worktree', 'add', target, input.branch];
        } else if (await this.refExists(primaryCwd, `refs/remotes/origin/${input.branch}`)) {
          args = ['worktree', 'add', '--track', '-b', input.branch, target, `refs/remotes/origin/${input.branch}`];
        } else {
          const startRef = await this.resolveBaseRef(primaryCwd, base);
          if (!startRef) throw new RunnerError('NOT_FOUND', `Branche de départ introuvable : ${base}.`, { reason: 'BRANCH_NOT_FOUND' });
          args = ['worktree', 'add', '--no-track', '-b', input.branch, target, startRef];
        }
        op.appendLog([`$ git ${args.join(' ')}`]);
        const result = await this.git.run(args, { cwd: primaryCwd, allowFailure: true, timeoutMs: 120_000 });
        if (result.exitCode !== 0) {
          const output = `${result.stderr}\n${result.stdout}`;
          if (/already (checked out|used by worktree)/i.test(output)) {
            throw new RunnerError('CONFLICT', `La branche ${input.branch} est déjà ouverte dans un autre worktree.`, { reason: 'WORKTREE_IN_USE', raw: output.trim() });
          }
          throw new GitCommandError('Création du worktree impossible.', args, result);
        }
        const [row] = await this.db
          .insert(worktrees)
          .values({
            projectId: project.id,
            environmentId: project.environmentId,
            name,
            branch: input.branch,
            baseBranch: base,
            path: target,
            isPrimary: false,
            status: 'active',
            lastUsedAt: new Date(),
          })
          .returning();
        if (!row) throw new RunnerError('INTERNAL', 'Worktree non enregistré.');
        return row;
      },
      (row) => ({ worktreeId: row.id, name: row.name, branch: row.branch, path: row.path }),
    );
    return value;
  }

  /**
   * Worktree for a session whose own was removed (« Reprendre », never a dead end): the previous row
   * is closed (`removed`, its stale Git entry pruned), then a worktree already open on the branch is
   * reused (no live session in it), else one is created on the branch — local, else the remote one
   * (`origin/<branch>`), else a new branch from the project's default branch (`origin: 'default'`).
   */
  async restoreWorktree(
    projectId: string,
    input: { branch: string; name?: string; previousId: string | null; actorUserId?: string | null; sessionId?: string | null },
  ): Promise<{ worktree: WorktreeRow; cwd: string; origin: 'existing' | 'local' | 'remote' | 'default'; base: string }> {
    const project = await getReadyProject(this.db, this.envId, projectId);
    const primaryCwd = await this.projectCwd(project);
    const base = project.defaultBranch;
    if (input.previousId) {
      await this.db
        .update(worktrees)
        .set({ status: 'removed', removedAt: new Date() })
        .where(and(eq(worktrees.id, input.previousId), eq(worktrees.environmentId, this.envId), isNull(worktrees.removedAt)));
    }
    await this.git.run(['worktree', 'prune'], { cwd: primaryCwd, allowFailure: true });
    if (!isValidBranchName(input.branch)) throw new RunnerError('VALIDATION', 'Nom de branche invalide.');
    for (const row of await listActiveWorktrees(this.db, project)) {
      if (row.branch !== input.branch) continue;
      if (row.isPrimary || existsSync(row.path)) {
        if (this.deps.liveSessionForWorktree(row.id)) {
          throw new RunnerError('CONFLICT', `Une session tourne déjà sur la branche ${input.branch} : arrêtez-la avant de reprendre celle-ci.`, { reason: 'WORKTREE_IN_USE' });
        }
        const cwd = await this.worktreeCwd(row);
        return { worktree: row, cwd, origin: 'existing', base };
      }
      // A row whose folder is gone: closed, its branch can be checked out again.
      await this.db.update(worktrees).set({ status: 'removed', removedAt: new Date() }).where(eq(worktrees.id, row.id));
    }
    // The primary clone checked out on that branch (no row yet for it).
    if ((await this.currentBranch(primaryCwd)) === input.branch) {
      const resolved = await this.resolveProjectWorktree(project.id);
      if (this.deps.liveSessionForWorktree(resolved.worktree.id)) {
        throw new RunnerError('CONFLICT', `Une session tourne déjà sur la branche ${input.branch} : arrêtez-la avant de reprendre celle-ci.`, { reason: 'WORKTREE_IN_USE' });
      }
      return { worktree: resolved.worktree, cwd: resolved.cwd, origin: 'existing', base };
    }
    const origin = (await this.refExists(primaryCwd, `refs/heads/${input.branch}`))
      ? 'local'
      : (await this.refExists(primaryCwd, `refs/remotes/origin/${input.branch}`))
        ? 'remote'
        : 'default';
    const worktree = await this.createWorktree(
      project.id,
      { ...(input.name ? { name: input.name } : {}), branch: input.branch, base, actorUserId: input.actorUserId ?? null },
      { sessionId: input.sessionId ?? null },
    );
    const cwd = await this.worktreeCwd(worktree);
    return { worktree, cwd, origin, base };
  }

  async worktreeDto(row: WorktreeRow): Promise<WorktreeDto> {
    return worktreeRowToDto(row, { dirtyFiles: 0, ahead: 0, behind: 0, liveSessionId: this.deps.liveSessionForWorktree(row.id) });
  }

  async removeWorktree(worktreeId: string, input: { force: boolean; deleteBranch: boolean; actorUserId?: string | null }) {
    const row = await getWorktree(this.db, this.envId, worktreeId);
    if (row.isPrimary) throw new RunnerError('VALIDATION', 'Le clone principal ne peut pas être supprimé ici.');
    if (this.deps.liveSessionForWorktree(row.id)) {
      throw new RunnerError('CONFLICT', "Une session Claude utilise ce worktree : arrêtez-la d'abord.", { reason: 'WORKTREE_IN_USE' });
    }
    const project = await getProject(this.db, this.envId, row.projectId);
    const primaryCwd = await this.projectCwd(project);
    const { operationId, value } = await this.deps.ops.run(
      { kind: 'worktree_remove', projectId: project.id, worktreeId: row.id, title: `Suppression du worktree ${row.name}`, actorUserId: input.actorUserId },
      async (op) => {
        const present = existsSync(row.path);
        if (present) {
          const cwd = await this.deps.paths.confineProjectPath(row.path);
          const st = await this.status(cwd);
          const dirty = st.files.filter((f) => f.kind !== 'ignored');
          if (dirty.length > 0 && !input.force) {
            throw new RunnerError('CONFLICT', `${row.name} contient ${dirty.length} fichier(s) non commité(s).`, {
              reason: 'WORKTREE_DIRTY',
              data: { files: dirty.slice(0, 50).map((f) => f.path), count: dirty.length },
              untouched: 'Le worktree et ses fichiers sont intacts.',
            });
          }
          const args = ['worktree', 'remove', ...(input.force ? ['--force'] : []), cwd];
          op.appendLog([`$ git ${args.join(' ')}`]);
          await this.git.run(args, { cwd: primaryCwd, timeoutMs: 60_000 });
        }
        await this.git.run(['worktree', 'prune'], { cwd: primaryCwd, allowFailure: true });
        let branchDeleted = false;
        if (input.deleteBranch && row.branch !== project.defaultBranch) {
          const del = await this.git.run(['branch', '-d', row.branch], { cwd: primaryCwd, allowFailure: true });
          branchDeleted = del.exitCode === 0;
          op.appendLog([`$ git branch -d ${row.branch}`, ...(branchDeleted ? [] : ["Branche conservée : elle n'est pas fusionnée."])]);
        }
        await this.db.update(worktrees).set({ status: 'removed', removedAt: new Date() }).where(eq(worktrees.id, row.id));
        this.deps.diskUsage?.forget(row.path);
        return { removed: true, branchDeleted };
      },
    );
    return { operationId, ...value };
  }

  // -------------------------------------------------------------------------------------------
  // Changes & diff
  // -------------------------------------------------------------------------------------------

  private async diffBase(cwd: string, against: 'head' | 'merge-base', base: string | undefined, defaultBranch: string): Promise<{ ref: string; label: string }> {
    if (against === 'merge-base') {
      const baseName = base ?? defaultBranch;
      const baseRef = await this.resolveBaseRef(cwd, baseName);
      if (!baseRef) throw new RunnerError('NOT_FOUND', `Branche de base introuvable : ${baseName}.`, { reason: 'BRANCH_NOT_FOUND' });
      const head = await this.headSha(cwd);
      if (!head) return { ref: EMPTY_TREE, label: baseName };
      const mb = await this.git.output(['merge-base', 'HEAD', baseRef], { cwd });
      return { ref: mb, label: baseName };
    }
    const head = await this.headSha(cwd);
    return { ref: head ? 'HEAD' : EMPTY_TREE, label: (await this.currentBranch(cwd)) ?? 'HEAD' };
  }

  private async readUntracked(cwd: string, relativePath: string, maxBytes = UNTRACKED_READ_CAP): Promise<{ binary: boolean; content: string | null; size: number }> {
    const abs = await this.deps.paths.resolveInWorktree(cwd, relativePath);
    const info = await stat(abs);
    if (!info.isFile()) return { binary: false, content: null, size: info.size };
    if (info.size > Math.min(UNTRACKED_READ_CAP, maxBytes)) return { binary: false, content: null, size: info.size };
    const buffer = await readFile(abs);
    if (isBinaryBuffer(buffer)) return { binary: true, content: null, size: info.size };
    return { binary: false, content: buffer.toString('utf8'), size: info.size };
  }

  async changes(worktreeId: string, query: { against: 'head' | 'merge-base'; base?: string }): Promise<ChangesResponse> {
    const { project, cwd } = await this.resolveWorktree(worktreeId);
    const status = await this.status(cwd);
    const { ref, label } = await this.diffBase(cwd, query.against, query.base, project.defaultBranch);
    const numstat = parseNumstatZ(await this.git.output(['diff', ref, '--numstat', '-z', '-M', '--no-ext-diff'], { cwd, timeoutMs: 30_000, maxOutputBytes: 16 * 1024 * 1024 }));
    const counts = new Map(numstat.map((n) => [n.path, n]));
    const files: ChangedFile[] = [];
    const seen = new Set<string>();

    if (query.against === 'merge-base') {
      const names = parseNameStatusZ(await this.git.output(['diff', ref, '--name-status', '-z', '-M', '--no-ext-diff'], { cwd, timeoutMs: 30_000 }));
      const byPath = new Map(status.files.map((f) => [f.path, f]));
      for (const n of names) {
        const s = byPath.get(n.path);
        const c = counts.get(n.path);
        const letter = (['M', 'A', 'D', 'R', 'C', 'T', 'U'].includes(n.letter) ? n.letter : 'M') as ChangedFile['status'];
        files.push({
          path: n.path,
          oldPath: n.oldPath,
          status: letter,
          staged: s?.staged ?? false,
          unstaged: s?.unstaged ?? false,
          insertions: c?.insertions ?? 0,
          deletions: c?.deletions ?? 0,
          binary: c?.binary ?? false,
        });
        seen.add(n.path);
      }
    } else {
      for (const s of status.files) {
        if (s.kind === 'ignored' || s.kind === 'untracked') continue;
        const c = counts.get(s.path);
        files.push({
          path: s.path,
          oldPath: s.oldPath ?? c?.oldPath ?? null,
          status: changeLetter(s),
          staged: s.staged,
          unstaged: s.unstaged,
          insertions: c?.insertions ?? 0,
          deletions: c?.deletions ?? 0,
          binary: c?.binary ?? false,
        });
        seen.add(s.path);
      }
    }
    const budget = { files: this.untrackedBudget.files, bytes: this.untrackedBudget.bytes, until: Date.now() + this.untrackedBudget.ms };
    for (const s of status.files) {
      if (s.kind !== 'untracked' || seen.has(s.path)) continue;
      let insertions = 0;
      let binary = false;
      let linesCounted = false;
      if (budget.files > 0 && budget.bytes > 0 && Date.now() < budget.until) {
        budget.files -= 1;
        try {
          const u = await this.readUntracked(cwd, s.path, budget.bytes);
          linesCounted = u.content !== null || u.binary;
          if (linesCounted) budget.bytes -= u.size;
          binary = u.binary;
          insertions = u.content ? countLines(u.content) : 0;
        } catch {
          // unreadable: not counted
        }
      }
      files.push({
        path: s.path,
        oldPath: null,
        status: 'A',
        staged: false,
        unstaged: true,
        insertions,
        deletions: 0,
        binary,
        ...(linesCounted ? {} : { linesCounted: false }),
      });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return {
      branch: status.branch,
      base: query.against === 'merge-base' ? label : null,
      files,
      totals: {
        files: files.length,
        insertions: files.reduce((sum, f) => sum + f.insertions, 0),
        deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      },
    };
  }

  async diff(worktreeId: string, query: { path: string; against: 'head' | 'merge-base' | 'staged'; base?: string; context: number }): Promise<FileDiff> {
    const { project, cwd } = await this.resolveWorktree(worktreeId);
    const rel = this.deps.paths.relativeForGit(query.path);
    const status = await this.status(cwd);
    const entry = status.files.find((f) => f.path === rel);
    const branch = status.branch ?? 'HEAD';

    if (entry?.kind === 'untracked' && query.against !== 'staged') {
      const u = await this.readUntracked(cwd, rel);
      const parsed = u.binary || u.content === null ? { binary: u.binary, hunks: [], insertions: 0, deletions: 0, truncated: false } : additionDiff(u.content);
      return {
        path: rel,
        oldPath: null,
        status: 'A',
        binary: parsed.binary,
        truncated: parsed.truncated,
        tooLarge: !u.binary && u.content === null,
        insertions: parsed.insertions,
        deletions: 0,
        baseLabel: query.against === 'merge-base' ? (query.base ?? project.defaultBranch) : branch,
        headLabel: query.against === 'merge-base' ? branch : 'copie de travail',
        hunks: parsed.hunks,
      };
    }

    let args: string[];
    let baseLabel: string;
    let headLabel: string;
    if (query.against === 'staged') {
      const head = await this.headSha(cwd);
      args = ['diff', '--cached', ...(head ? [] : [EMPTY_TREE])];
      baseLabel = branch;
      headLabel = 'index';
    } else {
      const { ref, label } = await this.diffBase(cwd, query.against, query.base, project.defaultBranch);
      args = ['diff', ref];
      baseLabel = label;
      headLabel = query.against === 'merge-base' ? branch : 'copie de travail';
    }
    const pathspecs = [literal(rel), ...(entry?.oldPath ? [literal(entry.oldPath)] : [])];
    const result = await this.git.run([...args, '-M', `-U${query.context}`, '--no-color', '--no-ext-diff', '--', ...pathspecs], {
      cwd,
      timeoutMs: 30_000,
      maxOutputBytes: DIFF_OUTPUT_CAP,
    });
    const parsed = parseUnifiedDiff(result.stdout);
    const letter = entry ? changeLetter(entry) : /^new file mode/m.test(result.stdout) ? 'A' : /^deleted file mode/m.test(result.stdout) ? 'D' : 'M';
    return {
      path: rel,
      oldPath: entry?.oldPath ?? null,
      status: letter,
      binary: parsed.binary,
      truncated: parsed.truncated || result.truncated,
      tooLarge: result.truncated,
      insertions: parsed.insertions,
      deletions: parsed.deletions,
      baseLabel,
      headLabel,
      hunks: parsed.hunks,
    };
  }

  async stage(worktreeId: string, paths: string[]): Promise<{ status: GitStatus }> {
    const { cwd } = await this.resolveWorktree(worktreeId);
    const specs = paths.map((p) => literal(this.deps.paths.relativeForGit(p)));
    await this.git.run(['add', '-A', '--', ...specs], { cwd });
    return { status: await this.status(cwd) };
  }

  async unstage(worktreeId: string, paths: string[]): Promise<{ status: GitStatus }> {
    const { cwd } = await this.resolveWorktree(worktreeId);
    const specs = paths.map((p) => literal(this.deps.paths.relativeForGit(p)));
    if (await this.headSha(cwd)) await this.git.run(['restore', '--staged', '--', ...specs], { cwd });
    else await this.git.run(['rm', '--cached', '-r', '--quiet', '--ignore-unmatch', '--', ...specs], { cwd });
    return { status: await this.status(cwd) };
  }

  // -------------------------------------------------------------------------------------------
  // Commit & push
  // -------------------------------------------------------------------------------------------

  async commitIn(
    cwd: string,
    input: { message: string; body?: string; author: GitIdentity; paths?: string[]; runHooks: boolean },
  ): Promise<Omit<CommitResult, 'operationId'>> {
    const message = input.message.replace(/\r?\n/g, ' ').trim();
    const specs = input.paths?.map((p) => literal(this.deps.paths.relativeForGit(p)));
    if (specs && specs.length > 0) {
      await this.git.run(['add', '-A', '--', ...specs], { cwd });
    }
    const staged = await this.git.run(['diff', '--cached', '--quiet', ...(specs?.length ? ['--', ...specs] : [])], { cwd, allowFailure: true });
    const hasHead = (await this.headSha(cwd)) !== null;
    if (staged.exitCode === 0 && hasHead) {
      throw new RunnerError('CONFLICT', 'Rien à committer : aucune modification sélectionnée.', { reason: 'NOTHING_TO_COMMIT' });
    }
    const args = ['commit', '-m', message, ...(input.body?.trim() ? ['-m', input.body.trim()] : []), ...(input.runHooks ? [] : ['--no-verify'])];
    if (specs && specs.length > 0) args.push('--only', '--', ...specs);
    const result = await this.git.run(args, { cwd, identity: input.author, runHooks: input.runHooks, allowFailure: true, timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`;
      if (/nothing (added )?to commit|no changes added/i.test(output)) {
        throw new RunnerError('CONFLICT', 'Rien à committer : aucune modification sélectionnée.', { reason: 'NOTHING_TO_COMMIT' });
      }
      throw new GitCommandError(input.runHooks ? 'Le commit a été refusé (hook du dépôt ou erreur git).' : 'Le commit a échoué.', args, result);
    }
    const sha = await this.git.output(['rev-parse', 'HEAD'], { cwd });
    const stats = parseNumstatZ(await this.git.output(['show', '--numstat', '-z', '-M', '--format=', 'HEAD'], { cwd }));
    return {
      sha,
      shortSha: sha.slice(0, 7),
      branch: await this.currentBranch(cwd),
      filesCommitted: stats.length,
      insertions: stats.reduce((s, e) => s + e.insertions, 0),
      deletions: stats.reduce((s, e) => s + e.deletions, 0),
    };
  }

  async commit(
    worktreeId: string,
    input: { message: string; body?: string; author: GitIdentity; paths?: string[]; runHooks: boolean; sessionId?: string; actorUserId?: string | null },
  ): Promise<CommitResult> {
    const { project, worktree, cwd } = await this.resolveWorktree(worktreeId);
    await this.assertOwnSession(input.sessionId);
    const { operationId, value } = await this.deps.ops.run(
      {
        kind: 'commit',
        projectId: project.id,
        worktreeId: worktree.id,
        sessionId: input.sessionId ?? null,
        title: input.message.slice(0, 200),
        actorUserId: input.actorUserId,
      },
      async (op) => {
        op.appendLog([`$ git commit -m ${JSON.stringify(input.message)}`]);
        const result = await this.commitIn(cwd, input);
        op.appendLog([`[${result.branch ?? 'HEAD'} ${result.shortSha}] ${input.message}`, `${result.filesCommitted} fichier(s), +${result.insertions} −${result.deletions}`]);
        await this.db.update(worktrees).set({ lastUsedAt: new Date() }).where(eq(worktrees.id, worktree.id));
        if (worktree.isPrimary) {
          await this.db
            .update(projects)
            .set({ lastCommitSha: result.sha, lastCommitMessage: input.message, lastCommitAt: new Date() })
            .where(eq(projects.id, project.id));
        }
        return result;
      },
      (r) => ({ ...r }),
    );
    return { operationId, ...value };
  }

  async push(
    worktreeId: string,
    input: { extraHeader: string; remoteBranch?: string; setUpstream: boolean; protectedBranches: string[]; sessionId?: string; actorUserId?: string | null },
  ): Promise<PushResult> {
    const { project, worktree, cwd } = await this.resolveWorktree(worktreeId);
    await this.assertOwnSession(input.sessionId);
    const branch = await this.currentBranch(cwd);
    if (!branch) throw new RunnerError('CONFLICT', "Le worktree n'est sur aucune branche (HEAD détachée).");
    const remoteBranch = input.remoteBranch ?? branch;
    // The default branch is always protected (as `branches()` lists it): changes reach it by pull request.
    if (remoteBranch === project.defaultBranch || input.protectedBranches.includes(remoteBranch)) {
      throw new RunnerError('CONFLICT', `La branche ${remoteBranch} est protégée : le push direct est refusé.`, {
        reason: 'BRANCH_PROTECTED',
        untouched: "Rien n'a été envoyé sur GitHub.",
      });
    }
    const headSha = await this.headSha(cwd);
    if (!headSha) throw new RunnerError('CONFLICT', 'Aucun commit à pousser.', { reason: 'NOTHING_TO_COMMIT' });
    const { operationId, value } = await this.deps.ops.run(
      { kind: 'push', projectId: project.id, worktreeId: worktree.id, sessionId: input.sessionId ?? null, title: `Push de ${branch}`, actorUserId: input.actorUserId },
      async (op) => {
        const url = this.git.remoteUrl(project.githubFullName);
        const existed = await this.refExists(cwd, `refs/remotes/origin/${remoteBranch}`);
        const args = ['push', '--porcelain', url, `HEAD:refs/heads/${remoteBranch}`];
        op.appendLog([`$ git push ${url} HEAD:refs/heads/${remoteBranch}`]);
        const result = await this.git.run(args, { cwd, network: true, extraHeader: input.extraHeader, allowFailure: true, timeoutMs: 120_000 });
        const refs = parsePushPorcelain(result.stdout);
        const ref = refs.find((r) => r.to === `refs/heads/${remoteBranch}`);
        op.appendLog(result.stderr.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('To ')));
        if (ref?.flag === '!' || (result.exitCode !== 0 && /rejected|non-fast-forward|fetch first/i.test(result.stdout + result.stderr))) {
          throw new RunnerError('CONFLICT', `GitHub a refusé le push : ${remoteBranch} a avancé sur origin. Mettez la branche à jour d'abord.`, {
            reason: 'PUSH_REJECTED',
            raw: `${result.stdout}\n${result.stderr}`.trim(),
            untouched: 'Vos commits locaux sont intacts.',
          });
        }
        if (result.exitCode !== 0) throw new GitCommandError('Le push a échoué.', args, result, { reason: undefined });
        await this.git.run(['update-ref', `refs/remotes/origin/${remoteBranch}`, headSha], { cwd });
        if (input.setUpstream) {
          await this.git.run(['config', `branch.${branch}.remote`, 'origin'], { cwd });
          await this.git.run(['config', `branch.${branch}.merge`, `refs/heads/${remoteBranch}`], { cwd });
        }
        if (worktree.isPrimary) {
          const sync = await this.syncStatusFor(project, cwd);
          await this.saveSync(project, sync, { lastSyncedAt: new Date() });
        }
        return { branch, remoteBranch, headSha, upToDate: ref?.flag === '=', createdRemoteBranch: !existed || ref?.flag === '*' };
      },
      (r) => ({ ...r }),
    );
    return { operationId, ...value };
  }

  async aheadBehind(worktreeId: string, query: { base?: string }): Promise<AheadBehind> {
    const { project, worktree, cwd } = await this.resolveWorktree(worktreeId);
    const status = await this.status(cwd);
    const base = query.base ?? worktree.baseBranch ?? project.defaultBranch;
    const baseRef = await this.resolveBaseRef(cwd, base);
    const ab = baseRef && status.headSha ? await this.countAheadBehind(cwd, baseRef) : { ahead: 0, behind: 0 };
    const upstream = await this.upstreamRef(cwd, status.branch);
    const up = upstream && status.headSha ? await this.countAheadBehind(cwd, upstream.ref) : null;
    return {
      branch: status.branch,
      base,
      ahead: ab.ahead,
      behind: ab.behind,
      upstream: upstream && up ? { name: upstream.name, ...up } : null,
      dirtyFiles: status.files.filter((f) => f.kind !== 'ignored').length,
    };
  }

  // -------------------------------------------------------------------------------------------
  // CLAUDE.md
  // -------------------------------------------------------------------------------------------

  async readClaudeMd(projectId: string, worktreeId?: string) {
    const { worktree, cwd } = await this.resolveProjectWorktree(projectId, worktreeId);
    const abs = await this.deps.paths.resolveInWorktree(cwd, 'CLAUDE.md', { mustExist: false });
    let content: string | null = null;
    let size: number | null = null;
    let modifiedAt: string | null = null;
    if (existsSync(abs)) {
      const info = await stat(abs);
      size = info.size;
      modifiedAt = info.mtime.toISOString();
      if (info.size <= 1024 * 1024) content = await readFile(abs, 'utf8');
    }
    const last = await this.git.tryOutput(['log', '-1', '--format=%H%x1f%cI%x1f%s', '--', 'CLAUDE.md'], { cwd });
    const [sha, committedAt, subject] = last ? last.split('\x1f') : [];
    return {
      worktreeId: worktree.id,
      exists: size !== null,
      content,
      lines: content === null ? null : countLines(content),
      size,
      modifiedAt,
      lastCommit: sha && committedAt ? { sha, committedAt, subject: subject ?? '' } : null,
    };
  }

  async writeClaudeMd(projectId: string, input: { content: string; worktreeId?: string; commit?: { message: string; author: GitIdentity }; actorUserId?: string | null }) {
    const { project, worktree, cwd } = await this.resolveProjectWorktree(projectId, input.worktreeId);
    if (this.deps.liveSessionForWorktree(worktree.id) && input.commit) {
      // Allowed, but the session may also be editing the file: commit only CLAUDE.md.
      this.deps.logger.info({ worktreeId: worktree.id }, 'CLAUDE.md commité pendant une session');
    }
    const { operationId, value } = await this.deps.ops.run(
      { kind: 'claude_md_update', projectId: project.id, worktreeId: worktree.id, title: 'Mise à jour de CLAUDE.md', actorUserId: input.actorUserId },
      async (op) => {
        const abs = await this.deps.paths.resolveInWorktree(cwd, 'CLAUDE.md', { mustExist: false });
        const normalized = input.content.replace(/\r\n/g, '\n');
        await writeFile(abs, normalized, 'utf8');
        op.appendLog([`CLAUDE.md écrit (${countLines(normalized)} lignes).`]);
        let commitSha: string | null = null;
        if (input.commit) {
          const result = await this.commitIn(cwd, { message: input.commit.message, author: input.commit.author, paths: ['CLAUDE.md'], runHooks: false });
          commitSha = result.sha;
          op.appendLog([`[${result.branch ?? 'HEAD'} ${result.shortSha}] ${input.commit.message}`]);
        }
        await this.db
          .update(projects)
          .set({ claudeMdUpdatedAt: new Date(), ...(commitSha ? { claudeMdCommitSha: commitSha } : {}) })
          .where(and(eq(projects.id, project.id), isNull(projects.archivedAt)));
        return { lines: countLines(normalized), commitSha };
      },
      (r) => ({ ...r }),
    );
    return { operationId, ...value };
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}
