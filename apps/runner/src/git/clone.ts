import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { projects, worktrees, type Database } from '@nuera/db';
import { formatBytes } from '@nuera/shared/format';
import { formatShortDuration } from '@nuera/shared/events';
import type { CloneResult, DestinationCheck, OperationStepDto } from '@nuera/shared/runner';
import type { Logger } from 'pino';
import { getProject } from '../db/lookups';
import type { EnvironmentScope } from '../environment';
import { RunnerError } from '../errors';
import type { OperationHandle, OperationService } from '../operations/service';
import { buildChildEnv } from '../safety/env';
import { execCommand } from '../safety/exec';
import type { PathGuard } from '../safety/paths';
import { platformShell } from '../runs/shell';
import type { Git } from './git';
import { parseProgressLine, ProgressStream } from './progress';

type PackageManager = NonNullable<CloneResult['packageManager']>;

export interface CloneInput {
  projectId: string;
  fullName: string;
  branch?: string;
  destination: string;
  extraHeader?: string;
  installDeps: boolean;
  installCommand?: string;
  actorUserId?: string | null;
}

const STEP_LABELS = {
  clone: 'Cloner le dépôt',
  install: 'Installer les dépendances',
  inspect: 'Lire CLAUDE.md et détecter les commandes',
} as const;

function countLines(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** Lockfile → package manager and install command (run through the platform shell). */
export function detectPackageManager(files: Set<string>): { manager: PackageManager | null; install: string | null } {
  if (!files.has('package.json')) return { manager: null, install: null };
  if (files.has('pnpm-lock.yaml')) return { manager: 'pnpm', install: 'pnpm install --frozen-lockfile' };
  if (files.has('yarn.lock')) return { manager: 'yarn', install: 'yarn install --frozen-lockfile' };
  if (files.has('bun.lockb') || files.has('bun.lock')) return { manager: 'bun', install: 'bun install --frozen-lockfile' };
  if (files.has('package-lock.json') || files.has('npm-shrinkwrap.json')) return { manager: 'npm', install: 'npm ci' };
  return { manager: 'npm', install: 'npm install' };
}

/** `added 912 packages`, `Packages: +912`… */
export function parseInstalledPackages(output: string): number | null {
  const npm = /added (\d+) packages?/i.exec(output);
  if (npm) return Number(npm[1]);
  const pnpm = /Packages:\s*\+(\d+)/i.exec(output);
  if (pnpm) return Number(pnpm[1]);
  const bun = /(\d+) packages? installed/i.exec(output);
  if (bun) return Number(bun[1]);
  return null;
}

export class CloneService {
  constructor(
    private readonly deps: { db: Database; environment: EnvironmentScope; git: Git; paths: PathGuard; ops: OperationService; logger: Logger },
  ) {}

  /** A4: is the destination usable? (never writes anything) */
  async checkDestination(input: { path: string; fullName?: string }): Promise<DestinationCheck> {
    const target = await this.deps.paths.resolveDestination(input.path);
    const result: DestinationCheck = {
      path: target,
      exists: false,
      empty: true,
      fileCount: 0,
      existingClone: null,
      suggestedPath: null,
      available: true,
    };
    if (!existsSync(target)) return result;
    result.exists = true;
    const info = await stat(target);
    if (!info.isDirectory()) {
      result.empty = false;
      result.fileCount = 1;
      result.available = false;
    } else {
      const entries = await readdir(target);
      result.fileCount = entries.length;
      result.empty = entries.length === 0;
      result.available = result.empty;
      if (entries.includes('.git')) {
        const remoteUrl = await this.deps.git.tryOutput(['config', '--get', 'remote.origin.url'], { cwd: target });
        const branch = await this.deps.git.tryOutput(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: target });
        const match = remoteUrl ? /([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(remoteUrl) : null;
        const fullName = match?.[1] ?? null;
        result.existingClone = {
          remoteUrl: remoteUrl ? remoteUrl.replace(/\/\/[^@/]+@/, '//') : null,
          fullName,
          branch,
          sameRepository: Boolean(fullName && input.fullName && fullName.toLowerCase() === input.fullName.toLowerCase()),
        };
      }
    }
    if (!result.available) result.suggestedPath = await this.suggestFreePath(target, input.fullName);
    return result;
  }

  private async suggestFreePath(target: string, fullName?: string): Promise<string | null> {
    const parent = path.dirname(target);
    const base = path.basename(target);
    const repo = fullName?.split('/')[1]?.toLowerCase();
    const candidates = [
      ...(repo && repo !== base ? [`${base}-${repo}`] : []),
      ...Array.from({ length: 20 }, (_v, i) => `${base}-${i + 2}`),
    ];
    for (const name of candidates) {
      const candidate = path.join(parent, name);
      if (!existsSync(candidate) && this.deps.paths.isInsideProjects(candidate)) return candidate;
    }
    return null;
  }

  /** Starts the clone in the background; the operation id is returned immediately (A2). */
  async start(input: CloneInput): Promise<OperationHandle> {
    const project = await getProject(this.deps.db, this.deps.environment.id, input.projectId);
    await this.deps.environment.assertCanStartWork();
    if (project.githubFullName.toLowerCase() !== input.fullName.toLowerCase()) {
      throw new RunnerError('VALIDATION', 'Le dépôt ne correspond pas au projet.');
    }
    const check = await this.checkDestination({ path: input.destination, fullName: input.fullName });
    if (!check.available) {
      throw new RunnerError('CONFLICT', "Le dossier de destination n'est pas vide.", {
        reason: 'DESTINATION_NOT_EMPTY',
        untouched: "Rien n'a été écrasé.",
        data: { ...check },
      });
    }
    const steps: OperationStepDto[] = [
      { key: 'clone', label: STEP_LABELS.clone, status: 'pending', detail: 'en attente' },
      { key: 'install', label: STEP_LABELS.install, status: input.installDeps ? 'pending' : 'skipped', detail: input.installDeps ? 'en attente' : 'désactivé' },
      { key: 'inspect', label: STEP_LABELS.inspect, status: 'pending', detail: 'en attente' },
    ];
    const op = await this.deps.ops.create({
      kind: 'clone',
      projectId: project.id,
      title: `Clonage de ${input.fullName}`,
      steps,
      actorUserId: input.actorUserId,
    });
    await this.deps.db.update(projects).set({ status: 'cloning', statusDetail: null, path: check.path }).where(eq(projects.id, project.id));
    void this.execute(op, input, check.path, check.exists).catch((error: unknown) => {
      this.deps.logger.error({ err: error, operationId: op.id }, 'clonage interrompu');
    });
    return op;
  }

  private async execute(op: OperationHandle, input: CloneInput, target: string, existedBefore: boolean): Promise<void> {
    const startedAt = Date.now();
    let receivedBytes: number | null = null;
    let clonedPath: string | null = null;
    try {
      // 1. git clone --progress
      const cloneStarted = Date.now();
      op.step('clone', { status: 'running', detail: 'en cours', startedAt: new Date().toISOString() });
      await mkdir(path.dirname(target), { recursive: true });
      const url = this.deps.git.remoteUrl(input.fullName);
      const displayUrl = url.startsWith('https://') ? url : `https://github.com/${input.fullName}.git`;
      op.appendLog([`$ git clone ${displayUrl}`]);
      const progress = new ProgressStream();
      const cloneWeight = input.installDeps ? 0.7 : 0.9;
      const ticker = setInterval(() => {
        const s = op.stepState('clone');
        if (s?.status === 'running') op.step('clone', { detail: `en cours · ${formatShortDuration(Date.now() - cloneStarted)}` });
      }, 1000);
      ticker.unref?.();
      try {
        await this.deps.git.run(['clone', '--progress', ...(input.branch ? ['--branch', input.branch] : []), '--', url, target], {
          cwd: path.dirname(target),
          network: true,
          extraHeader: input.extraHeader,
          locale: 'inherit',
          timeoutMs: 30 * 60_000,
          onStderr: (chunk) => {
            const { lines, live } = progress.push(chunk);
            if (lines.length) op.appendLog(lines);
            op.setLiveLine(live);
            for (const line of [...lines, ...(live ? [live] : [])]) {
              const update = parseProgressLine(line);
              if (!update) continue;
              if (update.phase === 'receiving' && update.bytes !== null) receivedBytes = update.bytes;
              if (update.overall !== null) op.progress(update.overall * cloneWeight);
            }
          },
        });
      } finally {
        clearInterval(ticker);
      }
      const rest = progress.flush();
      if (rest.length) op.appendLog(rest);
      op.setLiveLine(null);
      op.step('clone', {
        status: 'done',
        finishedAt: new Date().toISOString(),
        detail: [receivedBytes !== null ? formatBytes(receivedBytes) : null, formatShortDuration(Date.now() - cloneStarted)].filter(Boolean).join(' · '),
        ...(receivedBytes !== null ? { bytes: receivedBytes } : {}),
      });
      op.progress(cloneWeight * 100);

      const branch = await this.deps.git.tryOutput(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: target });
      const headLine = await this.deps.git.tryOutput(['log', '-1', '--format=%H%x1f%s%x1f%cI'], { cwd: target });
      const [headSha = null, headMessage = null, headDate = null] = headLine ? headLine.split('\x1f') : [];
      const files = new Set(await readdir(target));
      const detected = detectPackageManager(files);
      const project = await getProject(this.deps.db, this.deps.environment.id, input.projectId);
      const [worktree] = await this.deps.db
        .insert(worktrees)
        .values({
          projectId: project.id,
          environmentId: project.environmentId,
          name: project.slug,
          branch: branch ?? project.defaultBranch,
          path: target,
          isPrimary: true,
          status: 'active',
          lastUsedAt: new Date(),
        })
        .returning();
      if (!worktree) throw new RunnerError('INTERNAL', 'Worktree principal non enregistré.');
      clonedPath = target;

      // 2. dependencies
      let install: CloneResult['install'] = null;
      const installCommand = input.installCommand ?? detected.install;
      if (input.installDeps) {
        if (!installCommand) {
          op.step('install', { status: 'skipped', detail: 'aucun package.json' });
        } else {
          op.step('install', { status: 'running', label: `${STEP_LABELS.install} (${installCommand})`, detail: 'en cours', startedAt: new Date().toISOString() });
          install = await this.runInstall(op, target, installCommand);
          if (install.exitCode !== 0) {
            throw new RunnerError('UPSTREAM', `${installCommand} a échoué (code ${install.exitCode ?? '?'}).`, {
              untouched: "Le dépôt est cloné : vous pourrez relancer l'installation depuis le projet.",
              data: { stage: 'install', path: target },
            });
          }
          op.step('install', {
            status: 'done',
            finishedAt: new Date().toISOString(),
            detail: [install.packages !== null ? `${install.packages} paquets` : null, formatShortDuration(install.durationMs)].filter(Boolean).join(' · '),
          });
        }
      }
      op.progress(95);

      // 3. CLAUDE.md + commands
      op.step('inspect', { status: 'running', detail: 'en cours', startedAt: new Date().toISOString() });
      const inspected = await this.inspect(target, detected.manager);
      const commands = { install: installCommand, ...inspected.commands };
      op.step('inspect', {
        status: 'done',
        finishedAt: new Date().toISOString(),
        detail: inspected.claudeMd.found ? `CLAUDE.md · ${inspected.claudeMd.lines ?? 0} lignes` : 'CLAUDE.md absent',
      });

      // Project ready
      const existingCommands = (project.commands ?? {}) as Record<string, string | null | undefined>;
      const mergedCommands: Record<string, string | null> = {};
      for (const key of ['install', 'dev', 'build', 'test', 'lint'] as const) {
        mergedCommands[key] = existingCommands[key] ?? commands[key] ?? null;
      }
      await this.deps.db
        .update(projects)
        .set({
          status: 'ready',
          statusDetail: null,
          path: target,
          currentBranch: branch,
          // Cloned without --branch: HEAD is the remote's default branch (the column defaults to 'main').
          ...(branch && !input.branch ? { defaultBranch: branch } : {}),
          lastCommitSha: headSha,
          lastCommitMessage: headMessage,
          lastCommitAt: headDate ? new Date(headDate) : null,
          commands: mergedCommands as never,
          syncState: 'up_to_date',
          aheadBy: 0,
          behindBy: 0,
          lastFetchedAt: new Date(),
          lastSyncedAt: new Date(),
          ...(inspected.claudeMd.found ? { claudeMdUpdatedAt: new Date() } : {}),
        })
        .where(eq(projects.id, project.id));

      const result: CloneResult = {
        projectId: project.id,
        path: target,
        branch,
        headSha,
        worktreeId: worktree.id,
        scripts: inspected.scripts,
        commands: { install: installCommand, dev: inspected.commands.dev, build: inspected.commands.build, test: inspected.commands.test, lint: inspected.commands.lint },
        packageManager: detected.manager,
        claudeMd: inspected.claudeMd,
        install,
        receivedBytes,
      };
      op.appendLog([`Projet prêt en ${formatShortDuration(Date.now() - startedAt)}.`]);
      await op.succeed(result as unknown as Record<string, unknown>);
    } catch (error) {
      const runnerError = error instanceof RunnerError ? error : null;
      if (!clonedPath && !existedBefore) {
        // A failed clone must leave nothing behind (git usually cleans up; make sure).
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
      }
      const message = runnerError?.message ?? 'Le clonage a échoué.';
      // After a successful clone (install/inspect failed) the project stays usable.
      await this.deps.db
        .update(projects)
        .set({ status: clonedPath ? 'ready' : 'error', statusDetail: message, ...(clonedPath ? { path: clonedPath } : {}) })
        .where(eq(projects.id, input.projectId))
        .catch(() => undefined);
      // Rule T4: say what was not touched.
      const untouched = existedBefore ? "Le dossier existant n'a pas été modifié." : "Aucun fichier n'a été laissé sur le serveur.";
      const failure = runnerError ?? new RunnerError('UPSTREAM', message);
      await op.fail(
        failure.untouched || clonedPath
          ? failure
          : new RunnerError(failure.code, failure.message, { raw: failure.raw, reason: failure.reason, data: failure.data, detail: failure.detail, untouched }),
      );
    }
  }

  private async runInstall(op: OperationHandle, cwd: string, command: string): Promise<NonNullable<CloneResult['install']>> {
    op.appendLog([`$ ${command}`]);
    const started = Date.now();
    const shell = platformShell(command);
    const stream = new ProgressStream();
    let all = '';
    const onChunk = (chunk: string) => {
      all = (all + chunk).slice(-256 * 1024);
      const { lines, live } = stream.push(chunk);
      if (lines.length) op.appendLog(lines);
      op.setLiveLine(live);
    };
    const ticker = setInterval(() => op.step('install', { detail: `en cours · ${formatShortDuration(Date.now() - started)}` }), 1000);
    ticker.unref?.();
    try {
      const result = await execCommand(shell.file, shell.args, {
        cwd,
        env: buildChildEnv({ CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', npm_config_fund: 'false', npm_config_audit: 'false' }, { policy: 'project' }),
        timeoutMs: 20 * 60_000,
        windowsVerbatimArguments: shell.verbatim,
        onStdout: onChunk,
        onStderr: onChunk,
      });
      const rest = stream.flush();
      if (rest.length) op.appendLog(rest);
      op.setLiveLine(null);
      return { command, exitCode: result.exitCode, durationMs: Date.now() - started, packages: parseInstalledPackages(all) };
    } finally {
      clearInterval(ticker);
    }
  }

  async inspect(
    cwd: string,
    manager: PackageManager | null,
  ): Promise<{ scripts: string[]; commands: { dev: string | null; build: string | null; test: string | null; lint: string | null }; claudeMd: CloneResult['claudeMd'] }> {
    // A cloned repository is untrusted: its files may be symlinks to anything on the server
    // (`CLAUDE.md -> ~/.claude/.credentials.json`). Every read is confined to the clone (realpath).
    const confined = async (rel: string): Promise<string | null> => {
      try {
        return await this.deps.paths.resolveInWorktree(cwd, rel);
      } catch {
        return null;
      }
    };
    let scripts: string[] = [];
    try {
      const pkgPath = await confined('package.json');
      const pkg = pkgPath ? (JSON.parse(await readFile(pkgPath, 'utf8')) as { scripts?: Record<string, unknown> }) : {};
      scripts = Object.keys(pkg.scripts ?? {}).filter((k) => typeof pkg.scripts?.[k] === 'string');
    } catch {
      scripts = [];
    }
    const pm = manager ?? 'npm';
    const cmd = (name: string) => (scripts.includes(name) ? `${pm} run ${name}` : null);
    let claudeMd: CloneResult['claudeMd'] = { found: false, location: null, lines: null };
    for (const [rel, location] of [
      ['CLAUDE.md', 'racine'],
      ['.claude/CLAUDE.md', '.claude'],
    ] as const) {
      const abs = await confined(rel);
      if (!abs) continue;
      const info = await stat(abs);
      if (!info.isFile()) continue;
      const lines = info.size <= 1024 * 1024 ? countLines(await readFile(abs, 'utf8')) : null;
      claudeMd = { found: true, location, lines };
      break;
    }
    return { scripts, commands: { dev: cmd('dev'), build: cmd('build'), test: cmd('test'), lint: cmd('lint') }, claudeMd };
  }
}
