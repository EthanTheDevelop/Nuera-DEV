import { buildRunner } from './app';
import { loadConfig, loadDotEnv } from './config';
import { createLogger } from './logger';

loadDotEnv();
const config = loadConfig();
const logger = createLogger(config.logLevel, config.env === 'development' && process.stdout.isTTY);

let stopping = false;
const shutdown = async (signal: string, exitCode = 0) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'arrêt du runner : les sessions tmux restent actives');
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  await runner.close();
  process.exit(exitCode);
};

// A fatal configuration error (another server's folder, NUERA_ENVIRONMENT_ID mismatch, lost lease)
// stops the process: the orchestrator restarts it once the configuration is fixed.
const runner = await buildRunner(config, { logger, onFatal: () => void shutdown('fatal', 1) });
try {
  const { apiUrl, hookUrl } = await runner.start();
  const environment = runner.services.environment;
  logger.info(
    {
      apiUrl,
      hookUrl,
      projectsRoot: config.projectsRoot,
      dataDir: config.dataDir,
      backend: runner.services.backend.kind,
      environment: environment.ref(),
      state: environment.state,
      ...(environment.state === 'unregistered' ? { fingerprint: environment.fingerprint } : {}),
    },
    environment.serving ? 'runner prêt' : 'runner en attente (santé seulement)',
  );
} catch (error) {
  logger.fatal({ err: error }, error instanceof Error ? error.message : 'démarrage du runner impossible');
  await runner.close().catch(() => undefined);
  process.exit(1);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'promesse rejetée non gérée'));
