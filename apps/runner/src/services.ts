import { sql } from 'drizzle-orm';
import { createDb, type Database } from '@nuera/db';
import { RUNNER_CONTRACT_VERSION, uptimeServiceKey, type HealthResponse } from '@nuera/shared/runner';
import type { Logger } from 'pino';
import { ClaudeCli } from './claude/cli';
import { CommonConfigSync } from './claude/common-config';
import type { RunnerConfig } from './config';
import { EnvironmentContext, RunnerFatalError } from './environment';
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
import { defaultTmuxSocket, PtyBackend, TmuxBackend, type SessionBackend } from './sessions/backend';
import { DiskUsage } from './system/disk-usage';
import { SessionEventStore } from './sessions/event-store';
import { SessionManager } from './sessions/manager';
import { ComposerTools } from './sessions/composer-tools';
import { diskUsage, MetricsCollector } from './system/metrics';
import { Scheduler } from './system/scheduler';
import { UptimeTracker } from './system/uptime';
import { TerminalManager } from './terminals/manager';
import { WebClient } from './web/client';

export interface RunnerServices {
  config: RunnerConfig;
  logger: Logger;
  db: Database;
  /** Server served by this runner (identity, lease, markers, settings, heartbeat). */
  environment: EnvironmentContext;
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
  /** Composer « Joindre » and skills of the palette (disk side). */
  composer: ComposerTools;
  /** Configuration Claude commune written in the CLI folder of this server (rules, skills). */
  commonConfig: CommonConfigSync;
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
  /**
   * Server heartbeat (every 60 s, scheduler or not): status and settings re-read, then last_seen_at /
   * versions / capabilities written. A failed re-read (database hiccup) does not skip the write; a
   * fatal one (RunnerFatalError) is thrown.
   */
  heartbeat(): Promise<void>;
}

async function toolVersion(file: string, args: string[]): Promise<{ available: boolean; version: string | null; error: string | null }> {
  const result = await execCommand(file, args, { env: buildChildEnv(), timeoutMs: 10_000 });
  if (!succeeded(result)) return { available: false, version: null, error: result.spawnError ? 'introuvable' : (result.stderr.trim() || 'erreur').slice(0, 200) };
  return { available: true, version: result.stdout.trim().split(/\r?\n/)[0] ?? null, error: null };
}

/**
 * tmux socket: NUERA_TMUX_SOCKET when set, otherwise that of the server ({@link defaultTmuxSocket}),
 * fixed once the server is known (no tmux command runs before: every session route waits for it).
 */
export function tmuxSocketResolver(
  config: Pick<RunnerConfig, 'tmuxSocket'>,
  environment: Pick<EnvironmentContext, 'current' | 'notServingError'>,
): () => string {
  let socket = config.tmuxSocket ?? null;
  return () => {
    if (socket) return socket;
    const current = environment.current;
    if (!current) throw environment.notServingError();
    socket = defaultTmuxSocket(current);
    return socket;
  };
}

export async function chooseBackend(
  config: RunnerConfig,
  terminals: TerminalManager,
  logger: Logger,
  socket: string | (() => string),
): Promise<SessionBackend> {
  if (config.sessionBackend === 'pty') return new PtyBackend(terminals);
  const tmux = await TmuxBackend.version();
  if (config.sessionBackend === 'tmux' && !tmux) {
    throw new Error('NUERA_SESSION_BACKEND=tmux mais tmux est introuvable sur ce serveur.');
  }
  if (tmux) {
    logger.info({ tmux }, 'sessions Claude : backend tmux');
    return new TmuxBackend(terminals, config.dataDir, socket);
  }
  logger.info('sessions Claude : backend PTY direct (tmux absent)');
  return new PtyBackend(terminals);
}

/** Versions reported by the heartbeat, refreshed at most every 30 min (each one spawns a process). */
const TOOLS_TTL_MS = 30 * 60_000;

export async function createServices(config: RunnerConfig, options: { logger: Logger; db?: Database }): Promise<RunnerServices> {
  // Own child logger: the server's id is bound to it once known (several runners per process in tests).
  const logger = options.logger.child({});
  const db = options.db ?? createDb(config.databaseUrl, {
      max: config.dbPoolMax,
      // Named after the server when it is declared (NUERA_ENVIRONMENT_ID): the web matches the role of
      // `nuera-runner:<id>` connections against the server's restricted role (admin/db-access.ts).
      applicationName: config.environmentId ? `nuera-runner:${config.environmentId}` : 'nuera-runner',
    });
  const environment = new EnvironmentContext({ db, config, logger });
  const bus = new EventBus();
  const paths = new PathGuard(config.projectsRoot, config.dataDir);
  const gitCli = new Git(paths.dataDir, config.gitRemoteBase);
  const ops = new OperationService(db, bus, logger, environment);
  const web = new WebClient(config.webInternalUrl, config.token, logger);
  const hookPort = { value: config.hookPort };

  let sessionsRef: SessionManager | null = null;
  let runsRef: RunManager | null = null;
  const git = new GitService({
    db,
    environment,
    git: gitCli,
    paths,
    ops,
    logger,
    liveSessionForWorktree: (id) => sessionsRef?.liveSessionForWorktree(id) ?? null,
    liveRunsForWorktree: (id) => runsRef?.liveCountForWorktree(id) ?? 0,
    diskUsage: new DiskUsage(),
  });
  const clone = new CloneService({ db, environment, git: gitCli, paths, ops, logger });
  const files = new FileService({ paths, git: gitCli, gitService: git });
  const terminals = new TerminalManager({
    dataDir: paths.dataDir,
    claudeBin: config.claudeBin,
    claudeConfigDir: config.claudeConfigDir,
    gitService: git,
    environment,
    logger,
  });
  const store = new SessionEventStore(db, bus);
  const claude = new ClaudeCli(config.claudeBin, paths.dataDir, logger, config.claudeConfigDir);
  const backend = await chooseBackend(config, terminals, logger, tmuxSocketResolver(config, environment));
  const commonConfig = new CommonConfigSync({ claudeConfigDir: config.claudeConfigDir, dataDir: paths.dataDir, web, logger });
  const sessions = new SessionManager({
    commonConfig,
    db,
    environment,
    bus,
    store,
    git,
    terminals,
    backend,
    web,
    logger,
    dataDir: paths.dataDir,
    claudeBin: config.claudeBin,
    claudeConfigDir: config.claudeConfigDir,
    autoResume: config.autoResume,
    hookBaseUrl: () => `http://127.0.0.1:${hookPort.value}`,
    onAuthProblem: () => {
      claude.invalidate();
      void claude.status({ refresh: true }).then((status) => bus.publish('claude.status', status, { channels: [GLOBAL] }));
    },
  });
  sessionsRef = sessions;
  const composer = new ComposerTools({ db, environment, git, gitCli, paths, claudeConfigDir: config.claudeConfigDir });
  const runs = new RunManager({ db, environment, bus, git, terminals, logger, claudeConfigDir: config.claudeConfigDir });
  runsRef = runs;

  const metrics = new MetricsCollector(paths.projectsRoot, () => ({
    sessions: { live: sessions.liveCount, max: environment.current?.maxConcurrentSessions ?? 4 },
    runs: runs.liveCount,
    terminals: terminals.liveCount,
  }));
  const uptime = new UptimeTracker(db, logger, () => {
    const current = environment.current;
    if (!current) throw environment.notServingError();
    return uptimeServiceKey({ id: current.id, isDefault: current.isDefault });
  });

  let tools: { at: number; value: { claudeVersion: string | null; gitVersion: string | null; tmuxVersion: string | null } } | null = null;
  const toolVersions = async () => {
    if (tools && Date.now() - tools.at < TOOLS_TTL_MS) return tools.value;
    const [gitInfo, tmuxVersion, claudeVersion] = await Promise.all([
      toolVersion('git', ['--version']),
      backend.kind === 'tmux' ? TmuxBackend.version() : Promise.resolve(null),
      claude.version().catch(() => null),
    ]);
    tools = { at: Date.now(), value: { claudeVersion, gitVersion: gitInfo.version, tmuxVersion } };
    return tools.value;
  };
  const heartbeat = async () => {
    try {
      await environment.refresh();
    } catch (error) {
      if (error instanceof RunnerFatalError) throw error;
      logger.warn({ err: error }, 'serveur : relecture impossible, battement écrit quand même');
    }
    await environment.heartbeat({ backend: backend.kind, tools: await toolVersions() });
  };

  const scheduler = new Scheduler({ db, environment, git, web, uptime, logger });
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
      environment: environment.ref(),
      state: environment.state,
      contractVersion: RUNNER_CONTRACT_VERSION,
    };
  };

  if (!config.token) throw new RunnerError('INTERNAL', 'RUNNER_TOKEN manquant.');
  return {
    config,
    logger,
    db,
    environment,
    bus,
    paths,
    gitCli,
    git,
    clone,
    files,
    composer,
    commonConfig,
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
    heartbeat,
  };
}
