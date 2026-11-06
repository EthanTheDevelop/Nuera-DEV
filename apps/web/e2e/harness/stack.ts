/**
 * TEST-ONLY — lifecycle of a local test stack (`.data/stacks/<name>/`): database, fake GitHub (several
 * apps), runners (from source, PTY backend, fake Claude CLI — one per server), web (`next dev`),
 * accounts, GitHub sources, seeds. Driven by `stack.mjs` (CLI) and by the Playwright global setup /
 * fixtures.
 *
 * A stack holds N accounts and N servers (`up --accounts N`, E2E_ACCOUNTS): account `a` is the owner,
 * created through /configuration, whose space gets the default server « VPS-3 » (runner `a`,
 * RUNNER_URL/RUNNER_TOKEN); every other account `k` is invited by the owner through the
 * administration (/invitation/<jeton>, mandatory 2FA) with its own server (runner `k`, registered by
 * the administration: one-time token, restricted PostgreSQL login role) and its own GitHub source.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import {
  DEFAULT_PG_ADMIN_URL,
  DEFAULT_WEB_PORTS,
  TEST_SETUP_TOKEN,
  accountFiles,
  accountIdentity,
  allPorts,
  assertDatabaseName,
  assertStackName,
  databaseUrl,
  defaultAccountCount,
  defaultDatabaseName,
  githubEnv,
  layoutFor,
  portsFor,
  runnerEnv,
  runnerName,
  runnerPathsFor,
  runnerPortsFor,
  runnerUrlsFor,
  stackKeys,
  urlsFor,
  webEnv,
  type RunnerEnvInput,
  type StackEnvInput,
  type StackKey,
  type StackLayout,
  type StackPorts,
} from './config';
import { databaseExists, dropDatabase, ensureDatabase, migrate, postgresReachable, withStackDb } from './db';
import { FIXTURE_ACCOUNTS, fixtureGithubApps, fixtureRepoStates, installFixtureRemotes } from './fixture-repos';
import type { FakeGithubConfig } from './github-front';
import { FAKE_GITHUB_ENTRY, NEXT_BIN, RUNNER_ENTRY, RUNNER_ROOT, STACK_CLI_DISPLAY, TSX_LOADER_URL, WEB_ROOT } from './paths';
import { isRecordedProcess, killTree, listeningPids, pidAlive, processImage, spawnDetached, tailFile, waitForHttp } from './proc';
import { createRunnerApi, type RunnerApi } from './runner-api';
import { installScripts } from './scenarios';
import { ALL_SEEDS, expandScenarios, runSeedScenarios, type SeedContext, type SeedScenario } from './seed';
import {
  accountOf,
  isRunnerComponent,
  readState,
  reposOfApp,
  runnerComponent,
  runnerKeyOf,
  runnerOf,
  runnerOfAccount,
  seededOf,
  syncProjections,
  updateState,
  withStackLock,
  writeState,
  type ComponentName,
  type RunnerComponent,
  type SeededData,
  type StackAccount,
  type StackRunner,
  type StackState,
} from './state';

export type Log = (line: string) => void;
const defaultLog: Log = (line) => console.log(line);

export interface StackSelector {
  name: string;
  webPort?: number;
  runnerPort?: number;
  hookPort?: number;
  githubPort?: number;
  db?: string;
}

export interface UpOptions extends StackSelector {
  reset?: boolean;
  /** No owner, no GitHub App: the first-run setup is left to the test (`configuration` project). */
  pristine?: boolean;
  /** Start the web app (default true). */
  web?: boolean;
  scheduler?: boolean;
  /** Accounts (= servers) of the stack (default: state.json, else 2 for `e2e`, 1 otherwise). */
  accounts?: number;
  /** Shared server (lot P1): the other accounts are invited onto « VPS-3 » instead of their own server. */
  shared?: boolean;
  /** Extra paths to compile once the web answers. */
  warm?: string[];
  /** Seed scenarios of account `a` to run once the stack is up. */
  seed?: string[];
  /** Seed scenarios of the other accounts (`{ b: ['projects'] }`). */
  seedAccounts?: Partial<Record<StackKey, string[]>>;
  log?: Log;
}

const WARM_SIGNED_IN = ['/', '/projets', '/sessions', '/integrations', '/parametres', '/api/integrations', '/api/notifications', '/api/notifications/counts'];
const WARM_ADMIN = ['/administration'];
const WARM_PUBLIC = ['/connexion', '/connexion/deux-facteurs'];

function adminUrl(): string {
  return (process.env.NUERA_PG_ADMIN_URL ?? (process.env.E2E_PG_URL ? `${process.env.E2E_PG_URL.replace(/\/+$/, '')}/postgres` : DEFAULT_PG_ADMIN_URL)).trim();
}

function resolvePorts(selector: StackSelector, state: StackState | null, accountCount: number): StackPorts {
  const explicit = selector.webPort ?? selector.runnerPort ?? selector.hookPort ?? selector.githubPort;
  if (explicit === undefined && state) return portsFor(state.ports.web, state.ports, accountCount);
  const web = selector.webPort ?? state?.ports.web ?? DEFAULT_WEB_PORTS[selector.name];
  if (!web) throw new Error(`Pile « ${selector.name} » inconnue : précisez --web-port (convention : web N, runner N+1000, hooks N+1001, GitHub N+1002, runner B N+1010, hooks B N+1011).`);
  return portsFor(
    web,
    {
      runner: selector.runnerPort ?? (selector.webPort === undefined ? state?.ports.runner : undefined),
      hook: selector.hookPort ?? (selector.webPort === undefined ? state?.ports.hook : undefined),
      github: selector.githubPort ?? (selector.webPort === undefined ? state?.ports.github : undefined),
    },
    accountCount,
  );
}

async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const webpush = (await import('web-push')).default as unknown as { generateVAPIDKeys(): { publicKey: string; privateKey: string } };
  return webpush.generateVAPIDKeys();
}

function newAccount(name: string, layout: StackLayout, key: StackKey, shared = false): StackAccount {
  const identity = accountIdentity(name, key);
  const files = accountFiles(layout, key);
  return {
    key,
    role: identity.role,
    name: identity.name,
    email: identity.email,
    password: identity.password,
    totpSecret: null,
    userId: null,
    spaceId: null,
    runner: shared ? 'a' : key,
    gitIdentity: identity.gitIdentity,
    stateFile: files.stateFile,
    storageState: files.storageState,
    created: false,
    createdVia: null,
    github: { app: key, sourceId: null, connected: false, accounts: [], repoCount: null },
    ...(key === 'a' ? {} : { seeded: {} }),
  };
}

function newRunner(layout: StackLayout, ports: StackPorts, key: StackKey, token: string): StackRunner {
  const runnerPorts = runnerPortsFor(ports, key);
  return {
    key,
    component: runnerComponent(key),
    name: runnerName(key),
    isDefault: key === 'a',
    environmentId: null,
    account: key,
    ports: runnerPorts,
    urls: runnerUrlsFor(runnerPorts),
    token,
    dbRole: null,
    databaseUrl: null,
    paths: runnerPathsFor(layout.dir, key),
    registeredVia: key === 'a' ? 'migration' : null,
  };
}

async function newState(name: string, ports: StackPorts, db: string, options: Pick<UpOptions, 'web' | 'scheduler' | 'pristine' | 'shared'>, accountCount: number): Promise<StackState> {
  const layout = layoutFor(name);
  const urls = urlsFor(ports);
  const vapid = await vapidKeys();
  const keys = stackKeys(accountCount);
  const apps = fixtureGithubApps(name, ports.web, keys);
  const allRepos = fixtureRepoStates(layout.remotes, apps);
  const runnerToken = randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  const shared = options.shared === true;
  const accounts = keys.map((key) => newAccount(name, layout, key, shared));
  const a = accounts[0]!;
  const appA = apps.find((app) => app.key === 'a')!;
  const state: StackState = {
    version: 2,
    name,
    createdAt: now,
    updatedAt: now,
    dir: layout.dir,
    ports,
    urls,
    database: { name: db, url: databaseUrl(adminUrl(), db), adminUrl: adminUrl() },
    secrets: {
      runnerToken,
      betterAuthSecret: randomBytes(32).toString('base64url'),
      appEncryptionKey: randomBytes(32).toString('base64'),
      setupToken: TEST_SETUP_TOKEN,
      vapidPublicKey: vapid.publicKey,
      vapidPrivateKey: vapid.privateKey,
    },
    owner: { name: a.name, email: a.email, password: a.password, totpSecret: null, userId: null, created: false },
    options: { web: options.web ?? true, scheduler: options.scheduler ?? false, pristine: options.pristine ?? false, shared },
    paths: layout,
    processes: {},
    github: { appId: appA.appId, slug: appA.slug, accounts: FIXTURE_ACCOUNTS.filter((account) => account.installationId > 0), connected: false },
    repos: reposOfApp({ allRepos }, 'a'),
    allRepos,
    seeded: {},
    accountCount,
    accounts,
    runners: (shared ? ['a' as StackKey] : keys).map((key) => newRunner(layout, ports, key, key === 'a' ? runnerToken : '')),
    githubApps: apps,
  };
  return state;
}

/** Adds the accounts / servers / apps a larger `accountCount` needs (an existing stack keeps its entries). */
function growState(state: StackState, accountCount: number): void {
  state.accountCount = accountCount;
  const shared = state.options.shared === true;
  for (const key of stackKeys(accountCount)) {
    if (!state.accounts.some((item) => item.key === key)) state.accounts.push(newAccount(state.name, state.paths, key, shared));
    if (!shared && !state.runners.some((item) => item.key === key)) state.runners.push(newRunner(state.paths, state.ports, key, ''));
  }
  const apps = fixtureGithubApps(state.name, state.ports.web, stackKeys(accountCount));
  for (const app of apps) {
    const existing = state.githubApps.find((item) => item.key === app.key);
    if (!existing) state.githubApps.push(app);
    else if (existing.account === null && app.account !== null) existing.account = app.account;
  }
  // Repositories of the fixture accounts (v1 stacks lacked hugo-test and the per-app installations).
  state.allRepos = fixtureRepoStates(state.paths.remotes, state.githubApps);
  state.repos = reposOfApp(state, 'a');
  state.github.accounts = FIXTURE_ACCOUNTS.filter((account) => account.installationId > 0);
  for (const runner of state.runners) {
    runner.ports = runnerPortsFor(state.ports, runner.key);
    runner.urls = runnerUrlsFor(runner.ports);
    runner.paths = runnerPathsFor(state.dir, runner.key);
  }
  syncProjections(state);
}

function envInput(state: StackState): StackEnvInput {
  return {
    name: state.name,
    ports: state.ports,
    urls: state.urls,
    databaseUrl: state.database.url,
    secrets: state.secrets,
    layout: state.paths,
    scheduler: state.options.scheduler,
    ownerEmail: state.owner.email,
  };
}

function runnerEnvInput(runner: StackRunner): RunnerEnvInput {
  return {
    key: runner.key,
    ports: runner.ports,
    token: runner.token,
    paths: runner.paths,
    environmentId: runner.isDefault ? null : runner.environmentId,
    databaseUrl: runner.databaseUrl,
  };
}

/** Typed calls to a runner of the stack (Bearer: that server's RUNNER_TOKEN). Default: runner `a`. */
export function runnerApiFor(state: Pick<StackState, 'urls' | 'secrets'> & Partial<Pick<StackState, 'runners' | 'name'>>, key: StackKey = 'a'): RunnerApi {
  if (key === 'a' || !state.runners) return createRunnerApi({ runnerUrl: state.urls.runner, token: state.secrets.runnerToken });
  const runner = runnerOf({ runners: state.runners, name: state.name ?? '?' }, key);
  if (!runner.token) throw new Error(`Le serveur « ${runner.name} » n'a pas encore de jeton : lancez \`up --accounts ${['a', 'b', 'c', 'd'].indexOf(key) + 1}\`.`);
  return createRunnerApi({ runnerUrl: runner.urls.runner, token: runner.token });
}

// ---------------------------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------------------------

async function ok(url: string, headers: Record<string, string> = {}, timeoutMs = 10_000): Promise<number | null> {
  try {
    const response = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch {
    return null;
  }
}

export async function componentHealth(state: StackState, component: ComponentName): Promise<boolean> {
  if (component === 'github') return (await ok(`${state.urls.githubWeb}/__harness/health`)) === 200;
  if (isRunnerComponent(component)) {
    const runner = state.runners.find((item) => item.component === component);
    if (!runner?.token) return false;
    return (await ok(`${runner.urls.runner}/v1/health`, { authorization: `Bearer ${runner.token}` })) === 200;
  }
  return (await ok(`${state.urls.web}/api/health`, {}, 60_000)) === 200;
}

function componentPorts(state: StackState, component: ComponentName): number[] {
  if (component === 'github') return [state.ports.github];
  if (component === 'web') return [state.ports.web];
  const runner = runnerOf(state, runnerKeyOf(component));
  return [runner.ports.runner, runner.ports.hook];
}

async function assertPortsFree(state: StackState, component: ComponentName): Promise<void> {
  const busy = await listeningPids(componentPorts(state, component));
  for (const [port, pids] of busy) {
    if (pids.size > 0) throw new Error(`Le port ${port} (${component}) est déjà utilisé par le processus ${[...pids].join(', ')} : arrêtez-le ou choisissez d'autres ports.`);
  }
}

/** Components of the stack in start order. */
function componentsOf(state: StackState): ComponentName[] {
  const runners = state.runners.filter((runner) => stackKeys(state.accountCount).includes(runner.key)).map((runner) => runner.component);
  return ['github', ...runners, 'web'];
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

function header(file: string, label: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `\n===== ${new Date().toISOString()} · démarrage ${label} =====\n`, { flag: 'a' });
}

function fakeGithubConfig(state: StackState): FakeGithubConfig {
  return {
    port: state.ports.github,
    apps: state.githubApps.map((app) => ({ key: app.key, appId: app.appId, slug: app.slug, owner: app.owner, installations: app.installations })),
    appUrl: state.urls.web,
    accounts: FIXTURE_ACCOUNTS.map((account) => ({ login: account.login, id: account.id, type: account.type })),
    repos: state.allRepos,
    stateDir: state.paths.github,
  };
}

async function startComponent(state: StackState, component: ComponentName, log: Log): Promise<void> {
  const logFile = path.join(state.paths.logs, `${component}.log`);
  await assertPortsFree(state, component);
  header(logFile, component);
  let pid: number;
  let command: string;
  let url: string;
  let headers: Record<string, string> = {};
  if (component === 'github') {
    const configFile = path.join(state.paths.github, 'config.json');
    mkdirSync(state.paths.github, { recursive: true });
    writeFileSync(configFile, JSON.stringify(fakeGithubConfig(state), null, 2));
    const args = ['--import', TSX_LOADER_URL, FAKE_GITHUB_ENTRY, '--config', configFile];
    pid = spawnDetached({ command: process.execPath, args, cwd: WEB_ROOT, env: githubEnv(), logFile });
    command = `node ${args.join(' ')}`;
    url = `${state.urls.githubWeb}/__harness/health`;
  } else if (isRunnerComponent(component)) {
    const runner = runnerOf(state, runnerKeyOf(component));
    if (!runner.token) throw new Error(`Le serveur « ${runner.name} » n'a pas de jeton : il doit d'abord être enregistré (up).`);
    for (const dir of [runner.paths.projects, runner.paths.runnerData, runner.paths.claudeConfig]) mkdirSync(dir, { recursive: true });
    const args = ['--import', TSX_LOADER_URL, RUNNER_ENTRY];
    pid = spawnDetached({ command: process.execPath, args, cwd: RUNNER_ROOT, env: runnerEnv(envInput(state), runnerEnvInput(runner)), logFile });
    command = `node ${args.join(' ')}`;
    url = `${runner.urls.runner}/v1/health`;
    headers = { authorization: `Bearer ${runner.token}` };
  } else {
    const args = [NEXT_BIN, 'dev', '--port', String(state.ports.web)];
    pid = spawnDetached({ command: process.execPath, args, cwd: WEB_ROOT, env: webEnv(envInput(state)), logFile });
    command = `node ${args.join(' ')}`;
    url = `${state.urls.web}/api/health`;
  }
  const image = await processImage(pid).catch(() => null);
  updateState(state.paths.stateFile, (current) => {
    current.processes[component] = { pid, startedAt: new Date().toISOString(), log: logFile, command, image };
  });
  log(`  ${component} lancé (pid ${pid}, journal ${path.relative(process.cwd(), logFile)})`);
  const label = component === 'github' ? 'Le faux GitHub' : component === 'web' ? 'Le web (next dev)' : `Le runner ${component === 'runner' ? '' : `${runnerOf(state, runnerKeyOf(component)).name} `}`.trim();
  const timeoutMs = component === 'github' ? 180_000 : component === 'web' ? 600_000 : 300_000;
  await waitForHttp(url, { timeoutMs, label, pid, logFile, headers, onWait: (elapsed) => log(`  … ${label} démarre encore (${Math.round(elapsed / 1000)} s)`) });
}

async function stopComponent(state: StackState, component: ComponentName, log: Log): Promise<void> {
  const record = state.processes[component];
  const ports = componentPorts(state, component);
  if (record && pidAlive(record.pid)) {
    // Windows recycles PIDs: a recorded PID is killed only when it is still the process we started.
    if (await isRecordedProcess(record.pid, record, ports)) {
      await killTree(record.pid, { graceMs: component === 'web' ? 20_000 : 1500 });
      log(`  ${component} arrêté (pid ${record.pid})`);
    } else {
      log(`  ${component} : le pid ${record.pid} n'est plus le processus de la pile (non tué)`);
    }
  }
  // Whatever still listens on the component's ports belongs to this stack (its ports are its own).
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const busy = [...(await listeningPids(ports)).values()].flatMap((pids) => [...pids]);
    if (busy.length === 0) break;
    for (const pid of busy) await killTree(pid);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  updateState(state.paths.stateFile, (current) => {
    delete current.processes[component];
  });
}

// ---------------------------------------------------------------------------------------------
// Accounts, servers and GitHub sources
// ---------------------------------------------------------------------------------------------

interface UserRow {
  id: string;
  email: string;
  twoFactorEnabled: boolean;
  role: string | null;
  spaceId: string | null;
}

async function userRow(state: StackState, email: string): Promise<UserRow | null> {
  return withStackDb(state.database.url, async (db) => {
    const rows = (await db.execute(sql`
      select u.id, u.email, u.two_factor_enabled, u.role,
        (select m.space_id from space_members m join spaces s on s.id = m.space_id
          where m.user_id = u.id and s.kind = 'personal' and s.archived_at is null order by m.created_at limit 1) as space_id
      from "user" u where lower(u.email) = lower(${email}) limit 1`)) as unknown as Array<{ id: string; email: string; two_factor_enabled: boolean; role: string | null; space_id: string | null }>;
    const row = rows[0];
    return row ? { id: row.id, email: row.email, twoFactorEnabled: row.two_factor_enabled, role: row.role, spaceId: row.space_id } : null;
  });
}

async function anyOwner(state: StackState): Promise<{ email: string } | null> {
  return withStackDb(state.database.url, async (db) => {
    const rows = (await db.execute(sql`select email from "user" where role = 'owner' limit 1`)) as unknown as Array<{ email: string }>;
    return rows[0] ?? null;
  });
}

async function serverRow(state: StackState, where: { id?: string | null; isDefault?: boolean }): Promise<{ id: string; spaceId: string | null; status: string; tokenHash: string | null; nextTokenHash: string | null; name: string } | null> {
  return withStackDb(state.database.url, async (db) => {
    const rows = (where.id
      ? await db.execute(sql`select id, space_id, status, token_hash, next_token_hash, name from environments where id = ${where.id} limit 1`)
      : await db.execute(sql`select id, space_id, status, token_hash, next_token_hash, name from environments where is_default limit 1`)) as unknown as Array<{ id: string; space_id: string | null; status: string; token_hash: string | null; next_token_hash: string | null; name: string }>;
    const row = rows[0];
    return row ? { id: row.id, spaceId: row.space_id, status: row.status, tokenHash: row.token_hash, nextTokenHash: row.next_token_hash, name: row.name } : null;
  });
}

async function ensureOwner(state: StackState, log: Log): Promise<StackState> {
  const { createOwner, topUpBackupCodes } = await import('./browser');
  const { readOwnerState } = await import('../fixtures/owner');
  const account = accountOf(state, 'a');
  let row = await userRow(state, account.email);
  const stored = readOwnerState(account.stateFile);
  if (!row) {
    const other = await anyOwner(state);
    if (other) throw new Error(`La base ${state.database.name} a déjà un propriétaire (${other.email}) dont la pile n'a pas les identifiants : relancez avec --reset.`);
    log('Propriétaire : création par la page /configuration (jeton, compte, TOTP, codes de secours)…');
    await createOwner(state);
    row = await userRow(state, account.email);
  } else if (!stored) {
    throw new Error(`La base ${state.database.name} a déjà le compte ${row.email} mais la pile n'a pas ses identifiants : relancez avec --reset.`);
  }
  if (!row?.twoFactorEnabled) throw new Error('Le propriétaire existe sans double authentification : relancez avec --reset.');
  const owner = readOwnerState(account.stateFile)!;
  const server = await serverRow(state, { isDefault: true });
  const next = updateState(state.paths.stateFile, (current) => {
    const a = accountOf(current, 'a');
    Object.assign(a, { name: owner.name, email: owner.email, password: owner.password, totpSecret: owner.totpSecret, userId: row!.id, spaceId: row!.spaceId, created: true, createdVia: a.createdVia ?? 'configuration' });
    const runner = runnerOf(current, 'a');
    runner.environmentId = server?.id ?? runner.environmentId;
    if (server?.name) runner.name = server.name;
  });
  if (row.role && row.role !== 'owner') log(`  attention : le premier compte a le rôle « ${row.role} » au lieu de « owner ».`);
  if (server && row.spaceId && server.spaceId !== row.spaceId) log(`  attention : le serveur par défaut « ${server.name} » n'est pas rattaché à l'espace du propriétaire.`);
  const codes = await topUpBackupCodes(next, 'a');
  log(`Propriétaire : ${owner.email} (codes de secours restants : ${codes}) · serveur ${server?.name ?? '?'}`);
  return next;
}

/** Registers server `key` through the administration (owner's request) and keeps its one-time token and DSN. */
async function ensureServer(state: StackState, key: StackKey, log: Log): Promise<StackState> {
  const runner = runnerOf(state, key);
  const { hashToken } = await import('@nuera/shared/tokens');
  if (runner.environmentId && runner.token) {
    const row = await serverRow(state, { id: runner.environmentId });
    // A renewed token is accepted as soon as it is recorded (next_token_hash), before its promotion.
    if (row && [row.tokenHash, row.nextTokenHash].includes(hashToken(runner.token))) return state;
    if (row) throw new Error(`Le serveur « ${runner.name} » existe mais son jeton n'est plus celui de la pile : relancez avec --reset (ou renouvelez son jeton dans l'administration).`);
  }
  const { signedInRequest } = await import('./browser');
  const { registerServer } = await import('./admin');
  const request = await signedInRequest(state, 'a');
  try {
    log(`Serveur ${runner.name} : enregistrement par l'administration (${runner.urls.runner})…`);
    const registered = await registerServer(request, state, { name: runner.name, url: runner.urls.runner, location: 'Pile de test' }, log);
    if (!registered.databaseUrl) log(`  attention : aucun DSN restreint renvoyé pour ${runner.name} : son runner utilisera le DSN complet.`);
    return updateState(state.paths.stateFile, (current) => {
      const target = runnerOf(current, key);
      Object.assign(target, { environmentId: registered.environmentId, token: registered.token, dbRole: registered.dbRole, databaseUrl: registered.databaseUrl, registeredVia: registered.via });
    });
  } finally {
    await request.dispose();
  }
}

/** Invites account `key` (owner's request) with its server pre-assigned, then accepts in a fresh browser. */
async function ensureMember(state: StackState, key: StackKey, log: Log): Promise<StackState> {
  const { readOwnerState } = await import('../fixtures/owner');
  const account = accountOf(state, key);
  const runner = runnerOf(state, account.runner);
  let row = await userRow(state, account.email);
  const stored = readOwnerState(account.stateFile);
  if (!row || !row.twoFactorEnabled || !stored) {
    if (row && stored && !row.twoFactorEnabled) throw new Error(`Le compte ${account.email} existe sans double authentification : relancez avec --reset.`);
    if (row && !stored) throw new Error(`La base ${state.database.name} a déjà le compte ${account.email} mais la pile n'a pas ses identifiants : relancez avec --reset.`);
    const { signedInRequest, acceptInvitationInBrowser } = await import('./browser');
    const { createInvitation } = await import('./admin');
    const request = await signedInRequest(state, 'a');
    let invitation: Awaited<ReturnType<typeof createInvitation>>;
    try {
      log(`Compte ${account.name} : invitation par l'administration (membre, serveur ${runner.name})…`);
      invitation = await createInvitation(request, state, { email: account.email, role: account.role === 'admin' ? 'admin' : 'member', environmentId: runner.environmentId }, log);
    } finally {
      await request.dispose();
    }
    log(`Compte ${account.name} : acceptation par la page /invitation/<jeton> (mot de passe, TOTP, codes de secours)…`);
    await acceptInvitationInBrowser(state, key, invitation.url);
    row = await userRow(state, account.email);
    if (!row?.twoFactorEnabled) throw new Error(`Le compte ${account.email} n'a pas de double authentification après l'activation.`);
  }
  const created = readOwnerState(account.stateFile)!;
  const server = runner.environmentId ? await serverRow(state, { id: runner.environmentId }) : null;
  // On a shared stack the server's first account stays the owner's: the member is one more account there.
  if (server && row.spaceId && account.runner === key && server.spaceId !== row.spaceId) throw new Error(`Le serveur « ${runner.name} » n'est pas attribué à l'espace de ${account.name} après l'invitation.`);
  const next = updateState(state.paths.stateFile, (current) => {
    const target = accountOf(current, key);
    Object.assign(target, { totpSecret: created.totpSecret, userId: row!.id, spaceId: row!.spaceId, created: true, createdVia: 'invitation' });
  });
  const { topUpBackupCodes } = await import('./browser');
  const codes = await topUpBackupCodes(next, key);
  log(`Compte ${account.name} : ${account.email} · ${row.role ?? '?'} · serveur ${server?.name ?? '?'} (${server?.status ?? '?'}) · codes de secours restants : ${codes}`);
  return next;
}

async function githubConnected(state: StackState, key: StackKey): Promise<boolean> {
  const account = state.accounts.find((item) => item.key === key);
  const app = state.githubApps.find((item) => item.key === account?.github.app);
  if (!account?.spaceId || !app) return false;
  try {
    return await withStackDb(state.database.url, async (db) => {
      const rows = (await db.execute(sql`select status from github_sources where space_id = ${account.spaceId} and app_id = ${app.appId} limit 1`)) as unknown as Array<{ status: string }>;
      return rows[0]?.status === 'connected';
    });
  } catch {
    return false;
  }
}

async function ensureGithub(state: StackState, key: StackKey, log: Log): Promise<StackState> {
  const { signedInRequest } = await import('./browser');
  const { connectGithubSource } = await import('./github-connect');
  const account = accountOf(state, key);
  const request = await signedInRequest(state, key);
  try {
    const result = await connectGithubSource(request, state, key, account.github.app, log);
    if (result.status !== 'connected') throw new Error(`GitHub n'est pas connecté pour ${account.name} après l'installation (statut ${result.status}).`);
    log(`GitHub (${account.name}) : connecté via le faux GitHub (${result.accounts.join(', ')} · ${result.repoCount ?? '?'} dépôts)`);
    return updateState(state.paths.stateFile, (current) => {
      const target = accountOf(current, key);
      target.github = { ...target.github, sourceId: result.sourceId, connected: true, accounts: result.accounts, repoCount: result.repoCount };
      const seeded = key === 'a' ? current.seeded : (target.seeded ??= {});
      seeded.github = { connectedAt: seeded.github?.connectedAt ?? new Date().toISOString(), accounts: result.accounts, repoCount: result.repoCount ?? 0 };
    });
  } finally {
    await request.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

export function loadState(name: string): StackState {
  const state = readState(layoutFor(assertStackName(name)).stateFile);
  if (!state) throw new Error(`Aucune pile « ${name} » : lancez \`${STACK_CLI_DISPLAY} up --name ${name} …\`.`);
  return state;
}

function resetFiles(layout: StackLayout): void {
  const runnerDirs = readdirSync(layout.dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^runner-[a-z]$/.test(entry.name))
    .map((entry) => path.join(layout.dir, entry.name));
  for (const dir of [layout.projects, layout.runnerData, layout.home, layout.github, layout.playwright, layout.logs, layout.tmp, layout.remotes, layout.accounts, ...runnerDirs]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  const storages = readdirSync(layout.dir).filter((entry) => /^storage-state(-[a-z])?\.json$/.test(entry)).map((entry) => path.join(layout.dir, entry));
  for (const file of [layout.ownerFile, layout.stateFile, ...storages]) rmSync(file, { force: true });
}

export async function up(options: UpOptions): Promise<StackState> {
  const name = assertStackName(options.name);
  const log = options.log ?? defaultLog;
  const layout = layoutFor(name);
  mkdirSync(layout.dir, { recursive: true });
  return withStackLock(layout.lockFile, 'up', async () => {
    const started = Date.now();
    let state = readState(layout.stateFile);
    if (!(await postgresReachable(adminUrl()))) throw new Error(`PostgreSQL ne répond pas (${adminUrl().replace(/:[^:@/]+@/, ':***@')}) : lancez \`pnpm db:local\`.`);

    const accountCount = options.accounts ?? state?.accountCount ?? defaultAccountCount(name);
    const ports = resolvePorts(options, state, accountCount);
    const db = assertDatabaseName(options.db ?? state?.database.name ?? defaultDatabaseName(name));
    if (state && (state.ports.web !== ports.web || state.ports.runner !== ports.runner || state.ports.hook !== ports.hook || state.ports.github !== ports.github)) {
      log(`Nouveaux ports pour ${name} : arrêt de la pile sur les anciens.`);
      await downProcesses(state, log);
    }
    if (options.reset && state) {
      log(`Réinitialisation de la pile ${name}…`);
      await downProcesses(state, log);
      await dropDatabase(adminUrl(), state.database.name).catch(() => undefined);
      resetFiles(layout);
      state = null;
    }
    if (!state) {
      state = await newState(name, ports, db, options, accountCount);
      writeState(layout.stateFile, state);
    } else {
      state = updateState(layout.stateFile, (current) => {
        current.ports = ports;
        current.urls = urlsFor(ports);
        current.database = { name: db, url: databaseUrl(adminUrl(), db), adminUrl: adminUrl() };
        current.paths = layout;
        // `pristine` only holds for this call: a later `up` creates the owner if the test did not.
        current.options = {
          web: options.web ?? current.options.web,
          scheduler: options.scheduler ?? current.options.scheduler,
          pristine: options.pristine ?? false,
          shared: options.shared ?? current.options.shared ?? false,
        };
        growState(current, accountCount);
      });
      // Servers beyond the requested count are stopped (their rows and folders are kept).
      for (const runner of state.runners) {
        if (!stackKeys(accountCount).includes(runner.key) && state.processes[runner.component]) await stopComponent(state, runner.component, log);
      }
      state = loadState(name);
    }
    const keys = stackKeys(accountCount);
    // A shared stack (lot P1) has one runner for every account.
    const runnerKeys = [...new Set(keys.map((key) => runnerOfAccount(state!, key).key))];
    log(`Pile ${name} · ${accountCount} compte(s)${state.options.shared ? ' sur un serveur partagé' : ''} · web ${state.urls.web} · runners ${runnerKeys.map((key) => `${runnerOf(state!, key).name} ${runnerOf(state!, key).urls.runner}`).join(', ')} · GitHub ${state.urls.githubWeb} · base ${db}`);

    // Database + migrations (idempotent; the fingerprint of the default server's token is recorded).
    if (await ensureDatabase(adminUrl(), db, { reset: false })) log(`Base créée : ${db}`);
    await migrate(state.database.url, runnerOf(state, 'a').token);

    // Files of the stack.
    for (const dir of [layout.logs, layout.github, layout.playwright, layout.shots, layout.tmp, layout.accounts]) mkdirSync(dir, { recursive: true });
    if (!existsSync(path.join(layout.remotes, '.fixtures')) || !existsSync(path.join(layout.remotes, 'hugo-test'))) {
      await installFixtureRemotes(layout.remotes, { log });
      log('Dépôts distants de test installés (atelier-test, dev-test, hugo-test).');
    }
    for (const key of runnerKeys) {
      const runner = runnerOf(state, key);
      for (const dir of [runner.paths.projects, runner.paths.runnerData, runner.paths.claudeConfig]) mkdirSync(dir, { recursive: true });
      installScripts(runner.paths.claudeScenarios);
      const marker = path.join(runner.paths.claudeConfig, 'nuera-fake-claude.json');
      if (!existsSync(marker)) writeFileSync(marker, `${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: accountOf(state, runner.account).email }, null, 2)}\n`);
    }

    // Processes (reused when they already answer): fake GitHub, default runner, web; the other
    // servers start once registered by the administration (below).
    const wanted: ComponentName[] = state.options.web ? ['github', 'runner', 'web'] : ['github', 'runner'];
    if (!state.options.web && state.processes.web) await stopComponent(state, 'web', log);
    let webStarted = false;
    for (const component of wanted) {
      state = loadState(name);
      if (await componentHealth(state, component)) {
        log(`  ${component} : déjà en route`);
        if (component === 'web') await guardReloadLoop(name, log);
        continue;
      }
      if (state.processes[component]) await stopComponent(state, component, log);
      await startComponent(loadState(name), component, log);
      if (component === 'web') {
        webStarted = true;
        await guardReloadLoop(name, log);
      }
    }
    state = loadState(name);

    if (state.options.web && !state.options.pristine) {
      state = await ensureOwner(state, log);
      if (!(await githubConnected(state, 'a'))) state = await ensureGithub(state, 'a', log);
      else log('GitHub (propriétaire) : déjà connecté');
      for (const key of keys.slice(1)) {
        // Shared stack: the account is invited onto « VPS-3 » (its own Claude folder there).
        if (accountOf(state, key).runner === key) {
          state = await ensureServer(state, key, log);
          await ensureRunnerUp(name, runnerOf(state, key).component, log);
        }
        state = await ensureMember(loadState(name), key, log);
        if (!(await githubConnected(state, key))) state = await ensureGithub(state, key, log);
        else log(`GitHub (${accountOf(state, key).name}) : déjà connecté`);
      }
    } else if (!state.options.web) {
      // Without the web, only servers registered earlier can run.
      for (const key of runnerKeys.slice(1)) if (runnerOf(state, key).token) await ensureRunnerUp(name, runnerOf(state, key).component, log);
    }
    state = loadState(name);
    if (state.options.web && (webStarted || options.warm?.length)) {
      const { warmPages } = await import('./browser');
      log('Préchauffage des pages (compilation de next dev)…');
      if (state.options.pristine) await warmPages(state, [...WARM_PUBLIC, ...(options.warm ?? [])], log, false);
      else {
        await warmPages(state, WARM_PUBLIC, log, false);
        await warmPages(state, [...WARM_SIGNED_IN, ...WARM_ADMIN, ...(options.warm ?? [])], log, 'a');
        for (const key of keys.slice(1)) await warmPages(state, ['/', '/projets', '/api/notifications/counts'], log, key);
      }
    }
    log(`Pile ${name} prête en ${Math.round((Date.now() - started) / 1000)} s.`);
    if (options.seed?.length) await seedLocked(name, options.seed, log, 'a');
    for (const key of keys.slice(1)) {
      const scenarios = options.seedAccounts?.[key];
      if (scenarios?.length) await seedLocked(name, scenarios, log, key);
    }
    state = loadState(name);
    log(summary(state));
    return state;
  });
}

async function ensureRunnerUp(name: string, component: RunnerComponent, log: Log): Promise<void> {
  const state = loadState(name);
  if (await componentHealth(state, component)) {
    log(`  ${component} : déjà en route`);
    return;
  }
  if (state.processes[component]) await stopComponent(state, component, log);
  await startComponent(loadState(name), component, log);
}

/**
 * When the pages of `next dev` reload in a loop (see browser.reloadLoopDetected), its persisted
 * Turbopack cache (`apps/web/.next-<pile>/dev/cache/turbopack`) is dropped and the web restarted
 * once (cold compile).
 */
async function guardReloadLoop(name: string, log: Log): Promise<void> {
  const { reloadLoopDetected } = await import('./browser');
  if (!(await reloadLoopDetected(loadState(name)))) return;
  log('  web : les pages se rechargent en boucle (HMR hash mismatch) : cache Turbopack supprimé, redémarrage de next dev…');
  await stopComponent(loadState(name), 'web', log);
  rmSync(path.join(WEB_ROOT, `.next-${name}`, 'dev', 'cache', 'turbopack'), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  await startComponent(loadState(name), 'web', log);
  if (await reloadLoopDetected(loadState(name))) throw new Error(`Les pages du web de la pile ${name} se rechargent en boucle : arrêtez la pile, supprimez apps/web/.next-${name} et relancez \`up\`.`);
}

async function downProcesses(state: StackState, log: Log): Promise<void> {
  const runners = state.runners.map((runner) => runner.component);
  for (const component of ['web', ...runners, 'github'] as ComponentName[]) await stopComponent(state, component, log);
}

export async function down(name: string, options: { purge?: boolean; log?: Log } = {}): Promise<void> {
  const log = options.log ?? defaultLog;
  const layout = layoutFor(assertStackName(name));
  const state = readState(layout.stateFile);
  if (!state) {
    log(`Aucune pile « ${name} ».`);
    if (options.purge) rmSync(layout.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    return;
  }
  await withStackLock(layout.lockFile, 'down', async () => {
    log(`Arrêt de la pile ${name}…`);
    await downProcesses(state, log);
    const ports = allPorts(state.ports, Math.max(state.accountCount, state.runners.length));
    const busy = [...(await listeningPids(ports)).entries()].filter(([, pids]) => pids.size > 0);
    if (busy.length) throw new Error(`Ports encore occupés : ${busy.map(([port, pids]) => `${port} (${[...pids].join(', ')})`).join(' · ')}`);
    log(`Ports libérés : ${ports.join(', ')}.`);
  });
  if (options.purge) {
    if (await databaseExists(state.database.adminUrl, state.database.name).catch(() => false)) {
      await dropDatabase(state.database.adminUrl, state.database.name);
      log(`Base supprimée : ${state.database.name} (et les rôles de ses serveurs)`);
    }
    rmSync(layout.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    rmSync(path.join(WEB_ROOT, `.next-${name}`), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    log(`Dossier supprimé : ${layout.dir} (et apps/web/.next-${name})`);
    if (dropDanglingNextEnvImports(name)) log('apps/web/next-env.d.ts : imports de types de la pile supprimée retirés (tsc).');
  }
}

/**
 * `next dev` with NEXT_DIST_DIR=.next-<pile> rewrites apps/web/next-env.d.ts (generated, git-ignored)
 * with `import "./.next-<pile>/dev/types/routes.d.ts"`. Once that folder is purged, TypeScript 6
 * fails on the dangling side-effect import (TS2882) until Next regenerates the file: those lines
 * are removed (the next `next dev` / `next build` writes them again for its own folder).
 */
function dropDanglingNextEnvImports(name: string): boolean {
  const file = path.join(WEB_ROOT, 'next-env.d.ts');
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  const prefix = `./.next-${name}/`;
  const kept = text.split('\n').filter((line) => !(line.startsWith('import ') && line.includes(`"${prefix}`)));
  const next = kept.join('\n');
  if (next === text) return false;
  writeFileSync(file, next);
  return true;
}

export interface StatusReport {
  name: string;
  exists: boolean;
  urls?: StackState['urls'];
  components: Array<{ component: ComponentName | 'database'; healthy: boolean; pid: number | null; detail: string }>;
  owner?: { email: string; created: boolean };
  accounts?: Array<{ key: StackKey; name: string; email: string; role: string; created: boolean; server: string; github: boolean }>;
  github?: { connected: boolean };
  seeded?: StackState['seeded'];
}

export async function status(name: string): Promise<StatusReport> {
  const state = readState(layoutFor(assertStackName(name)).stateFile);
  if (!state) return { name, exists: false, components: [] };
  const components: StatusReport['components'] = [];
  for (const component of componentsOf(state)) {
    const healthy = await componentHealth(state, component);
    const record = state.processes[component];
    components.push({
      component,
      healthy,
      pid: record?.pid ?? null,
      detail: healthy ? 'répond' : record && pidAlive(record.pid) ? 'processus vivant, ne répond pas' : component === 'web' && !state.options.web ? 'désactivé (--no-web)' : 'arrêté',
    });
  }
  const dbOk = await databaseExists(state.database.adminUrl, state.database.name).catch(() => false);
  components.push({ component: 'database', healthy: dbOk, pid: null, detail: dbOk ? state.database.name : `${state.database.name} absente` });
  return {
    name,
    exists: true,
    urls: state.urls,
    components,
    owner: { email: state.owner.email, created: state.owner.created },
    accounts: state.accounts.map((account) => ({ key: account.key, name: account.name, email: account.email, role: account.role, created: account.created, server: runnerOfAccount(state, account.key).name, github: account.github.connected })),
    github: { connected: state.github.connected },
    seeded: state.seeded,
  };
}

export async function restart(name: string, component: ComponentName, log: Log = defaultLog): Promise<void> {
  const state = loadState(name);
  await stopComponent(state, component, log);
  await startComponent(loadState(name), component, log);
  if (component === 'web') await guardReloadLoop(name, log);
}

/** Stops one component (e.g. `runner-b` for « VPS-4 ne répond pas »); `up` or `restart` starts it again. */
export async function stop(name: string, component: ComponentName, log: Log = defaultLog): Promise<void> {
  await stopComponent(loadState(name), component, log);
}

function seedContext(name: string, log: Log, key: StackKey): SeedContext {
  const file = layoutFor(name).stateFile;
  const runnerKey = runnerOfAccount(loadState(name), key).key;
  return {
    account: key,
    state: () => loadState(name),
    update: (patch) => updateState(file, patch),
    api: runnerApiFor(loadState(name), runnerKey),
    log,
    restartRunner: () => restart(name, runnerComponent(runnerKey), log),
    connectGithub: async () => {
      const state = loadState(name);
      if (!state.options.web) throw new Error('GitHub : la pile tourne sans web (--no-web).');
      const owned = state.owner.created ? state : await ensureOwner(state, log);
      if (await githubConnected(owned, key)) {
        log('GitHub : déjà connecté');
        return;
      }
      await ensureGithub(owned, key, log);
    },
    request: async () => {
      const { signedInRequest } = await import('./browser');
      return signedInRequest(loadState(name), key);
    },
  };
}

async function seedLocked(name: string, scenarios: string[], log: Log, key: StackKey): Promise<void> {
  const list = expandScenarios(scenarios.length ? scenarios : ALL_SEEDS);
  const state = loadState(name);
  const account = accountOf(state, key);
  if (!account.created) throw new Error(`Le compte ${account.name} n'existe pas encore sur la pile ${name} : lancez \`up --accounts ${state.accountCount}\`.`);
  const runner = runnerOfAccount(state, key);
  if (!(await componentHealth(state, runner.component))) throw new Error(`Le runner ${runner.name} de la pile ${name} ne répond pas : lancez \`up\`.`);
  log(`Données de test (${account.name}, ${runner.name}) : ${list.join(', ')}`);
  await runSeedScenarios(seedContext(name, log, key), list);
}

/** Runs seed scenarios (`all`, `projects`, `sessions`…) of an account on a running stack. */
export async function seed(name: string, scenarios: string[], options: { log?: Log; account?: StackKey } = {}): Promise<SeededData> {
  const log = options.log ?? defaultLog;
  const key = options.account ?? 'a';
  await withStackLock(layoutFor(assertStackName(name)).lockFile, 'seed', () => seedLocked(name, scenarios, log, key), { log });
  return seededOf(loadState(name), key);
}

export async function login(name: string, options: { out?: string; log?: Log; account?: StackKey } = {}): Promise<string> {
  const log = options.log ?? defaultLog;
  const state = loadState(name);
  const key = options.account ?? 'a';
  if (!(await componentHealth(state, 'web'))) throw new Error(`Le web de la pile ${name} ne répond pas : lancez \`up\`.`);
  const { signInToFile } = await import('./browser');
  const file = await signInToFile(state, key, options.out);
  log(`Session enregistrée (${accountOf(state, key).name}) : ${file}`);
  log('Capture d\'écran prête à lancer :');
  log(`  ${STACK_CLI_DISPLAY} shot --name ${name}${key === 'a' ? '' : ` --as ${key}`} / --out .data/stacks/${name}/shots/accueil-bureau.png`);
  log(`  ${STACK_CLI_DISPLAY} shot --name ${name}${key === 'a' ? '' : ` --as ${key}`} / --mobile --out .data/stacks/${name}/shots/accueil-mobile.png`);
  log('Ou avec la CLI Playwright :');
  log(`  pnpm --filter @nuera/web exec playwright screenshot --load-storage="${file}" --viewport-size=1440,1000 --wait-for-timeout=4000 ${state.urls.web}/ accueil.png`);
  return file;
}

export async function shot(name: string, options: { path: string; out?: string; mobile?: boolean; full?: boolean; waitMs?: number; selector?: string; dark?: boolean; account?: StackKey; log?: Log }): Promise<string> {
  const log = options.log ?? defaultLog;
  const state = loadState(name);
  const { screenshot } = await import('./browser');
  const slug = options.path.replace(/^\/+/, '').replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'accueil';
  const suffix = options.account && options.account !== 'a' ? `-${options.account}` : '';
  const out = path.resolve(options.out ?? path.join(state.paths.shots, `${slug}-${options.mobile ? 'mobile' : 'bureau'}${suffix}.png`));
  await screenshot(state, { ...options, out });
  log(`Capture : ${out}`);
  return out;
}

export function logs(name: string, component: ComponentName, lines = 80): string {
  const state = loadState(name);
  return tailFile(path.join(state.paths.logs, `${component}.log`), lines);
}

/** Fake CLI login state (T6) of one server: `claude auth status` follows it, its runner's cache is refreshed. */
export async function setClaudeLoggedIn(name: string, loggedIn: boolean, log: Log = defaultLog, runnerKey: StackKey = 'a'): Promise<string> {
  const state = loadState(name);
  const runner = runnerOf(state, runnerKey);
  const marker = path.join(runner.paths.claudeConfig, 'nuera-fake-claude.json');
  const current = existsSync(marker) ? (JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>) : {};
  writeFileSync(marker, `${JSON.stringify({ ...current, loggedIn, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  const claude = await runnerApiFor(state, runnerKey)('claudeStatus', { query: { refresh: true } });
  log(`CLI Claude (faux, ${runner.name}) : ${claude.state}`);
  return claude.state;
}

/** Controls of the fake GitHub (revoked key, suspended installation, PR checks…; `app` = which app, default `a`). */
export async function controlGithub(name: string, input: Record<string, unknown>): Promise<unknown> {
  const state = loadState(name);
  const response = await fetch(`${state.urls.githubWeb}/__harness/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error(`Faux GitHub : HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

export function summary(state: StackState): string {
  const describeSeeded = (seeded: SeededData) =>
    [
      seeded.projects ? `projets ${Object.keys(seeded.projects).join(', ')}` : null,
      seeded.sessions ? `sessions ${Object.keys(seeded.sessions).join(', ')}` : null,
      seeded.changes ? 'changements' : null,
      seeded.runs ? 'exécutions' : null,
      seeded.notifications ? 'notifications' : null,
    ]
      .filter(Boolean)
      .join(' · ') || 'aucune (seed all)';
  const lines = [
    '',
    `Pile « ${state.name} » · ${state.accountCount} compte(s)`,
    `  Web         ${state.urls.web}    (toujours localhost, jamais 127.0.0.1)`,
    `  Faux GitHub ${state.urls.githubWeb}  (API ${state.urls.githubApi})`,
    `  Base        ${state.database.name}`,
    `  Journaux    ${state.paths.logs}`,
  ];
  for (const runner of state.runners.filter((item) => stackKeys(state.accountCount).includes(item.key))) {
    lines.push(`  Serveur ${runner.key}   ${runner.name} · runner ${runner.urls.runner} · hooks ${runner.urls.hook}${runner.isDefault ? ' (par défaut, RUNNER_TOKEN : secrets.runnerToken)' : runner.dbRole ? ` (rôle ${runner.dbRole})` : ''}`);
  }
  if (state.options.pristine) lines.push('  Propriétaire : aucun (--pristine) — la page /configuration attend le jeton de test.');
  for (const account of state.accounts.filter((item) => stackKeys(state.accountCount).includes(item.key))) {
    lines.push(
      `  Compte ${account.key}    ${account.created ? `${account.email} / ${account.password} · TOTP ${account.totpSecret ?? '?'} (${path.basename(account.stateFile)})` : 'non créé'} · ${runnerOfAccount(state, account.key).name}`,
      `              données : ${describeSeeded(account.key === 'a' ? state.seeded : (account.seeded ?? {}))}`,
    );
  }
  lines.push(`  Session navigateur : ${STACK_CLI_DISPLAY} login --name ${state.name} [--as b]`, '');
  return lines.join('\n');
}

export type { SeedScenario };
