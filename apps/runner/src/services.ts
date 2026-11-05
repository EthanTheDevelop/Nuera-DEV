import { sql } from 'drizzle-orm';
import { createDb, type Database } from '@nuera/db';
import type { HealthResponse } from '@nuera/shared/runner';
import type { Logger } from 'pino';
import { ClaudeCli } from './claude/cli';
import type { RunnerConfig } from './config';
import { readAppSettings } from './db/lookups';
import { EventBus, GLOBAL } from './events/bus';
import { RunnerError } from './errors';
import { FileService } from './files/service';
import { CloneService } from './git/clone';
import { Git } from './git/git';
import { GitService } from './git/service';
import { OperationService } from './operations/service';
import { RunManager } from './runs/manager';
import { buildChildEnv } from './safety/env';
import { execCommand, succeeded } from './safety/exec';
import { PathGuard } from './safety/paths';
import { PtyBackend, TmuxBackend, type SessionBackend } from './sessions/backend';
import { DiskUsage } from './system/disk-usage';
import { SessionEventStore } from './sessions/event-store';
import { SessionManager } from './sessions/manager';
import { diskUsage, MetricsCollector } from './system/metrics';
import { Scheduler } from './system/scheduler';
import { UptimeTracker } from './system/uptime';
import { TerminalManager } from './terminals/manager';
import { WebClient } from './web/client';

export interface RunnerServices {
  config: RunnerConfig;
  logger: Logger;
  db: Database;
  bus: EventBus;
  paths: PathGuard;
  gitCli: Git;
  git: GitService;
  clone: CloneService;
  files: FileService;
  ops: OperationService;
  store: SessionEventStore;
  terminals: TerminalManager;
  sessions: SessionManager;
  runs: RunManager;
  claude: ClaudeCli;
  metrics: MetricsCollector;
  uptime: UptimeTracker;
  web: WebClient;
  scheduler: Scheduler;
  backend: SessionBackend;
  startedAt: Date;
  /** Set once the hook listener is bound (port 0 in tests). */
  hookPort: { value: number };
  health(): Promise<HealthResponse>;
}

async function toolVersion(file: string, args: string[]): Promise<{ available: boolean; version: string | null; error: string | null }> {
  const result = await execCommand(file, args, { env: buildChildEnv(), timeoutMs: 10_000 });
  if (!succeeded(result)) return { available: false, version: null, error: result.spawnError ? 'introuvable' : (result.stderr.trim() || 'erreur').slice(0, 200) };
  return { available: true, version: result.stdout.trim().split(/\r?\n/)[0] ?? null, error: null };
}

export async function chooseBackend(config: RunnerConfig, terminals: TerminalManager, logger: Logger): Promise<SessionBackend> {
  if (config.sessionBackend === 'pty') return new PtyBackend(terminals);
  const tmux = await TmuxBackend.version();
  if (config.sessionBackend === 'tmux' && !tmux) {
    throw new Error('NUERA_SESSION_BACKEND=tmux mais tmux est introuvable sur ce serveur.');
  }
  if (tmux) {
    logger.info({ tmux }, 'sessions Claude : backend tmux');
    return new TmuxBackend(terminals, config.dataDir, config.tmuxSocket ?? 'nuera');
  }
  logger.info('sessions Claude : backend PTY direct (tmux absent)');
  return new PtyBackend(terminals);
}

export async function createServices(config: RunnerConfig, options: { logger: Logger; db?: Database }): Promise<RunnerServices> {
  const logger = options.logger;
  const db = options.db ?? createDb(config.databaseUrl, { max: 10, applicationName: 'nuera-runner' });
  const bus = new EventBus();
  const paths = new PathGuard(config.projectsRoot, config.dataDir);
  const gitCli = new Git(paths.dataDir, config.gitRemoteBase);
  const ops = new OperationService(db, bus, logger);
  const web = new WebClient(config.webInternalUrl, config.token, logger);
  const hookPort = { value: config.hookPort };

  let sessionsRef: SessionManager | null = null;
  let runsRef: RunManager | null = null;
  const git = new GitService({
    db,
    git: gitCli,
    paths,
    ops,
    logger,
    liveSessionForWorktree: (id) => sessionsRef?.liveSessionForWorktree(id) ?? null,
    liveRunsForWorktree: (id) => runsRef?.liveCountForWorktree(id) ?? 0,
    diskUsage: new DiskUsage(),
  });
  const clone = new CloneService({ db, git: gitCli, paths, ops, logger });
  const files = new FileService({ paths, git: gitCli, gitService: git });
  const terminals = new TerminalManager({ dataDir: paths.dataDir, claudeBin: config.claudeBin, gitService: git, logger });
  const store = new SessionEventStore(db, bus);
  const claude = new ClaudeCli(config.claudeBin, paths.dataDir, logger);
  const backend = await chooseBackend(config, terminals, logger);
  const sessions = new SessionManager({
    db,
    bus,
    store,
    git,
    terminals,
    backend,
    web,
    logger,
    dataDir: paths.dataDir,
    claudeBin: config.claudeBin,
    hookBaseUrl: () => `http://127.0.0.1:${hookPort.value}`,
    onAuthProblem: () => {
      claude.invalidate();
      void claude.status({ refresh: true }).then((status) => bus.publish('claude.status', status, { channels: [GLOBAL] }));
    },
  });
  sessionsRef = sessions;
  const runs = new RunManager({ db, bus, git, terminals, logger });
  runsRef = runs;

  let maxSessions = 4;
  const refreshMax = async () => {
    maxSessions = (await readAppSettings(db))?.maxConcurrentSessions ?? 4;
  };
  void refreshMax().catch(() => undefined);
  setInterval(() => void refreshMax().catch(() => undefined), 60_000).unref?.();

  const metrics = new MetricsCollector(paths.projectsRoot, () => ({
    sessions: { live: sessions.liveCount, max: maxSessions },
    runs: runs.liveCount,
    terminals: terminals.liveCount,
  }));
  const uptime = new UptimeTracker(db, logger);
  const scheduler = new Scheduler({ db, git, web, uptime, logger });
  const startedAt = new Date();

  // system.metrics every 5 s while someone listens to the global stream.
  let metricsTimer: ReturnType<typeof setInterval> | null = null;
  bus.onSubscriptionChange((channel, count) => {
    if (channel !== GLOBAL) return;
    if (count > 0 && !metricsTimer) {
      metricsTimer = setInterval(() => {
        void metrics
          .collect()
          .then((m) => bus.publish('system.metrics', m, { channels: [GLOBAL], replay: false }))
          .catch(() => undefined);
      }, 5000);
      metricsTimer.unref?.();
    } else if (count === 0 && metricsTimer) {
      clearInterval(metricsTimer);
      metricsTimer = null;
    }
  });

  const health = async (): Promise<HealthResponse> => {
    const [gitInfo, tmuxVersion, claudeVersion, disk] = await Promise.all([
      toolVersion('git', ['--version']),
      backend.kind === 'tmux' ? TmuxBackend.version() : Promise.resolve(null),
      claude.version().catch(() => null),
      diskUsage(paths.projectsRoot),
    ]);
    let database: HealthResponse['database'] = { ok: true, error: null };
    try {
      await db.execute(sql`select 1`);
    } catch (error) {
      database = { ok: false, error: error instanceof Error ? error.message.slice(0, 200) : 'erreur' };
    }
    return {
      ok: gitInfo.available && database.ok,
      service: 'runner',
      version: config.version,
      startedAt: startedAt.toISOString(),
      uptimeSec: Math.round((Date.now() - startedAt.getTime()) / 1000),
      backend: backend.kind,
      git: gitInfo,
      tmux: { available: Boolean(tmuxVersion), version: tmuxVersion, error: tmuxVersion || process.platform === 'win32' ? null : 'tmux introuvable' },
      claude: { available: Boolean(claudeVersion), version: claudeVersion, error: claudeVersion ? null : 'CLI Claude Code introuvable ou muet' },
      database,
      disk: disk ? { path: disk.path, freeBytes: disk.freeBytes, totalBytes: disk.totalBytes } : null,
      projectsRoot: paths.projectsRoot,
      dataDir: paths.dataDir,
    };
  };

  if (!config.token) throw new RunnerError('INTERNAL', 'RUNNER_TOKEN manquant.');
  return {
    config,
    logger,
    db,
    bus,
    paths,
    gitCli,
    git,
    clone,
    files,
    ops,
    store,
    terminals,
    sessions,
    runs,
    claude,
    metrics,
    uptime,
    web,
    scheduler,
    backend,
    startedAt,
    hookPort,
    health,
  };
}
