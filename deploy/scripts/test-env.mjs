#!/usr/bin/env node
/**
 * Writes deploy/.env.test (git-ignored, mode 600) for the LOCAL compose trial (deploy/docker-compose.test.yml):
 * fresh random secrets, the bundled PostgreSQL, APP_URL on http://localhost:<port>. Never used in production.
 *   node deploy/scripts/test-env.mjs [--port 3510] [--remotes /abs/bare-repos] [--ca /abs/ca.crt]
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const deployDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(arg('port', '3510'));
const remotes = path.resolve(arg('remotes', path.join(deployDir, '.test-remotes')));
const ca = arg('ca', '');
const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
const pgPassword = secret(18);

const env = {
  NUERA_IMAGE_TAG: 'test',
  NUERA_TEST_WEB_PORT: String(port),
  NUERA_TEST_REMOTES: remotes,
  NUERA_TEST_PG_PASSWORD: pgPassword,
  DATABASE_URL: `postgres://nuera:${pgPassword}@postgres:5432/nuera`,
  APP_URL: `http://localhost:${port}`,
  RUNNER_TOKEN: secret(32),
  BETTER_AUTH_SECRET: secret(32),
  APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SETUP_TOKEN: secret(18),
  RUNNER_CPUS: '2',
  RUNNER_MEMORY: '2g',
  ...(ca ? { NUERA_TEST_CA_FILE: path.resolve(ca), NUERA_TEST_CA_IN_CONTAINER: '/etc/nuera-test-ca.crt' } : {}),
};
const target = path.join(deployDir, '.env.test');
writeFileSync(target, `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n')}\n`, { mode: 0o600 });
console.info(`${path.relative(process.cwd(), target)} écrit (secrets aléatoires, essai local uniquement).`);
