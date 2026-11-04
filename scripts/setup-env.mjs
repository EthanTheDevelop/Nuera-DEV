#!/usr/bin/env node
/**
 * Creates .env from .env.example with freshly generated secrets (dev convenience).
 * Never overwrites an existing .env unless --force is given.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, '.env');
const force = process.argv.includes('--force');

if (existsSync(target) && !force) {
  console.info('.env existe déjà (utilisez --force pour le régénérer).');
  process.exit(0);
}

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
const generated = {
  RUNNER_TOKEN: secret(32),
  BETTER_AUTH_SECRET: secret(32),
  APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SETUP_TOKEN: secret(18),
};

const lines = readFileSync(path.join(root, '.env.example'), 'utf8')
  .split(/\r?\n/)
  .map((line) => {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) return line;
    const [, key] = match;
    if (key && key in generated) return `${key}=${generated[key]}`;
    return line;
  });

writeFileSync(target, lines.join('\n'), { mode: 0o600 });
console.info('.env créé avec des secrets aléatoires.');
console.info(`Jeton de configuration initiale (page /configuration) : ${generated.SETUP_TOKEN}`);
