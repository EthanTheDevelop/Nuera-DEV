/**
 * TEST-ONLY — seed scenarios of a stack, per account, through the REAL code paths (web routes signed
 * in as the account, runner API of the account's server, web internal routes with that server's
 * token). Each scenario is idempotent: it checks what exists and only (re)creates what is missing or
 * has drifted (a waiting permission answered, a long task finished…).
 *
 *   github         GitHub source of the account's space connected through the real web routes
 *   projects       account a: devis-express, catalogue-produits (one red test), outils-cli;
 *                  account b: devis-express (the SAME repository, on its own server) and carnet-chantier.
 *                  POST /api/projects (the web writes the row in the account's space, on its server,
 *                  bound to its GitHub source, and starts the clone) + wait for the runner's operation
 *   sessions       account a, on devis-express: `finished` (plan, Edit allowed in Nuera, real tests,
 *                  /exit), `interrupted` (read-only turn, then a restart of runner a → « Interrompue ·
 *                  reprise possible »), `waitingPermission` (`npm run test` waits for a decision, up to
 *                  1 h), `running` (plan + watch mode for 6 h, mode acceptEdits);
 *                  other accounts (light): `running` only
 *   changes        session `changes` (feature/export-csv): one local commit through the runner (ahead
 *                  of origin by 1, authored by the account's Git identity) + uncommitted added /
 *                  modified / deleted files, VERIFIED on the worktree before being recorded
 *   runs           `npm run test` on devis-express (passes) and catalogue-produits (1 failure)
 *   notifications  POST /api/internal/notify with the account's server token (clone done, failing
 *                  tests) → one row per member of the project's space
 * Raw SQL only for what the web writes itself without a route for it: the « opened » / « favourite »
 * marks of a seeded project (by id) and « Sessions parallèles » of the account's server (raised to 8
 * so that the live seeded CLIs leave room for the tests).
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext } from '@playwright/test';
import { environments, projects, worktrees } from '@nuera/db';
import type { SessionDto } from '@nuera/shared/runner';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { StackKey } from './config';
import { withStackDb } from './db';
import { SEEDED_PROJECTS_BY_ACCOUNT } from './fixture-repos';
import type { RunnerApi } from './runner-api';
import { accountOf, patchSeeded, runnerOfAccount, seededOf, type SeededChanges, type SeededData, type SeededProject, type SeededRun, type SeededSession, type StackState } from './state';

export const SEED_SCENARIOS = ['github', 'projects', 'sessions', 'changes', 'runs', 'notifications'] as const;
export type SeedScenario = (typeof SEED_SCENARIOS)[number];
/** `all` = everything a domain lot needs (GitHub is connected by `up`). */
export const ALL_SEEDS: SeedScenario[] = ['projects', 'sessions', 'changes', 'runs', 'notifications'];

export interface SeedContext {
  /** Account whose data is seeded (its space, its server, its GitHub source). */
  account: StackKey;
  state(): StackState;
  update(patch: (state: StackState) => void): StackState;
  /** Runner of the account's server. */
  api: RunnerApi;
  log(line: string): void;
  /** Kills and restarts the account's runner (the way a server restart interrupts live PTY sessions). */
  restartRunner(): Promise<void>;
  /** Signs in if needed and connects the account's GitHub source (requires the web). */
  connectGithub(): Promise<void>;
  /** Web API context signed in as the account. */
  request(): Promise<APIRequestContext>;
}

/** Who acts in Nuera Dev for a seeded action (the account, with its Git identity). */
export interface SeedActor {
  userId: string | null;
  gitIdentity?: { name: string; email: string } | null;
}

const MINUTE = 60_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll<T>(label: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, intervalMs = 1500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) throw new Error(`${label} : délai dépassé${lastError ? ` (${lastError instanceof Error ? lastError.message : String(lastError)})` : ''}.`);
    await sleep(intervalMs);
  }
}

/** Waits until `predicate(session)` holds. */
export async function waitForSession(api: RunnerApi, sessionId: string, predicate: (session: SessionDto) => boolean, label: string, timeoutMs = 10 * MINUTE): Promise<SessionDto> {
  let last: SessionDto | null = null;
  try {
    return await poll(label, async () => {
      last = await api('getSession', { params: { sessionId } });
      return predicate(last) ? last : null;
    }, timeoutMs);
  } catch (error) {
    const seen = last as SessionDto | null;
    throw new Error(`${(error as Error).message} Dernier état : ${seen ? `${seen.status}${seen.errorMessage ? ` (${seen.errorMessage})` : ''}` : 'inconnu'}.`, { cause: error });
  }
}

function actorOf(ctx: SeedContext): SeedActor {
  const account = accountOf(ctx.state(), ctx.account);
  return { userId: account.userId, gitIdentity: account.gitIdentity };
}

function serverOf(ctx: SeedContext): { environmentId: string; projectsRoot: string; name: string } {
  const runner = runnerOfAccount(ctx.state(), ctx.account);
  if (!runner.environmentId) throw new Error(`Le serveur « ${runner.name} » n'a pas d'identifiant : relancez \`up\`.`);
  return { environmentId: runner.environmentId, projectsRoot: runner.paths.projects, name: runner.name };
}

function seeded(ctx: SeedContext): SeededData {
  return seededOf(ctx.state(), ctx.account);
}

function record(ctx: SeedContext, patch: (data: SeededData) => void): void {
  ctx.update((state) => patchSeeded(state, ctx.account, patch));
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

const OPENED_MINUTES_AGO: Record<string, number> = { devis: 20, catalogue: 26 * 60, outils: 3 * 24 * 60, carnet: 50 };

function insideRoot(root: string, folder: string): boolean {
  const resolved = path.resolve(folder);
  return resolved.startsWith(path.resolve(root) + path.sep);
}

interface CreateAnswer {
  status: number;
  body: { projectId?: string; operationId?: string; error?: { reason?: string; message?: string; data?: { suggestedPath?: string } } } | null;
  text: string;
}

async function postProject(request: APIRequestContext, web: string, input: Record<string, unknown>): Promise<CreateAnswer> {
  const response = await request.post(`${web}/api/projects`, { data: input, headers: { origin: web, 'content-type': 'application/json' }, timeout: 300_000 });
  const text = await response.text();
  let body: CreateAnswer['body'] = null;
  try {
    body = JSON.parse(text) as CreateAnswer['body'];
  } catch {
    body = null;
  }
  return { status: response.status(), body, text };
}

async function ensureProject(ctx: SeedContext, key: string, fullName: string): Promise<SeededProject> {
  const state = ctx.state();
  const server = serverOf(ctx);
  const repo = state.allRepos.find((item) => item.fullName === fullName);
  if (!repo) throw new Error(`Dépôt de test inconnu : ${fullName}`);
  const slug = repo.name;
  // Read-only lookup of the account's own row (its server: a project lives on exactly one server).
  const existing = await withStackDb(state.database.url, async (db) => {
    const [row] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.githubFullName, fullName), eq(projects.environmentId, server.environmentId), isNull(projects.archivedAt)))
      .limit(1);
    if (!row) return null;
    const [primary] = await db.select().from(worktrees).where(and(eq(worktrees.projectId, row.id), eq(worktrees.isPrimary, true), isNull(worktrees.removedAt))).limit(1);
    return { row, primary: primary ?? null };
  });
  if (existing?.row.status === 'ready' && existing.primary) {
    const previous = seeded(ctx).projects?.[key];
    return { key, id: existing.row.id, slug: existing.row.slug, name: existing.row.name, fullName, path: existing.row.path, defaultBranch: existing.row.defaultBranch, worktreeId: existing.primary.id, operationId: previous?.operationId ?? '' };
  }
  if (existing) {
    // A clone that failed or was interrupted: start afresh (rows cascade, folder of this server only).
    ctx.log(`  ${fullName} : projet ${existing.row.status}, nouvel essai`);
    await withStackDb(state.database.url, (db) => db.delete(projects).where(eq(projects.id, existing.row.id)));
    if (insideRoot(server.projectsRoot, existing.row.path)) rmSync(path.resolve(existing.row.path), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }

  let projectId: string;
  let operationId: string;
  if (state.options.web) {
    // « Ajouter un projet » (D03): the web writes the row in the account's space and starts the clone.
    const request = await ctx.request();
    try {
      const input = { fullName, name: repo.displayName, destination: slug, installDeps: true, worktreePerSession: true, readClaudeMd: true };
      let answer = await postProject(request, state.urls.web, input);
      if (answer.status === 409 && answer.body?.error?.reason === 'DESTINATION_NOT_EMPTY') {
        // Leftover of a previous seed whose rows were dropped (`up --reset` keeps nothing else).
        const folder = path.join(server.projectsRoot, slug);
        if (existsSync(folder) && insideRoot(server.projectsRoot, folder)) {
          rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
          answer = await postProject(request, state.urls.web, input);
        }
      }
      if (answer.status !== 201 || !answer.body?.projectId || !answer.body.operationId) throw new Error(`POST /api/projects (${fullName}) → HTTP ${answer.status} ${answer.text.slice(0, 400)}`);
      projectId = answer.body.projectId;
      operationId = answer.body.operationId;
    } finally {
      await request.dispose();
    }
  } else {
    // Without the web (--no-web): the row the web would write, in the account's space and server.
    const account = accountOf(state, ctx.account);
    if (!account.spaceId) throw new Error(`Projets : l'espace du compte ${ctx.account} est inconnu (créez le compte avec le web).`);
    let check = await ctx.api('checkDestination', { body: { path: slug, fullName } });
    if (!check.available && insideRoot(server.projectsRoot, check.path) && existsSync(check.path)) {
      rmSync(path.resolve(check.path), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      check = await ctx.api('checkDestination', { body: { path: slug, fullName } });
    }
    if (!check.available) throw new Error(`Destination occupée pour ${fullName} : ${check.path}`);
    const [row] = await withStackDb(state.database.url, (db) =>
      db
        .insert(projects)
        .values({
          spaceId: account.spaceId!,
          environmentId: server.environmentId,
          githubSourceId: account.github.sourceId,
          createdByUserId: account.userId,
          slug,
          name: repo.displayName,
          description: repo.description,
          githubFullName: fullName,
          githubRepoId: repo.id,
          githubInstallationId: repo.installations[account.github.app] ?? null,
          cloneUrl: `https://github.com/${fullName}.git`,
          htmlUrl: `https://github.com/${fullName}`,
          isPrivate: repo.private,
          primaryLanguage: repo.language,
          defaultBranch: repo.defaultBranch,
          path: check.path,
          status: 'cloning',
          commands: {},
          options: { installDeps: true, worktreePerSession: true, readClaudeMd: true },
        })
        .returning(),
    );
    if (!row) throw new Error(`Projet non créé : ${fullName}`);
    const started = await ctx.api('cloneRepo', { body: { projectId: row.id, fullName, destination: check.path, installDeps: true, actorUserId: account.userId } });
    projectId = row.id;
    operationId = started.operationId;
  }
  ctx.log(`  ${fullName} : clonage sur ${server.name}…`);
  const operation = await poll(
    `clonage de ${fullName}`,
    async () => {
      const snapshot = await ctx.api('getOperation', { params: { operationId } });
      return snapshot.status === 'succeeded' || snapshot.status === 'failed' || snapshot.status === 'cancelled' ? snapshot : null;
    },
    15 * MINUTE,
  );
  if (operation.status !== 'succeeded') {
    throw new Error(`Clonage de ${fullName} : ${operation.error?.message ?? operation.status}\n${operation.error?.raw ?? operation.log.slice(-2000)}`);
  }
  const result = operation.result as { worktreeId: string; path: string };
  // Marks the web records when the account opens the project / stars it in the list.
  await withStackDb(state.database.url, (db) =>
    db
      .update(projects)
      .set({ lastOpenedAt: new Date(Date.now() - (OPENED_MINUTES_AGO[key] ?? 60) * MINUTE), isFavorite: key === 'devis' })
      .where(eq(projects.id, projectId)),
  );
  ctx.log(`  ${fullName} : prêt (${result.path})`);
  return { key, id: projectId, slug, name: repo.displayName, fullName, path: result.path, defaultBranch: repo.defaultBranch, worktreeId: result.worktreeId, operationId };
}

export async function seedProjects(ctx: SeedContext): Promise<Record<string, SeededProject>> {
  ctx.log('Projets…');
  const wanted = SEEDED_PROJECTS_BY_ACCOUNT[ctx.account];
  // The clones run in parallel on the account's runner (2 or 3 POST /api/projects, far below its rate limit).
  const entries = await Promise.all(wanted.map(async ({ key, fullName }) => [key, await ensureProject(ctx, key, fullName)] as const));
  const projectsByKey = Object.fromEntries(entries);
  record(ctx, (data) => {
    data.projects = projectsByKey;
  });
  return projectsByKey;
}

function requireProjects(ctx: SeedContext, keys: string[] = ['devis']): Record<string, SeededProject> {
  const data = seeded(ctx).projects;
  if (!data || keys.some((key) => !data[key])) throw new Error("Projets absents : lancez d'abord `seed projects`.");
  return data;
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

export interface SessionSpec {
  key: string;
  title: string;
  branch: string;
  permissionMode: 'manual' | 'acceptEdits' | 'auto' | 'plan' | 'dontAsk' | 'bypassPermissions';
  instruction: string;
  permissionWaitSeconds?: number;
}

/** Instructions are plain French: the fake CLI's scripts declare the sentences they answer (`match`). */
export const SESSION_SPECS: Record<'interrupted' | 'finished' | 'waitingPermission' | 'running' | 'changes', SessionSpec> = {
  interrupted: {
    key: 'interrupted',
    title: 'Relance automatique des devis',
    branch: 'feature/relance-devis',
    permissionMode: 'manual',
    instruction: "Regarde comment ajouter une relance automatique des devis non signés après 7 jours, sans rien modifier pour l'instant.",
  },
  finished: {
    key: 'finished',
    title: 'Remise par ligne de devis',
    branch: 'feature/remise-par-ligne',
    permissionMode: 'manual',
    instruction: 'Ajoute une remise en pourcentage sur chaque ligne de devis, appliquée avant la TVA, puis lance les tests.',
  },
  waitingPermission: {
    key: 'waitingPermission',
    title: "Tests du parcours d'un devis",
    branch: 'test/parcours-devis',
    permissionMode: 'manual',
    instruction: "Écris un test du parcours complet d'un devis : création, lignes, remise et totaux. Lance d'abord toute la suite.",
    permissionWaitSeconds: 3600,
  },
  running: {
    key: 'running',
    title: 'Remises de fidélité clients',
    branch: 'feature/remises-fidelite',
    permissionMode: 'acceptEdits',
    instruction: "Ajoute des remises de fidélité selon l'ancienneté du client et garde les tests au vert pendant que tu travailles.",
  },
  changes: {
    key: 'changes',
    title: 'Export CSV des devis',
    branch: 'feature/export-csv',
    permissionMode: 'acceptEdits',
    instruction: 'Crée un export CSV des devis : une ligne par article, puis les totaux.',
  },
};

/** Second instruction of the `changes` session (left uncommitted). */
export const CHANGES_FOLLOW_UP = "Ajoute un test pour l'export CSV, documente le format dans le README et supprime l'ancien format d'import.";

/** First free branch name: `wanted`, else `wanted-2`, `wanted-3`… (a test can run many times on one stack). */
export async function freeBranch(api: RunnerApi, projectId: string, wanted: string): Promise<string> {
  const listed = await api('listBranches', { params: { projectId } });
  const names = new Set(listed.branches.map((branch) => branch.name));
  if (!names.has(wanted)) return wanted;
  for (let n = 2; n < 1000; n += 1) if (!names.has(`${wanted}-${n}`)) return `${wanted}-${n}`;
  throw new Error(`Aucune branche libre pour ${wanted}`);
}

export interface TestSessionInput {
  title: string;
  /** Wanted branch of the new worktree (made unique with -2, -3…). */
  branch: string;
  permissionMode?: SessionSpec['permissionMode'];
  /** Seconds the CLI waits for a permission decision (runner default otherwise). */
  permissionWaitSeconds?: number;
  /** Start the CLI right away (default: at the first instruction, like the web). */
  start?: boolean;
}

/**
 * Creates a session on a project exactly as the web does (new worktree from the default branch,
 * same launch options as buildSessionMcpConfig() for a project without MCP server, Git identity of
 * the account that starts it). `actor` may be a StackState (its owner) for older callers.
 */
export async function createTestSession(api: RunnerApi, actor: SeedActor | Pick<StackState, 'owner'>, project: Pick<SeededProject, 'id' | 'defaultBranch'>, input: TestSessionInput): Promise<SessionDto> {
  const who: SeedActor = 'owner' in actor ? { userId: actor.owner.userId, gitIdentity: { name: actor.owner.name, email: actor.owner.email } } : actor;
  const branch = await freeBranch(api, project.id, input.branch);
  // ENABLE_CLAUDEAI_MCP_SERVERS=false is set by the runner itself.
  return api('createSession', {
    body: {
      projectId: project.id,
      title: input.title,
      worktree: { mode: 'new', branch, base: project.defaultBranch },
      permissionMode: input.permissionMode ?? 'manual',
      model: null,
      effort: null,
      remoteControl: false,
      launch: {
        mcpConfig: { mcpServers: {} },
        denyRules: [],
        env: {},
        ...(input.permissionWaitSeconds ? { permissionWaitSeconds: input.permissionWaitSeconds } : {}),
        ...(who.gitIdentity ? { gitIdentity: who.gitIdentity } : {}),
      },
      start: input.start ?? false,
      createdByUserId: who.userId,
    },
  });
}

function createSession(ctx: SeedContext, project: SeededProject, spec: SessionSpec): Promise<SessionDto> {
  return createTestSession(ctx.api, actorOf(ctx), project, spec);
}

const normalize = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim();
export const turnDone = (instruction: string) => (session: SessionDto) =>
  session.status === 'waiting_input' && session.queuedInstructions === 0 && normalize(session.lastInstruction) === normalize(instruction);

function seededSession(key: string, session: SessionDto, extra: Partial<SeededSession> = {}): SeededSession {
  return {
    key,
    id: session.id,
    title: session.title,
    projectId: session.projectId,
    worktreeId: session.worktreeId,
    branch: session.worktree?.branch ?? null,
    status: session.status,
    permissionMode: session.permissionMode,
    ...extra,
  };
}

async function stillValid(ctx: SeedContext, previous: SeededSession | undefined, predicate: (session: SessionDto) => boolean): Promise<SessionDto | null> {
  if (!previous) return null;
  try {
    const session = await ctx.api('getSession', { params: { sessionId: previous.id } });
    return predicate(session) ? session : null;
  } catch {
    return null;
  }
}

/**
 * Sends `instruction` and waits for the end of the turn. With `allowPermissions`, every permission
 * the CLI asks for is allowed on the way (the account clicking « Autoriser » in Nuera Dev).
 */
async function runTurn(ctx: SeedContext, session: SessionDto, instruction: string, label: string, options: { allowPermissions?: boolean } = {}): Promise<SessionDto> {
  await ctx.api('sendInstruction', { params: { sessionId: session.id }, body: { text: instruction } });
  const done = turnDone(instruction);
  if (!options.allowPermissions) return waitForSession(ctx.api, session.id, done, label, 12 * MINUTE);
  const answered = new Set<string>();
  const decidedByUserId = actorOf(ctx).userId;
  return waitForSession(
    ctx.api,
    session.id,
    (current) => {
      const pending = current.pendingPermission;
      if (pending && !answered.has(pending.id)) {
        answered.add(pending.id);
        void ctx.api('permissionDecision', { params: { permissionId: pending.id }, body: { behavior: 'allow', always: false, decidedByUserId } }).catch((error: unknown) => {
          ctx.log(`  autorisation ${pending.id} : ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      return done(current);
    },
    label,
    12 * MINUTE,
  );
}

async function seedFinished(ctx: SeedContext, project: SeededProject): Promise<SeededSession> {
  const spec = SESSION_SPECS.finished;
  const created = await createSession(ctx, project, spec);
  await ctx.api('sendInstruction', { params: { sessionId: created.id }, body: { text: spec.instruction } });
  const asking = await waitForSession(ctx.api, created.id, (session) => session.pendingPermission !== null, "session « terminée » : demande d'autorisation", 12 * MINUTE);
  // The account clicks « Autoriser » in Nuera Dev.
  await ctx.api('permissionDecision', { params: { permissionId: asking.pendingPermission!.id }, body: { behavior: 'allow', always: false, decidedByUserId: actorOf(ctx).userId } });
  await waitForSession(ctx.api, created.id, turnDone(spec.instruction), 'session « terminée » : fin du tour', 12 * MINUTE);
  // `/exit` typed in the session's terminal: the CLI ends by itself → « Terminée ».
  const terminal = await ctx.api('sessionTerminal', { params: { sessionId: created.id } });
  if (!terminal.terminalId) throw new Error('Terminal de session introuvable.');
  await ctx.api('terminalInput', { params: { terminalId: terminal.terminalId }, body: { data: '/exit\r' } });
  const finished = await waitForSession(ctx.api, created.id, (session) => session.status === 'finished', 'session « terminée » : /exit', 5 * MINUTE);
  return seededSession('finished', finished);
}

async function seedInterruptedTurn(ctx: SeedContext, project: SeededProject): Promise<SessionDto> {
  const spec = SESSION_SPECS.interrupted;
  const created = await createSession(ctx, project, spec);
  return runTurn(ctx, created, spec.instruction, 'session « interrompue » : premier tour');
}

async function seedWaitingPermission(ctx: SeedContext, project: SeededProject): Promise<SeededSession> {
  const spec = SESSION_SPECS.waitingPermission;
  const created = await createSession(ctx, project, spec);
  await ctx.api('sendInstruction', { params: { sessionId: created.id }, body: { text: spec.instruction } });
  const waiting = await waitForSession(ctx.api, created.id, (session) => session.status === 'waiting_permission' && session.pendingPermission !== null, 'session « autorisation demandée »', 12 * MINUTE);
  return seededSession('waitingPermission', waiting, { permissionId: waiting.pendingPermission!.id });
}

async function seedRunning(ctx: SeedContext, project: SeededProject): Promise<SeededSession> {
  const spec = SESSION_SPECS.running;
  const created = await createSession(ctx, project, spec);
  await ctx.api('sendInstruction', { params: { sessionId: created.id }, body: { text: spec.instruction } });
  await poll(
    'session « en cours » : étape longue',
    async () => {
      const events = await ctx.api('sessionEvents', { params: { sessionId: created.id }, query: { limit: 500 } });
      return events.items.some((item) => item.kind === 'tool' && item.payload.status === 'running' && (item.payload.target ?? '').includes('--watch'));
    },
    12 * MINUTE,
  );
  const running = await waitForSession(ctx.api, created.id, (session) => session.status === 'running', 'session « en cours »', 2 * MINUTE);
  return seededSession('running', running);
}

const isLiveWaitingPermission = (session: SessionDto) => session.live && session.status === 'waiting_permission' && session.pendingPermission !== null;
const isLiveRunning = (session: SessionDto) => session.live && session.status === 'running';

/**
 * The seeds keep up to 3 CLIs alive per server (autorisation demandée, en cours, export CSV):
 * « Sessions parallèles » of the account's server (`environments.max_concurrent_sessions`, written by
 * Paramètres › Serveur) is raised to SEED_MAX_SESSIONS so that the tests can still open sessions. A
 * higher value set by a test is kept.
 */
export const SEED_MAX_SESSIONS = 8;

async function ensureSessionCapacity(ctx: SeedContext): Promise<void> {
  const { environmentId } = serverOf(ctx);
  await withStackDb(ctx.state().database.url, (db) =>
    db
      .update(environments)
      .set({
        maxConcurrentSessions: sql`greatest(${environments.maxConcurrentSessions}, ${SEED_MAX_SESSIONS})`,
        maxConcurrentSessionsCap: sql`greatest(${environments.maxConcurrentSessionsCap}, ${SEED_MAX_SESSIONS})`,
      })
      .where(eq(environments.id, environmentId)),
  );
}

export async function seedSessions(ctx: SeedContext): Promise<Record<string, SeededSession>> {
  ctx.log('Sessions…');
  await ensureSessionCapacity(ctx);
  const { devis } = requireProjects(ctx) as Record<'devis', SeededProject>;
  const previous = seeded(ctx).sessions ?? {};
  const result: Record<string, SeededSession> = {};

  if (ctx.account !== 'a') {
    // Other accounts: one live session on their own server (simultaneous work, isolation).
    const running = await stillValid(ctx, previous.running, isLiveRunning);
    ctx.log(`  « en cours »${running ? ' (déjà en place)' : ''}…`);
    result.running = running ? seededSession('running', running) : await seedRunning(ctx, devis);
    record(ctx, (data) => {
      data.sessions = { ...data.sessions, ...result };
    });
    return result;
  }

  const interrupted = await stillValid(ctx, previous.interrupted, (session) => session.status === 'interrupted' && session.resumable);
  const finished = await stillValid(ctx, previous.finished, (session) => session.status === 'finished');
  if (interrupted) result.interrupted = seededSession('interrupted', interrupted);
  if (finished) result.finished = seededSession('finished', finished);

  if (!interrupted) {
    // Both CLIs work at the same time, then the runner restarts: the live one becomes « Interrompue ».
    ctx.log('  « interrompue » (premier tour) et « terminée »…');
    const [turn, done] = await Promise.all([seedInterruptedTurn(ctx, devis), finished ? Promise.resolve(null) : seedFinished(ctx, devis)]);
    if (done) result.finished = done;
    ctx.log(`  redémarrage du runner (interrompt les sessions vivantes, comme un redémarrage de ${serverOf(ctx).name})…`);
    await ctx.restartRunner();
    const after = await waitForSession(ctx.api, turn.id, (session) => session.status === 'interrupted', 'session « interrompue »', 5 * MINUTE);
    result.interrupted = seededSession('interrupted', after);
  } else if (!finished) {
    ctx.log('  « terminée »…');
    result.finished = await seedFinished(ctx, devis);
  }

  const waiting = await stillValid(ctx, previous.waitingPermission, isLiveWaitingPermission);
  const running = await stillValid(ctx, previous.running, isLiveRunning);
  ctx.log(`  « autorisation demandée »${waiting ? ' (déjà en place)' : ''} et « en cours »${running ? ' (déjà en place)' : ''}…`);
  const [waitingSeed, runningSeed] = await Promise.all([
    waiting ? Promise.resolve(seededSession('waitingPermission', waiting, { permissionId: waiting.pendingPermission!.id })) : seedWaitingPermission(ctx, devis),
    running ? Promise.resolve(seededSession('running', running)) : seedRunning(ctx, devis),
  ]);
  result.waitingPermission = waitingSeed;
  result.running = runningSeed;
  if (previous.changes) result.changes = previous.changes;

  record(ctx, (data) => {
    data.sessions = { ...data.sessions, ...result };
  });
  return result;
}

// ---------------------------------------------------------------------------------------------
// Changes (Diff / Git panels)
// ---------------------------------------------------------------------------------------------

const COMMITTED = ['src/export-csv.js', 'src/index.js'];
const UNCOMMITTED: SeededChanges['uncommitted'] = [
  { path: 'test/export-csv.test.js', change: 'added' },
  { path: 'src/montants.js', change: 'modified' },
  { path: 'README.md', change: 'modified' },
  { path: 'docs/ancien-format.md', change: 'deleted' },
];

const CHANGE_LETTERS: Record<SeededChanges['uncommitted'][number]['change'], string[]> = { added: ['A', '?'], modified: ['M'], deleted: ['D'] };

/** Uncommitted changes the worktree really holds (what the Diff / Git panels show), or the missing ones. */
async function missingChanges(ctx: SeedContext, worktreeId: string): Promise<string[]> {
  const changes = await ctx.api('worktreeChanges', { params: { worktreeId } });
  return UNCOMMITTED.filter((item) => !changes.files.some((file) => file.path === item.path && CHANGE_LETTERS[item.change].includes(file.status) && (file.staged || file.unstaged))).map((item) => `${item.path} (${item.change})`);
}

async function changesStillValid(ctx: SeedContext, previous: SeededChanges | undefined): Promise<boolean> {
  if (!previous) return false;
  try {
    const ahead = await ctx.api('aheadBehind', { params: { worktreeId: previous.worktreeId } });
    return ahead.ahead >= 1 && (await missingChanges(ctx, previous.worktreeId)).length === 0;
  } catch {
    return false;
  }
}

export async function seedChanges(ctx: SeedContext): Promise<SeededChanges> {
  ctx.log('Changements (diff et Git)…');
  const { devis } = requireProjects(ctx) as Record<'devis', SeededProject>;
  const previous = seeded(ctx).changes;
  if (await changesStillValid(ctx, previous)) {
    ctx.log('  déjà en place');
    return previous!;
  }
  await ensureSessionCapacity(ctx);
  const actor = actorOf(ctx);
  const spec = SESSION_SPECS.changes;
  const created = await createSession(ctx, devis, spec);
  await runTurn(ctx, created, spec.instruction, 'session « export CSV » : premier tour', { allowPermissions: true });
  // The account commits part of the work from the Git panel (runner commit route, as the web does).
  const commit = await ctx.api('commit', {
    params: { worktreeId: created.worktreeId! },
    body: {
      message: 'feat: export CSV des devis',
      body: 'Une ligne par article, puis les totaux HT, TVA et TTC.',
      author: actor.gitIdentity ?? { name: accountOf(ctx.state(), ctx.account).name, email: accountOf(ctx.state(), ctx.account).email },
      paths: COMMITTED,
      sessionId: created.id,
      actorUserId: actor.userId,
    },
  });
  // `rm docs/ancien-format.md` is a command: asked even in acceptEdits mode, allowed by the account.
  const after = await runTurn(ctx, created, CHANGES_FOLLOW_UP, 'session « export CSV » : second tour', { allowPermissions: true });
  // Never record changes that did not happen (CRLF clones once made the edits silent no-ops).
  const missing = await missingChanges(ctx, created.worktreeId!);
  if (missing.length) throw new Error(`Changements attendus absents du worktree ${created.worktreeId} : ${missing.join(', ')}.`);
  const changes: SeededChanges = {
    sessionId: created.id,
    worktreeId: created.worktreeId!,
    branch: after.worktree?.branch ?? spec.branch,
    commitSha: commit.sha,
    committedPaths: COMMITTED,
    uncommitted: UNCOMMITTED,
  };
  record(ctx, (data) => {
    data.changes = changes;
    data.sessions = { ...data.sessions, changes: seededSession('changes', after) };
  });
  ctx.log(`  commit ${commit.shortSha} + ${UNCOMMITTED.length} fichiers modifiés non commités (vérifiés)`);
  return changes;
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

async function runTests(ctx: SeedContext, project: SeededProject): Promise<SeededRun> {
  const actor = actorOf(ctx);
  const created = await ctx.api('createRun', { body: { projectId: project.id, kind: 'test', actorUserId: actor.userId, ...(actor.gitIdentity ? { gitIdentity: actor.gitIdentity } : {}) } });
  const run = await poll(`tests de ${project.name}`, async () => {
    const current = await ctx.api('getRun', { params: { runId: created.id } });
    return current.status !== 'running' ? current : null;
  }, 10 * MINUTE);
  return { id: run.id, projectId: project.id, command: run.command, status: run.status, summary: run.summary };
}

export async function seedRuns(ctx: SeedContext): Promise<{ passed: SeededRun; failed: SeededRun }> {
  ctx.log('Exécutions de tests…');
  const { devis, catalogue } = requireProjects(ctx, ['devis', 'catalogue']) as Record<'devis' | 'catalogue', SeededProject>;
  const previous = seeded(ctx).runs;
  const valid = async (run: SeededRun | undefined, status: string) => {
    if (!run) return false;
    try {
      return (await ctx.api('getRun', { params: { runId: run.id } })).status === status;
    } catch {
      return false;
    }
  };
  const [passed, failed] = await Promise.all([
    (await valid(previous?.passed, 'succeeded')) ? previous!.passed! : runTests(ctx, devis),
    (await valid(previous?.failed, 'failed')) ? previous!.failed! : runTests(ctx, catalogue),
  ]);
  if (passed.status !== 'succeeded') throw new Error(`Les tests de ${devis.name} devaient passer : ${passed.status} (${passed.summary ?? 'sans résumé'}).`);
  if (failed.status !== 'failed') throw new Error(`Les tests de ${catalogue.name} devaient échouer : ${failed.status} (${failed.summary ?? 'sans résumé'}).`);
  record(ctx, (data) => {
    data.runs = { passed, failed };
  });
  ctx.log(`  ${devis.name} : ${passed.summary ?? passed.status} · ${catalogue.name} : ${failed.summary ?? failed.status}`);
  return { passed, failed };
}

// ---------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------

export async function seedNotifications(ctx: SeedContext): Promise<string[]> {
  ctx.log('Notifications…');
  const state = ctx.state();
  if (!state.options.web) throw new Error('Notifications : la pile tourne sans web (--no-web).');
  const data = requireProjects(ctx);
  const runner = runnerOfAccount(state, ctx.account);
  const failedRun = data.catalogue ? seeded(ctx).runs?.failed : undefined;
  const ready = Object.values(data).filter((project) => project.key !== 'catalogue' || !failedRun);
  const inputs = [
    ...ready.slice(0, 1).map((project) => ({
      kind: 'operation_succeeded',
      severity: 'success',
      title: `${project.name} est prêt`,
      body: 'Clonage terminé, dépendances installées · dev · build · test · lint',
      href: `/projets/${project.id}`,
      projectId: project.id,
      dedupKey: `harness:clone:${project.id}`,
    })),
    ...(data.catalogue && failedRun
      ? [
          {
            kind: 'operation_failed',
            severity: 'danger',
            title: `Tests en échec · ${data.catalogue.name}`,
            body: failedRun.summary ? `${failedRun.summary} · ${failedRun.command}` : 'npm run test',
            href: `/projets/${data.catalogue.id}`,
            projectId: data.catalogue.id,
            dedupKey: `harness:run:${failedRun.id}`,
          },
        ]
      : ready.slice(1, 2).map((project) => ({
          kind: 'operation_succeeded',
          severity: 'success',
          title: `${project.name} est prêt`,
          body: 'Clonage terminé, dépendances installées',
          href: `/projets/${project.id}`,
          projectId: project.id,
          dedupKey: `harness:clone:${project.id}`,
        }))),
  ];
  const ids: string[] = [];
  for (const input of inputs) {
    const response = await fetch(`${state.urls.web}/api/internal/notify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${runner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`POST /api/internal/notify (${runner.name}) → HTTP ${response.status} ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { notification?: { id?: string }; notifications?: Array<{ id?: string }> };
    for (const id of [body.notification?.id, ...(body.notifications ?? []).map((item) => item.id)]) if (id) ids.push(id);
  }
  record(ctx, (current) => {
    current.notifications = { ids, at: new Date().toISOString() };
  });
  return ids;
}

// ---------------------------------------------------------------------------------------------

export function expandScenarios(input: string[]): SeedScenario[] {
  const out = new Set<SeedScenario>();
  for (const raw of input.flatMap((item) => item.split(/[\s,]+/)).filter(Boolean)) {
    if (raw === 'all') ALL_SEEDS.forEach((item) => out.add(item));
    else if ((SEED_SCENARIOS as readonly string[]).includes(raw)) out.add(raw as SeedScenario);
    else throw new Error(`Scénario inconnu « ${raw} » (${[...SEED_SCENARIOS, 'all'].join(', ')}).`);
  }
  // Dependencies: everything but `github` needs the projects (SEED_SCENARIOS is in dependency order).
  if ([...out].some((item) => item !== 'github')) out.add('projects');
  return SEED_SCENARIOS.filter((item) => out.has(item));
}

export async function runSeedScenarios(ctx: SeedContext, scenarios: SeedScenario[]): Promise<void> {
  for (const scenario of scenarios) {
    const started = Date.now();
    if (scenario === 'github') await ctx.connectGithub();
    else if (scenario === 'projects') await seedProjects(ctx);
    else if (scenario === 'sessions') await seedSessions(ctx);
    else if (scenario === 'changes') await seedChanges(ctx);
    else if (scenario === 'runs') await seedRuns(ctx);
    else if (scenario === 'notifications') await seedNotifications(ctx);
    ctx.log(`  → ${scenario} en ${Math.round((Date.now() - started) / 1000)} s`);
  }
}
