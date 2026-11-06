import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Database } from '@nuera/db';
import type { Logger } from 'pino';
import type { RunnerConfig } from './config';
import { RunnerFatalError } from './environment';
import { installBearerAuth, installEnvironmentGuard, installErrorHandling } from './http/route';
import { registerPreviewProxy } from './preview/proxy';
import { registerRoutes } from './routes';
import { createServices, type RunnerServices } from './services';
import { buildHookServer } from './sessions/hook-server';

export interface Runner {
  services: RunnerServices;
  api: FastifyInstance;
  hooks: FastifyInstance;
  /**
   * Boot (docs/MULTICOMPTE.md §4): hook listener → server lookup by token → standby while unknown →
   * exclusive lease → folder markers → reconciliation of THIS server → API → scheduler. Resolves
   * once the API listens; in standby (unknown token, lease held elsewhere) the API listens at once
   * (health only) and the boot goes on in the background (see {@link ready}).
   */
  start(options?: { listen?: boolean }): Promise<{ apiUrl: string | null; hookUrl: string | null }>;
  /** Resolves when the runner serves its server; rejects on a fatal configuration error. */
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

export interface BuildRunnerOptions {
  logger: Logger;
  db?: Database;
  /** Standby polling delay (unknown token, lease held by another runner). 15 s; tests shorten it. */
  standbyRetryMs?: number;
  /**
   * Server heartbeat period (`environments.last_seen_at`, status and settings re-read). 60 s; it
   * runs whether NUERA_SCHEDULER is on or off. Tests shorten it.
   */
  heartbeatIntervalMs?: number;
  /**
   * A fatal error after start() returned (marker of another server, NUERA_ENVIRONMENT_ID mismatch
   * found in standby, lease lost): the process must stop. Default: logged only.
   */
  onFatal?: (error: Error) => void;
}

export async function buildRunner(config: RunnerConfig, options: BuildRunnerOptions): Promise<Runner> {
  const services = await createServices(config, options);
  const { logger, environment } = services;
  const retryMs = options.standbyRetryMs ?? 15_000;
  const heartbeatMs = options.heartbeatIntervalMs ?? 60_000;

  const api: FastifyInstance = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    bodyLimit: 2 * 1024 * 1024,
    // SSE streams stay open; per-route timeouts are enforced by the operations themselves.
    requestTimeout: 0,
    keepAliveTimeout: 10_000,
  });
  installErrorHandling(api);
  installBearerAuth(api, config.token);
  installEnvironmentGuard(api, environment);
  registerRoutes(api, services);
  // « Aperçu »: raw relay to the dev server of a live `dev` run (any method, streamed bodies).
  registerPreviewProxy(api, { runs: services.runs, logger, token: config.token, environment });

  const hooks = buildHookServer(services.sessions, logger);

  let closing = false;
  let readyResolve: () => void = () => undefined;
  let readyReject: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Observed here so that a fatal error never becomes an unhandled rejection.
  ready.catch(() => undefined);
  let standbyTimer: ReturnType<typeof setTimeout> | null = null;
  let leaseWatch: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let fatalError: Error | null = null;

  const fatal = (error: Error) => {
    // Once: a fatal identity change can surface through several paths at the same time.
    if (fatalError) return;
    fatalError = error;
    logger.fatal({ err: error }, error.message);
    readyReject(error);
    options.onFatal?.(error);
  };
  // A periodic or on-demand re-read of the row that finds the token on another server's row (or on
  // several) stops the process, exactly like the same finding at boot.
  environment.onFatal((error) => {
    if (!closing) fatal(error);
  });

  let beating = false;
  const beat = async () => {
    if (beating || closing) return;
    beating = true;
    try {
      await services.heartbeat();
    } catch (error) {
      // RunnerFatalError went through environment.onFatal already.
      if (!(error instanceof RunnerFatalError)) logger.warn({ err: error }, 'battement du serveur impossible');
    } finally {
      beating = false;
    }
  };

  /** Lease → markers → reconciliation of this server only. */
  const bootRegistered = async () => {
    environment.setPhase('starting');
    const current = environment.current!;
    logger.setBindings({ environmentId: current.id });
    await environment.claimMarkers({ dataDir: config.dataDir, projectsRoot: config.projectsRoot });
    const [interruptedOps, interruptedRuns, sessions, gap] = await Promise.all([
      services.ops.failInterrupted(),
      services.runs.markInterrupted(),
      services.sessions.reconcile(),
      services.uptime.detectGap().catch(() => null),
    ]);
    logger.info({ environment: current.name, interruptedOps, interruptedRuns, ...sessions, gap: Boolean(gap) }, "état d'exécution réconcilié");
  };

  const afterReady = () => {
    environment.setPhase('ready');
    if (config.schedulerEnabled) services.scheduler.start();
    // The server heartbeat is not a scheduler job: last_seen_at stays fresh with NUERA_SCHEDULER=0.
    void beat();
    heartbeatTimer = setInterval(() => void beat(), heartbeatMs);
    heartbeatTimer.unref?.();
    // Claude status of every account of the server (each with its own CLI config folder, lot P1).
    void services.accounts
      .all()
      .then((accounts) => Promise.all(accounts.map((account) => services.claude.status(account).catch(() => undefined))))
      .catch(() => undefined);
    // Folders of accounts removed from this server while it was unreachable: signed out and removed.
    void services.accounts.sweep((account) => services.claude.signOut(account)).catch(() => undefined);
    // Common Claude configuration of each account (rules, skills): written before the first session.
    void services.commonConfig.syncAll('start').catch(() => undefined);
    // The lease lives on one connection: if it dies, another runner may take the server over.
    leaseWatch = setInterval(() => {
      void environment.checkLease().then((alive) => {
        if (alive || closing) return;
        if (leaseWatch) clearInterval(leaseWatch);
        fatal(new RunnerFatalError("Bail du serveur perdu (connexion à la base coupée) : le runner s'arrête pour ne jamais tourner en double."));
      });
    }, 60_000);
    leaseWatch.unref?.();
    readyResolve();
  };

  /** One standby attempt: lookup (when unknown), then the lease. true once both are held. */
  const tryRegister = async (): Promise<boolean> => {
    if (environment.phase === 'unregistered') {
      const found = await environment.resolve();
      if (!found) return false;
      logger.info({ environmentId: found.id, environment: found.name }, 'serveur trouvé pour ce jeton');
    }
    if (await environment.tryAcquireLease()) return true;
    logger.warn({ environment: environment.current?.name }, environment.notServingError().message);
    return false;
  };

  const standbyLoop = () => {
    if (closing) return;
    standbyTimer = setTimeout(() => {
      standbyTimer = null;
      void (async () => {
        if (closing) return;
        let registered = false;
        try {
          registered = await tryRegister();
        } catch (error) {
          if (error instanceof RunnerFatalError) return fatal(error);
          logger.warn({ err: error }, 'serveur : nouvel essai dans 15 s');
        }
        if (!registered) return standbyLoop();
        try {
          await bootRegistered();
        } catch (error) {
          return fatal(error instanceof Error ? error : new Error(String(error)));
        }
        if (!closing) afterReady();
      })();
    }, retryMs);
    standbyTimer.unref?.();
  };

  const runner: Runner = {
    services,
    api,
    hooks,
    ready,
    async start(startOptions = {}) {
      const listen = startOptions.listen ?? true;
      let hookUrl: string | null = null;
      let apiUrl: string | null = null;
      if (listen) {
        // The hook listener is bound to the loopback interface only.
        await hooks.listen({ host: '127.0.0.1', port: config.hookPort });
        const address = hooks.server.address();
        if (address && typeof address === 'object') services.hookPort.value = address.port;
        hookUrl = `http://127.0.0.1:${services.hookPort.value}`;
      } else {
        await hooks.ready();
      }
      const listenApi = async () => {
        if (listen) apiUrl = await api.listen({ host: config.host, port: config.port });
        else await api.ready();
      };

      let registered: boolean;
      try {
        registered = await tryRegister();
      } catch (error) {
        if (error instanceof RunnerFatalError) {
          readyReject(error);
          throw error;
        }
        logger.warn({ err: error }, 'serveur : recherche impossible, nouvel essai dans 15 s');
        registered = false;
      }
      if (!registered) {
        if (environment.phase === 'unregistered') {
          logger.warn({ fingerprint: environment.fingerprint }, environment.notServingError().message);
        }
        // Standby: health only, the boot goes on once the server is registered and free.
        await listenApi();
        standbyLoop();
        return { apiUrl, hookUrl };
      }
      try {
        await bootRegistered();
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        readyReject(failure);
        throw failure;
      }
      await listenApi();
      afterReady();
      return { apiUrl, hookUrl };
    },
    async close() {
      if (closing) return;
      closing = true;
      if (standbyTimer) clearTimeout(standbyTimer);
      if (leaseWatch) clearInterval(leaseWatch);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      services.scheduler.stop();
      await services.sessions.shutdown().catch((error: unknown) => logger.warn({ err: error }, 'arrêt des sessions'));
      await services.runs.stopAll().catch(() => undefined);
      await services.terminals.closeAll().catch(() => undefined);
      await Promise.allSettled([api.close(), hooks.close()]);
      await environment.releaseLease().catch(() => undefined);
      const client = (services.db as unknown as { $client?: { end?: (o?: { timeout?: number }) => Promise<void> } }).$client;
      await client?.end?.({ timeout: 5 }).catch(() => undefined);
    },
  };
  return runner;
}
