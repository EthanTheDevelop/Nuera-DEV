/**
 * TEST-ONLY — lifecycle of a local test stack (`.data/stacks/<name>/`): database, fake GitHub,
 * runner (from source, PTY backend, fake Claude CLI), web (`next dev`), owner, GitHub App, seeds.
 * Driven by `stack.mjs` (CLI) and by the Playwright global setup / fixtures.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import {
  DEFAULT_PG_ADMIN_URL,
  DEFAULT_WEB_PORTS,
  TEST_SETUP_TOKEN,
  assertDatabaseName,
  assertStackName,
  databaseUrl,
  defaultDatabaseName,
  githubEnv,
  layoutFor,
  ownerIdentity,
  portsFor,
  runnerEnv,
  urlsFor,
  webEnv,
  type StackEnvInput,
  type StackPorts,
} from './config';
import { databaseExists, dropDatabase, ensureDatabase, migrate, postgresReachable, withStackDb } from './db';
import { FIXTURE_ACCOUNTS, fixtureRepoStates, installFixtureRemotes } from './fixture-repos';
import { FAKE_GITHUB_ENTRY, NEXT_BIN, RUNNER_ENTRY, RUNNER_ROOT, STACK_CLI_DISPLAY, TSX_LOADER_URL, WEB_ROOT } from './paths';
import { killTree, listeningPids, pidAlive, spawnDetached, tailFile, waitForHttp } from './proc';
import { createRunnerApi, type RunnerApi } from './runner-api';
import { installScripts } from './scenarios';
import { ALL_SEEDS, expandScenarios, runSeedScenarios, type SeedContext, type SeedScenario } from './seed';
import { readState, updateState, withStackLock, writeState, type ComponentName, type StackState } from './state';

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
  /** Extra paths to compile once the web answers. */
  warm?: string[];
  /** Seed scenarios to run once the stack is up. */
  seed?: string[];
  log?: Log;
}

const WARM_SIGNED_IN = ['/', '/projets', '/sessions', '/integrations', '/parametres', '/api/integrations', '/api/notifications', '/api/notifications/counts'];
const WARM_PUBLIC = ['/connexion', '/connexion/deux-facteurs'];

function adminUrl(): string {
  return (process.env.NUERA_PG_ADMIN_URL ?? (process.env.E2E_PG_URL ? `${process.env.E2E_PG_URL.replace(/\/+$/, '')}/postgres` : DEFAULT_PG_ADMIN_URL)).trim();
}

function resolvePorts(selector: StackSelector, state: StackState | null): StackPorts {
  const explicit = selector.webPort ?? selector.runnerPort ?? selector.hookPort ?? selector.githubPort;
  if (explicit === undefined && state) return state.ports;
  const web = selector.webPort ?? state?.ports.web ?? DEFAULT_WEB_PORTS[selector.name];
  if (!web) throw new Error(`Pile « ${selector.name} » inconnue : précisez --web-port (convention : web N, runner N+1000, hook N+1001, GitHub N+1002).`);
  return portsFor(web, {
    runner: selector.runnerPort ?? (selector.webPort === undefined ? state?.ports.runner : undefined),
    hook: selector.hookPort ?? (selector.webPort === undefined ? state?.ports.hook : undefined),
    github: selector.githubPort ?? (selector.webPort === undefined ? state?.ports.github : undefined),
  });
}

async function vapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const webpush = (await import('web-push')).default as unknown as { generateVAPIDKeys(): { publicKey: string; privateKey: string } };
  return webpush.generateVAPIDKeys();
}

async function newState(name: string, ports: StackPorts, db: string, options: Pick<UpOptions, 'web' | 'scheduler' | 'pristine'>): Promise<StackState> {
  const layout = layoutFor(name);
  const urls = urlsFor(ports);
  const vapid = await vapidKeys();
  const owner = ownerIdentity(name);
  const now = new Date().toISOString();
  return {
    version: 1,
    name,
    createdAt: now,
    updatedAt: now,
    dir: layout.dir,
    ports,
    urls,
    database: { name: db, url: databaseUrl(adminUrl(), db), adminUrl: adminUrl() },
    secrets: {
      runnerToken: randomBytes(32).toString('hex'),
      betterAuthSecret: randomBytes(32).toString('base64url'),
      appEncryptionKey: randomBytes(32).toString('base64'),
      setupToken: TEST_SETUP_TOKEN,
      vapidPublicKey: vapid.publicKey,
      vapidPrivateKey: vapid.privateKey,
    },
    owner: { ...owner, totpSecret: null, userId: null, created: false },
    options: { web: options.web ?? true, scheduler: options.scheduler ?? false, pristine: options.pristine ?? false },
    paths: layout,
    processes: {},
    github: { appId: 900_000 + ports.web, slug: `nuera-dev-${name}`, accounts: [...FIXTURE_ACCOUNTS], connected: false },
    repos: fixtureRepoStates(layout.remotes),
    seeded: {},
  };
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

export function runnerApiFor(state: Pick<StackState, 'urls' | 'secrets'>): RunnerApi {
  return createRunnerApi({ runnerUrl: state.urls.runner, token: state.secrets.runnerToken });
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
  if (component === 'runner') return (await ok(`${state.urls.runner}/v1/health`, { authorization: `Bearer ${state.secrets.runnerToken}` })) === 200;
  return (await ok(`${state.urls.web}/api/health`, {}, 60_000)) === 200;
}

const COMPONENT_PORTS: Record<ComponentName, Array<keyof StackPorts>> = { github: ['github'], runner: ['runner', 'hook'], web: ['web'] };

async function assertPortsFree(state: StackState, component: ComponentName): Promise<void> {
  const ports = COMPONENT_PORTS[component].map((key) => state.ports[key]);
  const busy = await listeningPids(ports);
  for (const [port, pids] of busy) {
    if (pids.size > 0) throw new Error(`Le port ${port} (${component}) est déjà utilisé par le processus ${[...pids].join(', ')} : arrêtez-le ou choisissez d'autres ports.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------------------------

function header(file: string, label: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `\n===== ${new Date().toISOString()} · démarrage ${label} =====\n`, { flag: 'a' });
}

async function startComponent(state: StackState, component: ComponentName, log: Log): Promise<void> {
  const logFile = path.join(state.paths.logs, `${component}.log`);
  await assertPortsFree(state, component);
  header(logFile, component);
  let pid: number;
  let command: string;
  if (component === 'github') {
    const configFile = path.join(state.paths.github, 'config.json');
    mkdirSync(state.paths.github, { recursive: true });
    writeFileSync(
      configFile,
      JSON.stringify(
        {
          port: state.ports.github,
          appId: state.github.appId,
          slug: state.github.slug,
          appOwner: { login: state.github.accounts[0]!.login, id: state.github.accounts[0]!.id, type: state.github.accounts[0]!.type },
          appUrl: state.urls.web,
          accounts: state.github.accounts,
          repos: state.repos,
          stateDir: state.paths.github,
        },
        null,
        2,
      ),
    );
    const args = ['--import', TSX_LOADER_URL, FAKE_GITHUB_ENTRY, '--config', configFile];
    pid = spawnDetached({ command: process.execPath, args, cwd: WEB_ROOT, env: githubEnv(), logFile });
    command = `node ${args.join(' ')}`;
  } else if (component === 'runner') {
    const args = ['--import', TSX_LOADER_URL, RUNNER_ENTRY];
    pid = spawnDetached({ command: process.execPath, args, cwd: RUNNER_ROOT, env: runnerEnv(envInput(state)), logFile });
    command = `node ${args.join(' ')}`;
  } else {
    const args = [NEXT_BIN, 'dev', '--port', String(state.ports.web)];
    pid = spawnDetached({ command: process.execPath, args, cwd: WEB_ROOT, env: webEnv(envInput(state)), logFile });
    command = `node ${args.join(' ')}`;
  }
  updateState(state.paths.stateFile, (current) => {
    current.processes[component] = { pid, startedAt: new Date().toISOString(), log: logFile, command };
  });
  log(`  ${component} lancé (pid ${pid}, journal ${path.relative(process.cwd(), logFile)})`);
  const label = { github: 'Le faux GitHub', runner: 'Le runner', web: 'Le web (next dev)' }[component];
  const timeoutMs = { github: 180_000, runner: 300_000, web: 600_000 }[component];
  const url = component === 'github' ? `${state.urls.githubWeb}/__harness/health` : component === 'runner' ? `${state.urls.runner}/v1/health` : `${state.urls.web}/api/health`;
  await waitForHttp(url, {
    timeoutMs,
    label,
    pid,
    logFile,
    headers: component === 'runner' ? { authorization: `Bearer ${state.secrets.runnerToken}` } : {},
    onWait: (elapsed) => log(`  … ${label} démarre encore (${Math.round(elapsed / 1000)} s)`),
  });
}

async function stopComponent(state: StackState, component: ComponentName, log: Log): Promise<void> {
  const record = state.processes[component];
  if (record && pidAlive(record.pid)) {
    await killTree(record.pid);
    log(`  ${component} arrêté (pid ${record.pid})`);
  }
  // Whatever still listens on the component's ports belongs to this stack (its ports are its own).
  const ports = COMPONENT_PORTS[component].map((key) => state.ports[key]);
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
// Owner and GitHub
// ---------------------------------------------------------------------------------------------

async function ownerRow(state: StackState): Promise<{ id: string; email: string; twoFactorEnabled: boolean } | null> {
  return withStackDb(state.database.url, async (db) => {
    const rows = (await db.execute(sql`select id, email, two_factor_enabled from "user" limit 1`)) as unknown as Array<{ id: string; email: string; two_factor_enabled: boolean }>;
    const row = rows[0];
    return row ? { id: row.id, email: row.email, twoFactorEnabled: row.two_factor_enabled } : null;
  });
}

async function ensureOwner(state: StackState, log: Log): Promise<StackState> {
  const { createOwner, topUpBackupCodes } = await import('./browser');
  const { readOwnerState } = await import('../fixtures/owner');
  let row = await ownerRow(state);
  const stored = readOwnerState(state.paths.ownerFile);
  if (!row) {
    log('Propriétaire : création par la page /configuration (jeton, compte, TOTP, codes de secours)…');
    await createOwner(state);
    row = await ownerRow(state);
  } else if (!stored || stored.email !== row.email) {
    throw new Error(`La base ${state.database.name} a déjà un propriétaire (${row.email}) dont la pile n'a pas les identifiants : relancez avec --reset.`);
  }
  if (!row?.twoFactorEnabled) throw new Error('Le propriétaire existe sans double authentification : relancez avec --reset.');
  const owner = readOwnerState(state.paths.ownerFile)!;
  const next = updateState(state.paths.stateFile, (current) => {
    current.owner = { name: owner.name, email: owner.email, password: owner.password, totpSecret: owner.totpSecret, userId: row!.id, created: true };
  });
  const codes = await topUpBackupCodes(next);
  log(`Propriétaire : ${owner.email} (codes de secours restants : ${codes})`);
  return next;
}

async function ensureGithub(state: StackState, log: Log): Promise<StackState> {
  const { signedInRequest } = await import('./browser');
  const { connectGithubApp } = await import('./github-connect');
  const request = await signedInRequest(state);
  try {
    const result = await connectGithubApp(request, state, log);
    if (result.status !== 'connected') throw new Error(`GitHub n'est pas connecté après l'installation (statut ${result.status}).`);
    log(`GitHub : connecté via le faux GitHub (${result.accounts.join(', ')} · ${result.repoCount ?? '?'} dépôts)`);
    return updateState(state.paths.stateFile, (current) => {
      current.github.connected = true;
      current.seeded.github = { connectedAt: current.seeded.github?.connectedAt ?? new Date().toISOString(), accounts: result.accounts, repoCount: result.repoCount ?? 0 };
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

export async function up(options: UpOptions): Promise<StackState> {
  const name = assertStackName(options.name);
  const log = options.log ?? defaultLog;
  const layout = layoutFor(name);
  mkdirSync(layout.dir, { recursive: true });
  return withStackLock(layout.lockFile, 'up', async () => {
    const started = Date.now();
    let state = readState(layout.stateFile);
    if (!(await postgresReachable(adminUrl()))) throw new Error(`PostgreSQL ne répond pas (${adminUrl().replace(/:[^:@/]+@/, ':***@')}) : lancez \`pnpm db:local\`.`);

    const ports = resolvePorts(options, state);
    const db = assertDatabaseName(options.db ?? state?.database.name ?? defaultDatabaseName(name));
    if (state && (state.ports.web !== ports.web || state.ports.runner !== ports.runner || state.ports.hook !== ports.hook || state.ports.github !== ports.github)) {
      log(`Nouveaux ports pour ${name} : arrêt de la pile sur les anciens.`);
      await downProcesses(state, log);
    }
    if (options.reset && state) {
      log(`Réinitialisation de la pile ${name}…`);
      await downProcesses(state, log);
      await dropDatabase(adminUrl(), state.database.name).catch(() => undefined);
      for (const dir of [layout.projects, layout.runnerData, layout.home, layout.github, layout.playwright, layout.logs, layout.tmp, layout.remotes]) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      for (const file of [layout.ownerFile, layout.storageState, layout.stateFile]) rmSync(file, { force: true });
      state = null;
    }
    if (!state) {
      state = await newState(name, ports, db, options);
      writeState(layout.stateFile, state);
    } else {
      state = updateState(layout.stateFile, (current) => {
        current.ports = ports;
        current.urls = urlsFor(ports);
        current.database = { name: db, url: databaseUrl(adminUrl(), db), adminUrl: adminUrl() };
        current.paths = layout;
        // `pristine` only holds for this call: a later `up` creates the owner if the test did not.
        current.options = { web: options.web ?? current.options.web, scheduler: options.scheduler ?? current.options.scheduler, pristine: options.pristine ?? false };
      });
    }
    log(`Pile ${name} · web ${state.urls.web} · runner ${state.urls.runner} · GitHub ${state.urls.githubWeb} · base ${db}`);

    // Database + migrations (idempotent).
    if (await ensureDatabase(adminUrl(), db, { reset: false })) log(`Base créée : ${db}`);
    await migrate(state.database.url);

    // Files of the stack.
    for (const dir of [layout.logs, layout.projects, layout.runnerData, layout.claudeConfig, layout.github, layout.playwright, layout.shots, layout.tmp]) mkdirSync(dir, { recursive: true });
    if (!existsSync(path.join(layout.remotes, '.fixtures'))) {
      await installFixtureRemotes(layout.remotes, { log });
      log('Dépôts distants de test installés (atelier-test, dev-test).');
    }
    installScripts(layout.claudeScenarios);
    const marker = path.join(layout.claudeConfig, 'nuera-fake-claude.json');
    if (!existsSync(marker)) writeFileSync(marker, `${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max', email: state.owner.email }, null, 2)}\n`);

    // Processes (reused when they already answer).
    const wanted: ComponentName[] = state.options.web ? ['github', 'runner', 'web'] : ['github', 'runner'];
    if (!state.options.web && state.processes.web) await stopComponent(state, 'web', log);
    let webStarted = false;
    for (const component of wanted) {
      state = loadState(name);
      if (await componentHealth(state, component)) {
        log(`  ${component} : déjà en route`);
        continue;
      }
      if (state.processes[component]) await stopComponent(state, component, log);
      await startComponent(loadState(name), component, log);
      if (component === 'web') webStarted = true;
    }
    state = loadState(name);

    if (state.options.web && !state.options.pristine) {
      state = await ensureOwner(state, log);
      if (!(await githubConnected(state))) state = await ensureGithub(state, log);
      else log('GitHub : déjà connecté');
    }
    if (state.options.web && (webStarted || options.warm?.length)) {
      const { warmPages } = await import('./browser');
      log('Préchauffage des pages (compilation de next dev)…');
      await warmPages(state, WARM_PUBLIC, log, false);
      if (!state.options.pristine) await warmPages(state, [...WARM_SIGNED_IN, ...(options.warm ?? [])], log, true);
    }
    log(`Pile ${name} prête en ${Math.round((Date.now() - started) / 1000)} s.`);
    if (options.seed?.length) await seedLocked(name, options.seed, log);
    state = loadState(name);
    log(summary(state));
    return state;
  });
}

async function githubConnected(state: StackState): Promise<boolean> {
  try {
    return await withStackDb(state.database.url, async (db) => {
      const rows = (await db.execute(sql`select status from integrations where kind = 'github' limit 1`)) as unknown as Array<{ status: string }>;
      return rows[0]?.status === 'connected';
    });
  } catch {
    return false;
  }
}

async function downProcesses(state: StackState, log: Log): Promise<void> {
  for (const component of ['web', 'runner', 'github'] as const) await stopComponent(state, component, log);
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
    const busy = [...(await listeningPids([state.ports.web, state.ports.runner, state.ports.hook, state.ports.github])).entries()].filter(([, pids]) => pids.size > 0);
    if (busy.length) throw new Error(`Ports encore occupés : ${busy.map(([port, pids]) => `${port} (${[...pids].join(', ')})`).join(' · ')}`);
    log(`Ports libérés : ${state.ports.web}, ${state.ports.runner}, ${state.ports.hook}, ${state.ports.github}.`);
  });
  if (options.purge) {
    if (await databaseExists(state.database.adminUrl, state.database.name).catch(() => false)) {
      await dropDatabase(state.database.adminUrl, state.database.name);
      log(`Base supprimée : ${state.database.name}`);
    }
    rmSync(layout.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    rmSync(path.join(WEB_ROOT, `.next-${name}`), { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    log(`Dossier supprimé : ${layout.dir} (et apps/web/.next-${name})`);
  }
}

export interface StatusReport {
  name: string;
  exists: boolean;
  urls?: StackState['urls'];
  components: Array<{ component: ComponentName | 'database'; healthy: boolean; pid: number | null; detail: string }>;
  owner?: { email: string; created: boolean };
  github?: { connected: boolean };
  seeded?: StackState['seeded'];
}

export async function status(name: string): Promise<StatusReport> {
  const state = readState(layoutFor(assertStackName(name)).stateFile);
  if (!state) return { name, exists: false, components: [] };
  const components: StatusReport['components'] = [];
  for (const component of ['github', 'runner', 'web'] as const) {
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
  return { name, exists: true, urls: state.urls, components, owner: { email: state.owner.email, created: state.owner.created }, github: { connected: state.github.connected }, seeded: state.seeded };
}

export async function restart(name: string, component: ComponentName, log: Log = defaultLog): Promise<void> {
  const state = loadState(name);
  await stopComponent(state, component, log);
  await startComponent(loadState(name), component, log);
}

function seedContext(name: string, log: Log): SeedContext {
  const file = layoutFor(name).stateFile;
  return {
    state: () => loadState(name),
    update: (patch) => updateState(file, patch),
    api: runnerApiFor(loadState(name)),
    log,
    restartRunner: () => restart(name, 'runner', log),
    connectGithub: async () => {
      const state = loadState(name);
      if (!state.options.web) throw new Error('GitHub : la pile tourne sans web (--no-web).');
      const owned = state.owner.created ? state : await ensureOwner(state, log);
      if (await githubConnected(owned)) {
        log('GitHub : déjà connecté');
        return;
      }
      await ensureGithub(owned, log);
    },
  };
}

async function seedLocked(name: string, scenarios: string[], log: Log): Promise<void> {
  const list = expandScenarios(scenarios.length ? scenarios : ALL_SEEDS);
  const state = loadState(name);
  if (!(await componentHealth(state, 'runner'))) throw new Error(`Le runner de la pile ${name} ne répond pas : lancez \`up\`.`);
  log(`Données de test : ${list.join(', ')}`);
  await runSeedScenarios(seedContext(name, log), list);
}

/** Runs seed scenarios (`all`, `projects`, `sessions`…) on a running stack. */
export async function seed(name: string, scenarios: string[], options: { log?: Log } = {}): Promise<StackState['seeded']> {
  const log = options.log ?? defaultLog;
  await withStackLock(layoutFor(assertStackName(name)).lockFile, 'seed', () => seedLocked(name, scenarios, log), { log });
  return loadState(name).seeded;
}

export async function login(name: string, options: { out?: string; log?: Log } = {}): Promise<string> {
  const log = options.log ?? defaultLog;
  const state = loadState(name);
  if (!(await componentHealth(state, 'web'))) throw new Error(`Le web de la pile ${name} ne répond pas : lancez \`up\`.`);
  const { signInToFile } = await import('./browser');
  const file = await signInToFile(state, options.out ?? state.paths.storageState);
  log(`Session enregistrée : ${file}`);
  log('Capture d\'écran prête à lancer :');
  log(`  ${STACK_CLI_DISPLAY} shot --name ${name} / --out .data/stacks/${name}/shots/accueil-bureau.png`);
  log(`  ${STACK_CLI_DISPLAY} shot --name ${name} / --mobile --out .data/stacks/${name}/shots/accueil-mobile.png`);
  log('Ou avec la CLI Playwright :');
  log(`  pnpm --filter @nuera/web exec playwright screenshot --load-storage="${file}" --viewport-size=1440,1000 --wait-for-timeout=4000 ${state.urls.web}/ accueil.png`);
  return file;
}

export async function shot(name: string, options: { path: string; out?: string; mobile?: boolean; full?: boolean; waitMs?: number; selector?: string; dark?: boolean; log?: Log }): Promise<string> {
  const log = options.log ?? defaultLog;
  const state = loadState(name);
  const { screenshot } = await import('./browser');
  const slug = options.path.replace(/^\/+/, '').replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'accueil';
  const out = path.resolve(options.out ?? path.join(state.paths.shots, `${slug}-${options.mobile ? 'mobile' : 'bureau'}.png`));
  await screenshot(state, { ...options, out });
  log(`Capture : ${out}`);
  return out;
}

export function logs(name: string, component: ComponentName, lines = 80): string {
  const state = loadState(name);
  return tailFile(path.join(state.paths.logs, `${component}.log`), lines);
}

/** Fake CLI login state (T6): `claude auth status` follows it, the runner's cache is refreshed. */
export async function setClaudeLoggedIn(name: string, loggedIn: boolean, log: Log = defaultLog): Promise<string> {
  const state = loadState(name);
  const marker = path.join(state.paths.claudeConfig, 'nuera-fake-claude.json');
  const current = existsSync(marker) ? (JSON.parse(readFileSync(marker, 'utf8')) as Record<string, unknown>) : {};
  writeFileSync(marker, `${JSON.stringify({ ...current, loggedIn, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  const claude = await runnerApiFor(state)('claudeStatus', { query: { refresh: true } });
  log(`CLI Claude (faux) : ${claude.state}`);
  return claude.state;
}

/** Controls of the fake GitHub (revoked key, suspended installation, PR checks…). */
export async function controlGithub(name: string, input: Record<string, unknown>): Promise<unknown> {
  const state = loadState(name);
  const response = await fetch(`${state.urls.githubWeb}/__harness/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error(`Faux GitHub : HTTP ${response.status} ${await response.text()}`);
  return response.json();
}

export function summary(state: StackState): string {
  const seeded = state.seeded;
  const lines = [
    '',
    `Pile « ${state.name} »`,
    `  Web         ${state.urls.web}    (toujours localhost, jamais 127.0.0.1)`,
    `  Runner      ${state.urls.runner}  (Bearer RUNNER_TOKEN : state.json → secrets.runnerToken)`,
    `  Hooks       ${state.urls.hook}`,
    `  Faux GitHub ${state.urls.githubWeb}  (API ${state.urls.githubApi})`,
    `  Base        ${state.database.name}`,
    `  Journaux    ${state.paths.logs}`,
    state.options.pristine
      ? '  Propriétaire : aucun (--pristine) — la page /configuration attend le jeton de test.'
      : `  Connexion   ${state.owner.email} / ${state.owner.password} · TOTP ${state.owner.totpSecret ?? '?'} (owner.json)`,
    `  Données     ${[seeded.projects ? `projets ${Object.keys(seeded.projects).join(', ')}` : null, seeded.sessions ? `sessions ${Object.keys(seeded.sessions).join(', ')}` : null, seeded.changes ? 'changements' : null, seeded.runs ? 'exécutions' : null, seeded.notifications ? 'notifications' : null].filter(Boolean).join(' · ') || 'aucune (seed all)'}`,
    `  Session navigateur : ${STACK_CLI_DISPLAY} login --name ${state.name}`,
    '',
  ];
  return lines.join('\n');
}

export type { SeedScenario };
