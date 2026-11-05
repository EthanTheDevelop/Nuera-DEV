import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Database } from '@nuera/db';
import type { Logger } from 'pino';
import type { RunnerConfig } from './config';
import { installBearerAuth, installErrorHandling } from './http/route';
import { registerRoutes } from './routes';
import { createServices, type RunnerServices } from './services';
import { buildHookServer } from './sessions/hook-server';

export interface Runner {
  services: RunnerServices;
  api: FastifyInstance;
  hooks: FastifyInstance;
  /** Reconciliation (sessions, operations, runs) + listeners + scheduler. */
  start(options?: { listen?: boolean }): Promise<{ apiUrl: string | null; hookUrl: string | null }>;
  close(): Promise<void>;
}

export async function buildRunner(config: RunnerConfig, options: { logger: Logger; db?: Database }): Promise<Runner> {
  const services = await createServices(config, options);
  const { logger } = services;

  const api: FastifyInstance = Fastify({
    loggerInstance: logger as unknown as FastifyBaseLogger,
    bodyLimit: 2 * 1024 * 1024,
    // SSE streams stay open; per-route timeouts are enforced by the operations themselves.
    requestTimeout: 0,
    keepAliveTimeout: 10_000,
  });
  installErrorHandling(api);
  installBearerAuth(api, config.token);
  registerRoutes(api, services);

  const hooks = buildHookServer(services.sessions, logger);

  let closing = false;
  const runner: Runner = {
    services,
    api,
    hooks,
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
      const [interruptedOps, interruptedRuns, sessions, gap] = await Promise.all([
        services.ops.failInterrupted(),
        services.runs.markInterrupted(),
        services.sessions.reconcile(),
        services.uptime.detectGap().catch(() => null),
      ]);
      logger.info({ interruptedOps, interruptedRuns, ...sessions, gap: Boolean(gap) }, "état d'exécution réconcilié");
      if (listen) {
        apiUrl = await api.listen({ host: config.host, port: config.port });
      } else {
        await api.ready();
      }
      if (config.schedulerEnabled) services.scheduler.start();
      void services.claude.status().catch(() => undefined);
      return { apiUrl, hookUrl };
    },
    async close() {
      if (closing) return;
      closing = true;
      services.scheduler.stop();
      await services.sessions.shutdown().catch((error: unknown) => logger.warn({ err: error }, 'arrêt des sessions'));
      await services.runs.stopAll().catch(() => undefined);
      await services.terminals.closeAll().catch(() => undefined);
      await Promise.allSettled([api.close(), hooks.close()]);
      const client = (services.db as unknown as { $client?: { end?: (o?: { timeout?: number }) => Promise<void> } }).$client;
      await client?.end?.({ timeout: 5 }).catch(() => undefined);
    },
  };
  return runner;
}
