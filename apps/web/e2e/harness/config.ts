/**
 * TEST-ONLY — naming, ports and environment of a local test stack.
 *
 * Ports convention (one set per lot, never 3000/4100/4101 which belong to `pnpm dev`):
 *   web N · runner N+1000 · hook N+1001 · fake GitHub N+1002   (harness: 3201 / 4201 / 4202 / 4203)
 * Database: `nuera_<name>` (dashes → underscores) on the local PostgreSQL of `pnpm db:local`.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { FAKE_CLAUDE_BIN, ROOT_ENV_FILE, STACKS_ROOT } from './paths';

export const RESERVED_PORTS = new Set([3000, 4100, 4101]);

/** Web ports of the stacks known in advance (others must pass --web-port once). */
export const DEFAULT_WEB_PORTS: Readonly<Record<string, number>> = { e2e: 3102, harness: 3201, harness2: 3291 };

export const DEFAULT_PG_ADMIN_URL = 'postgres://nuera:nuera@127.0.0.1:54329/postgres';

/** SETUP_TOKEN given to every test stack (test-only value, same as the historical e2e one). */
export const TEST_SETUP_TOKEN = 'e2e-jeton-configuration-0123456789';
export const TEST_OWNER_PASSWORD = 'Riviere-Bleue-2026!';

export interface StackPorts {
  web: number;
  runner: number;
  hook: number;
  github: number;
}

export interface OwnerIdentity {
  name: string;
  email: string;
  password: string;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

export function assertStackName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Nom de pile invalide « ${name} » : lettres minuscules, chiffres et tirets (32 caractères au plus).`);
  }
  return name;
}

export function stackDir(name: string): string {
  return path.join(STACKS_ROOT, assertStackName(name));
}

export function defaultDatabaseName(name: string): string {
  return `nuera_${assertStackName(name).replace(/-/g, '_')}`;
}

export function assertDatabaseName(db: string): string {
  if (!/^[a-z0-9_]{1,60}$/.test(db)) throw new Error(`Nom de base invalide « ${db} » (a-z, 0-9, _).`);
  if (db === 'nuera_dev' || db === 'postgres') throw new Error(`La base « ${db} » n'appartient pas aux piles de test.`);
  return db;
}

/** Ports from the web port (convention above), with explicit overrides. */
export function portsFor(web: number, overrides: Partial<StackPorts> = {}): StackPorts {
  const ports: StackPorts = {
    web,
    runner: overrides.runner ?? web + 1000,
    hook: overrides.hook ?? web + 1001,
    github: overrides.github ?? web + 1002,
  };
  validatePorts(ports);
  return ports;
}

export function validatePorts(ports: StackPorts): void {
  const values = [ports.web, ports.runner, ports.hook, ports.github];
  for (const port of values) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Port invalide : ${port}.`);
    if (RESERVED_PORTS.has(port)) throw new Error(`Le port ${port} est réservé à \`pnpm dev\` : choisissez-en un autre.`);
  }
  if (new Set(values).size !== values.length) throw new Error(`Ports en double : ${values.join(', ')}.`);
}

/** Owner of every test stack (test-only credentials, the TOTP secret is read during the setup). */
export function ownerIdentity(name: string): OwnerIdentity {
  return { name: 'Camille Laurent', email: `camille.laurent@${assertStackName(name)}.nuera.test`, password: TEST_OWNER_PASSWORD };
}

export interface StackUrls {
  /** Browser URL of the web app: ALWAYS localhost (next dev refuses dev resources on 127.0.0.1). */
  web: string;
  runner: string;
  hook: string;
  /** Fake GitHub REST API (GitHub Enterprise-like prefix so that web pages and API never collide). */
  githubApi: string;
  /** Fake github.com pages (manifest confirmation, installation pages). */
  githubWeb: string;
}

export function urlsFor(ports: StackPorts): StackUrls {
  return {
    web: `http://localhost:${ports.web}`,
    runner: `http://127.0.0.1:${ports.runner}`,
    hook: `http://127.0.0.1:${ports.hook}`,
    githubApi: `http://127.0.0.1:${ports.github}/api/v3`,
    githubWeb: `http://127.0.0.1:${ports.github}`,
  };
}

export interface StackLayout {
  dir: string;
  stateFile: string;
  ownerFile: string;
  storageState: string;
  lockFile: string;
  logs: string;
  remotes: string;
  projects: string;
  runnerData: string;
  home: string;
  claudeConfig: string;
  /** Scripts of the fake CLI (`scenario:<name>`), see scenarios.ts. */
  claudeScenarios: string;
  github: string;
  playwright: string;
  shots: string;
  tmp: string;
}

export function layoutFor(name: string): StackLayout {
  const dir = stackDir(name);
  const home = path.join(dir, 'home');
  const claudeConfig = path.join(home, '.claude');
  return {
    dir,
    stateFile: path.join(dir, 'state.json'),
    ownerFile: path.join(dir, 'owner.json'),
    storageState: path.join(dir, 'storage-state.json'),
    lockFile: path.join(dir, '.lock'),
    logs: path.join(dir, 'logs'),
    remotes: path.join(dir, 'remotes'),
    projects: path.join(dir, 'projects'),
    runnerData: path.join(dir, 'runner-data'),
    home,
    claudeConfig,
    claudeScenarios: path.join(claudeConfig, 'nuera-fake-scenarios'),
    github: path.join(dir, 'github'),
    playwright: path.join(dir, 'playwright'),
    shots: path.join(dir, 'shots'),
    tmp: path.join(dir, 'tmp'),
  };
}

/** `file:///P:/…/remotes/` — base of the fake remotes (NUERA_GIT_REMOTE_BASE). */
export function remoteBaseUrl(remotesDir: string): string {
  return `${pathToFileURL(remotesDir).href.replace(/\/+$/, '')}/`;
}

export function databaseUrl(adminUrl: string, db: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${db}`;
  return url.toString();
}

export interface StackSecrets {
  runnerToken: string;
  betterAuthSecret: string;
  appEncryptionKey: string;
  setupToken: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
}

/** Keys of the repository-root `.env` (never read for their values: only to keep them out of a stack). */
export function rootEnvKeys(file = ROOT_ENV_FILE): string[] {
  if (!existsSync(file)) return [];
  try {
    return Object.keys(parseEnv(readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

/** Variables of the parent process that must not reach a stack process. */
const INHERITED_DROP = [
  /^E2E_/,
  /^PLAYWRIGHT_/,
  /^PW_/,
  /^TEST_/,
  /^npm_/i,
  /^PNPM_/,
  /^NODE_OPTIONS$/,
  /^NODE_ENV$/,
  /^TSX_/,
  /^VITEST/,
  /^__NEXT/,
  /^NEXT_/,
  // A Claude Code session (or any Anthropic tooling) running the harness must not leak into the stack.
  /^CLAUDE/,
  /^ANTHROPIC_/,
  /^GIT_/,
];
/** Credential-bearing prefixes blanked when the root `.env` defines them (next dev / the runner would read them). */
const BLANKED_PREFIXES = ['GITHUB_', 'COOLIFY_', 'FIGMA_', 'VAPID_', 'ANTHROPIC_', 'CLAUDE_CODE_'];

export interface StackEnvInput {
  name: string;
  ports: StackPorts;
  urls: StackUrls;
  databaseUrl: string;
  secrets: StackSecrets;
  layout: StackLayout;
  scheduler: boolean;
  ownerEmail: string;
}

function baseEnv(explicitKeys: Set<string>): Record<string, string> {
  const env: Record<string, string> = {};
  const fromRootEnv = new Set(rootEnvKeys());
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (INHERITED_DROP.some((pattern) => pattern.test(key))) continue;
    // A shell that exported the development values (`DATABASE_URL=…nuera_dev`) must not win.
    if (fromRootEnv.has(key) || explicitKeys.has(key)) continue;
    env[key] = value;
  }
  // Defined-but-empty keeps @next/env and the runner's loadDotEnv from filling them from the root .env.
  for (const key of fromRootEnv) {
    if (!explicitKeys.has(key) && BLANKED_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = '';
  }
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  return env;
}

/** Variables shared by the runner and the web (everything the root `.env` could otherwise provide). */
function sharedEnv(input: StackEnvInput): Record<string, string> {
  return {
    DATABASE_URL: input.databaseUrl,
    APP_URL: input.urls.web,
    RUNNER_URL: input.urls.runner,
    RUNNER_TOKEN: input.secrets.runnerToken,
    RUNNER_HOST: '127.0.0.1',
    RUNNER_PORT: String(input.ports.runner),
    RUNNER_HOOK_PORT: String(input.ports.hook),
    NUERA_WEB_INTERNAL_URL: input.urls.web,
    NUERA_PROJECTS_ROOT: input.layout.projects,
    NUERA_DATA_DIR: input.layout.runnerData,
    NUERA_SESSION_BACKEND: 'pty',
    NUERA_CLAUDE_BIN: FAKE_CLAUDE_BIN,
    NUERA_GIT_REMOTE_BASE: remoteBaseUrl(input.layout.remotes),
    NUERA_SCHEDULER: input.scheduler ? '1' : '0',
    LOG_LEVEL: 'info',
    DATABASE_CONNECT_TIMEOUT: '60',
  };
}

export function runnerEnv(input: StackEnvInput): Record<string, string> {
  const explicit = {
    ...sharedEnv(input),
    NODE_ENV: 'development',
    // Isolated home: the test CLI writes its journals under CLAUDE_CONFIG_DIR, git ignores ~/.gitconfig.
    HOME: input.layout.home,
    USERPROFILE: input.layout.home,
    CLAUDE_CONFIG_DIR: input.layout.claudeConfig,
    DISABLE_AUTOUPDATER: '1',
  };
  return { ...baseEnv(new Set(Object.keys(explicit))), ...explicit };
}

export function webEnv(input: StackEnvInput): Record<string, string> {
  const explicit = {
    ...sharedEnv(input),
    NEXT_DIST_DIR: `.next-${input.name}`,
    NEXT_TELEMETRY_DISABLED: '1',
    BETTER_AUTH_SECRET: input.secrets.betterAuthSecret,
    APP_ENCRYPTION_KEY: input.secrets.appEncryptionKey,
    SETUP_TOKEN: input.secrets.setupToken,
    VAPID_PUBLIC_KEY: input.secrets.vapidPublicKey,
    VAPID_PRIVATE_KEY: input.secrets.vapidPrivateKey,
    VAPID_SUBJECT: `mailto:${input.ownerEmail}`,
    GITHUB_API_URL: input.urls.githubApi,
    GITHUB_WEB_URL: input.urls.githubWeb,
    GITHUB_FALLBACK_TOKEN: '',
    NUERA_RATE_LIMIT_FACTOR: '50',
    NUERA_KIT_PUBLIC: '1',
  };
  return { ...baseEnv(new Set(Object.keys(explicit))), ...explicit };
}

export function githubEnv(): Record<string, string> {
  return baseEnv(new Set());
}
