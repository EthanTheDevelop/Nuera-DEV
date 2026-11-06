/**
 * TEST-ONLY — naming, ports and environment of a local test stack.
 *
 * Ports convention (one set per lot, never 3000/4100/4101 which belong to `pnpm dev`):
 *   web N · runner A N+1000 · hooks A N+1001 · fake GitHub N+1002 · runner B N+1010 · hooks B N+1011
 *   (runner of index k ≥ 1: N+1000+10k / N+1001+10k)     harness: 3201 / 4201 / 4202 / 4203 / 4211 / 4212
 * Database: `nuera_<name>` (dashes → underscores) on the local PostgreSQL of `pnpm db:local`, shared by
 * every runner of the stack (as in production).
 *
 * Accounts and servers (docs/MULTICOMPTE.md): account `a` = the owner (Camille Laurent, created through
 * /configuration) on runner `a` = the default server « VPS-3 » (RUNNER_URL / RUNNER_TOKEN, config 'env');
 * account `b` = a member (Hugo Martin, invited through /invitation/<jeton>) on runner `b` = « VPS-4 », a
 * registered server whose runner connects with a restricted PostgreSQL login role (RUNNER_DATABASE_URL).
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

/** Keys of the accounts / runners a stack can hold (`a` = owner + default server). */
export const STACK_KEYS = ['a', 'b', 'c', 'd'] as const;
export type StackKey = (typeof STACK_KEYS)[number];
/** Most accounts (and runners) a stack can hold. */
export const MAX_ACCOUNTS = STACK_KEYS.length;

export function isStackKey(value: string | undefined | null): value is StackKey {
  return typeof value === 'string' && (STACK_KEYS as readonly string[]).includes(value);
}

export function assertStackKey(value: string | undefined | null): StackKey {
  if (!isStackKey(value)) throw new Error(`Compte ou serveur inconnu « ${value ?? ''} » (${STACK_KEYS.join(', ')}).`);
  return value;
}

/** Keys of the first `count` accounts (1 → ['a'], 2 → ['a', 'b']). */
export function stackKeys(count: number): StackKey[] {
  if (!Number.isInteger(count) || count < 1 || count > MAX_ACCOUNTS) throw new Error(`Nombre de comptes invalide : ${count} (1 à ${MAX_ACCOUNTS}).`);
  return STACK_KEYS.slice(0, count);
}

export function keyIndex(key: StackKey): number {
  return STACK_KEYS.indexOf(key);
}

/** Default number of accounts (= runners) of a stack: 2 for the default `e2e` stack, 1 for ad-hoc stacks. */
export function defaultAccountCount(name: string): number {
  return name === 'e2e' ? 2 : 1;
}

export interface StackPorts {
  web: number;
  /** Runner A (default server). */
  runner: number;
  /** Hooks of runner A. */
  hook: number;
  github: number;
}

export interface RunnerPorts {
  runner: number;
  hook: number;
}

export interface OwnerIdentity {
  name: string;
  email: string;
  password: string;
}

export type AccountRole = 'owner' | 'admin' | 'member';

export interface AccountIdentity extends OwnerIdentity {
  key: StackKey;
  /** Role given at creation (`a` is the instance owner, the others are invited members). */
  role: AccountRole;
  /** Author of the commits made from Nuera Dev (Paramètres › Identité Git defaults to the account). */
  gitIdentity: { name: string; email: string };
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

/** Ports from the web port (convention above), with explicit overrides for runner A / GitHub. */
export function portsFor(web: number, overrides: Partial<StackPorts> = {}, runnerCount = 1): StackPorts {
  const ports: StackPorts = {
    web,
    runner: overrides.runner ?? web + 1000,
    hook: overrides.hook ?? web + 1001,
    github: overrides.github ?? web + 1002,
  };
  validatePorts(ports, runnerCount);
  return ports;
}

/** Ports of the runner `key` (runner A: the stack's runner/hook ports; k ≥ 1: web + 1000 + 10k / + 1001 + 10k). */
export function runnerPortsFor(ports: StackPorts, key: StackKey): RunnerPorts {
  const index = keyIndex(key);
  if (index === 0) return { runner: ports.runner, hook: ports.hook };
  return { runner: ports.web + 1000 + 10 * index, hook: ports.web + 1001 + 10 * index };
}

export function allPorts(ports: StackPorts, runnerCount = 1): number[] {
  const values = [ports.web, ports.github];
  for (const key of stackKeys(runnerCount)) {
    const runner = runnerPortsFor(ports, key);
    values.push(runner.runner, runner.hook);
  }
  return values;
}

export function validatePorts(ports: StackPorts, runnerCount = 1): void {
  const values = allPorts(ports, runnerCount);
  for (const port of values) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`Port invalide : ${port}.`);
    if (RESERVED_PORTS.has(port)) throw new Error(`Le port ${port} est réservé à \`pnpm dev\` : choisissez-en un autre.`);
  }
  if (new Set(values).size !== values.length) throw new Error(`Ports en double : ${values.join(', ')}.`);
}

const ACCOUNT_PEOPLE: Record<StackKey, { name: string; local: string; password: string; role: AccountRole }> = {
  a: { name: 'Camille Laurent', local: 'camille.laurent', password: TEST_OWNER_PASSWORD, role: 'owner' },
  b: { name: 'Hugo Martin', local: 'hugo.martin', password: 'Falaise-Grise-2026!', role: 'member' },
  c: { name: 'Inès Moreau', local: 'ines.moreau', password: 'Colline-Verte-2026!', role: 'member' },
  d: { name: 'Léo Garnier', local: 'leo.garnier', password: 'Prairie-Rousse-2026!', role: 'member' },
};

/** Test-only identity of an account of the stack (the TOTP secret is read during its enrolment). */
export function accountIdentity(name: string, key: StackKey): AccountIdentity {
  const person = ACCOUNT_PEOPLE[key];
  const email = `${person.local}@${assertStackName(name)}.nuera.test`;
  return { key, name: person.name, email, password: person.password, role: person.role, gitIdentity: { name: person.name, email } };
}

/** Owner of every test stack (account `a`). */
export function ownerIdentity(name: string): OwnerIdentity {
  const { name: displayName, email, password } = accountIdentity(name, 'a');
  return { name: displayName, email, password };
}

/** Server name of runner `key` (`a` keeps the migrated « VPS-3 » so that the Figma copy stays exact). */
export function runnerName(key: StackKey): string {
  return { a: 'VPS-3', b: 'VPS-4', c: 'VPS-5', d: 'VPS-6' }[key];
}

export interface StackUrls {
  /** Browser URL of the web app: ALWAYS localhost (next dev refuses dev resources on 127.0.0.1). */
  web: string;
  /** Runner A (default server). */
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

export function runnerUrlsFor(ports: RunnerPorts): { runner: string; hook: string } {
  return { runner: `http://127.0.0.1:${ports.runner}`, hook: `http://127.0.0.1:${ports.hook}` };
}

/** Folders of one runner (its own projects root, data dir, HOME and Claude config dir). */
export interface RunnerPaths {
  projects: string;
  runnerData: string;
  home: string;
  /** NUERA_CLAUDE_CONFIG_DIR of the runner = CLAUDE_CONFIG_DIR of every `claude` it starts (fake CLI state). */
  claudeConfig: string;
  /** Scripts of the fake CLI (`scenario:<name>`), see scenarios.ts. */
  claudeScenarios: string;
}

export interface StackLayout extends RunnerPaths {
  dir: string;
  stateFile: string;
  /** Account `a` (owner): credentials, TOTP secret, unused backup codes. */
  ownerFile: string;
  /** Account `a`: cookies of a signed-in browser. */
  storageState: string;
  /** accounts/<key>.json of the other accounts. */
  accounts: string;
  lockFile: string;
  logs: string;
  remotes: string;
  github: string;
  playwright: string;
  shots: string;
  tmp: string;
}

export function runnerPathsFor(dir: string, key: StackKey): RunnerPaths {
  const base = key === 'a' ? dir : path.join(dir, `runner-${key}`);
  const home = path.join(base, 'home');
  const claudeConfig = path.join(home, '.claude');
  return {
    projects: path.join(base, 'projects'),
    runnerData: path.join(base, 'runner-data'),
    home,
    claudeConfig,
    claudeScenarios: path.join(claudeConfig, 'nuera-fake-scenarios'),
  };
}

export function layoutFor(name: string): StackLayout {
  const dir = stackDir(name);
  return {
    dir,
    ...runnerPathsFor(dir, 'a'),
    stateFile: path.join(dir, 'state.json'),
    ownerFile: path.join(dir, 'owner.json'),
    storageState: path.join(dir, 'storage-state.json'),
    accounts: path.join(dir, 'accounts'),
    lockFile: path.join(dir, '.lock'),
    logs: path.join(dir, 'logs'),
    remotes: path.join(dir, 'remotes'),
    github: path.join(dir, 'github'),
    playwright: path.join(dir, 'playwright'),
    shots: path.join(dir, 'shots'),
    tmp: path.join(dir, 'tmp'),
  };
}

/** Credentials file and storage state of an account (`a` keeps owner.json / storage-state.json). */
export function accountFiles(layout: Pick<StackLayout, 'dir' | 'ownerFile' | 'storageState' | 'accounts'>, key: StackKey): { stateFile: string; storageState: string } {
  if (key === 'a') return { stateFile: layout.ownerFile, storageState: layout.storageState };
  return { stateFile: path.join(layout.accounts, `${key}.json`), storageState: path.join(layout.dir, `storage-state-${key}.json`) };
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
  /** RUNNER_TOKEN of runner A (default server; also its Bearer for /api/internal/*). */
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
  // Nuera settings of the parent shell (NUERA_ENVIRONMENT_ID, NUERA_REQUIRE_2FA, RUNNER_DATABASE_URL…)
  // would bind a stack's runner to another server or change the web's policies.
  /^NUERA_/,
  /^RUNNER_/,
  /^DATABASE_/,
  /^APP_ENCRYPTION_/,
  /^BETTER_AUTH_/,
  /^SETUP_TOKEN$/,
];
/** Credential-bearing prefixes blanked when the root `.env` defines them (next dev / the runner would read them). */
const BLANKED_PREFIXES = ['GITHUB_', 'COOLIFY_', 'FIGMA_', 'VAPID_', 'ANTHROPIC_', 'CLAUDE_CODE_'];

export interface StackEnvInput {
  name: string;
  ports: StackPorts;
  urls: StackUrls;
  /** Full DSN of the stack database (web, migrations, runner A). */
  databaseUrl: string;
  secrets: StackSecrets;
  layout: StackLayout;
  scheduler: boolean;
  ownerEmail: string;
}

/** One runner of the stack, as its process needs it. */
export interface RunnerEnvInput {
  key: StackKey;
  ports: RunnerPorts;
  token: string;
  paths: RunnerPaths;
  /** Server id, asserted by the runner at boot (NUERA_ENVIRONMENT_ID); null for the default server. */
  environmentId: string | null;
  /** RUNNER_DATABASE_URL (restricted login role); null = the full DSN (default server). */
  databaseUrl: string | null;
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

/** Variables every runner of the stack shares. */
function runnerSharedEnv(input: StackEnvInput): Record<string, string> {
  return {
    APP_URL: input.urls.web,
    RUNNER_HOST: '127.0.0.1',
    NUERA_WEB_INTERNAL_URL: input.urls.web,
    NUERA_SESSION_BACKEND: 'pty',
    NUERA_CLAUDE_BIN: FAKE_CLAUDE_BIN,
    NUERA_GIT_REMOTE_BASE: remoteBaseUrl(input.layout.remotes),
    NUERA_SCHEDULER: input.scheduler ? '1' : '0',
    NUERA_DB_POOL_MAX: '5',
    LOG_LEVEL: 'info',
    DATABASE_CONNECT_TIMEOUT: '60',
    // Automatic resumption after the usage limit: 2 s after the reset the fake CLI announces
    // (instead of 2 min), so an e2e sees the scheduled resumption fire.
    NUERA_AUTO_RESUME_MARGIN_SECONDS: '2',
  };
}

export function runnerEnv(input: StackEnvInput, runner: RunnerEnvInput): Record<string, string> {
  // A non-default server never receives the full DSN (MULTICOMPTE §11): DATABASE_URL is its restricted DSN too.
  const database = runner.databaseUrl ?? input.databaseUrl;
  const explicit: Record<string, string> = {
    ...runnerSharedEnv(input),
    DATABASE_URL: database,
    // Defined even when empty: the runner's loadDotEnv never fills them from the repository's .env.
    RUNNER_DATABASE_URL: runner.databaseUrl ?? '',
    RUNNER_TOKEN: runner.token,
    RUNNER_PORT: String(runner.ports.runner),
    RUNNER_HOOK_PORT: String(runner.ports.hook),
    NUERA_ENVIRONMENT_ID: runner.environmentId ?? '',
    NUERA_PROJECTS_ROOT: runner.paths.projects,
    NUERA_DATA_DIR: runner.paths.runnerData,
    NODE_ENV: 'development',
    // Isolated home: the test CLI writes its journals under its Claude config dir, git ignores ~/.gitconfig.
    HOME: runner.paths.home,
    USERPROFILE: runner.paths.home,
    NUERA_CLAUDE_CONFIG_DIR: runner.paths.claudeConfig,
    CLAUDE_CONFIG_DIR: runner.paths.claudeConfig,
    DISABLE_AUTOUPDATER: '1',
  };
  return { ...baseEnv(new Set(Object.keys(explicit))), ...explicit };
}

export function webEnv(input: StackEnvInput): Record<string, string> {
  const explicit = {
    DATABASE_URL: input.databaseUrl,
    APP_URL: input.urls.web,
    // The default server (runner A): config_source 'env'.
    RUNNER_URL: input.urls.runner,
    RUNNER_TOKEN: input.secrets.runnerToken,
    NUERA_WEB_INTERNAL_URL: input.urls.web,
    NUERA_SCHEDULER: input.scheduler ? '1' : '0',
    // The web clock of the integration checks (instrumentation.ts) only runs with --scheduler.
    NUERA_WEB_SCHEDULER: input.scheduler ? 'on' : 'off',
    // Fake Coolify / MCP servers and the runners of the stack listen on the loopback (SSRF guard).
    NUERA_PRIVATE_HOSTS: '127.0.0.1,localhost,::1',
    LOG_LEVEL: 'info',
    DATABASE_CONNECT_TIMEOUT: '60',
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
    // « Aperçu »: the app runs on localhost:<port>, the preview on 127.0.0.1:<same port> — two
    // distinct origins (and sites) served by the same next dev. E2E_PREVIEW_HOST overrides it ('' = off).
    PREVIEW_HOST: process.env.E2E_PREVIEW_HOST ?? `127.0.0.1:${new URL(input.urls.web).port}`,
  };
  return { ...baseEnv(new Set(Object.keys(explicit))), ...explicit };
}

export function githubEnv(): Record<string, string> {
  return baseEnv(new Set());
}
