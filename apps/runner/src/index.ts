import { buildRunner } from './app';
import { loadConfig, loadDotEnv } from './config';
import { createLogger } from './logger';

loadDotEnv();
const config = loadConfig();
const logger = createLogger(config.logLevel, config.env === 'development' && process.stdout.isTTY);

const runner = await buildRunner(config, { logger });
const { apiUrl, hookUrl } = await runner.start();
logger.info({ apiUrl, hookUrl, projectsRoot: config.projectsRoot, dataDir: config.dataDir, backend: runner.services.backend.kind }, 'runner prêt');

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'arrêt du runner : les sessions tmux restent actives');
  const force = setTimeout(() => process.exit(1), 20_000);
  force.unref();
  await runner.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'promesse rejetée non gérée'));
