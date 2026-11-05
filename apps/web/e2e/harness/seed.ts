/**
 * TEST-ONLY — seed scenarios of a stack, through the REAL code paths (runner API, web internal
 * routes). Each scenario is idempotent: it checks what exists and only (re)creates what is missing
 * or has drifted (a waiting permission answered, a long task finished…).
 *
 *   github         GitHub App connected through the real web routes (see github-connect.ts)
 *   projects       devis-express, catalogue-produits (one red test), outils-cli: project rows written
 *                  exactly as the web will (status cloning) + runner `cloneRepo` (real clone + npm ci)
 *   sessions       on devis-express: `finished` (plan, Edit allowed in Nuera, real tests, /exit),
 *                  `interrupted` (read-only turn, then a runner restart → « Interrompue · reprise
 *                  possible »), `waitingPermission` (`npm run test` waits for a decision, up to 1 h),
 *                  `running` (plan + watch mode for 6 h, mode acceptEdits)
 *   changes        session `changes` (feature/export-csv): one local commit through the runner
 *                  (ahead of origin by 1) + uncommitted added / modified / deleted files
 *   runs           `npm run test` on devis-express (passes) and catalogue-produits (1 failure)
 *   notifications  POST /api/internal/notify (clone done, failing tests), on top of the ones the
 *                  runner sends by itself (permission request, finished turns)
 * Raw SQL is used only for the project rows (no web API yet) and the owner's « opened » /
 * « favourite » marks on them — rows the web itself writes.
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { projects, worktrees } from '@nuera/db';
import type { SessionDto } from '@nuera/shared/runner';
import { and, eq, isNull } from 'drizzle-orm';
import { withStackDb } from './db';
import { SEEDED_PROJECTS } from './fixture-repos';
import type { RunnerApi } from './runner-api';
import type { SeededChanges, SeededProject, SeededRun, SeededSession, StackState } from './state';

export const SEED_SCENARIOS = ['github', 'projects', 'sessions', 'changes', 'runs', 'notifications'] as const;
export type SeedScenario = (typeof SEED_SCENARIOS)[number];
/** `all` = everything a domain lot needs (GitHub is connected by `up`). */
export const ALL_SEEDS: SeedScenario[] = ['projects', 'sessions', 'changes', 'runs', 'notifications'];

export interface SeedContext {
  state(): StackState;
  update(patch: (state: StackState) => void): StackState;
  api: RunnerApi;
  log(line: string): void;
  /** Kills and restarts the runner (the way a server restart interrupts live PTY sessions). */
  restartRunner(): Promise<void>;
  /** Signs in if needed and connects the GitHub App (requires the web). */
  connectGithub(): Promise<void>;
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
    throw new Error(`${(error as Error).message} Dernier état : ${seen ? `${seen.status}${seen.errorMessage ? ` (${seen.errorMessage})` : ''}` : 'inconnu'}.`);
  }
}

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

const OPENED_MINUTES_AGO: Record<string, number> = { devis: 20, catalogue: 26 * 60, outils: 3 * 24 * 60 };

async function ensureProject(ctx: SeedContext, key: string, fullName: string): Promise<SeededProject> {
  const state = ctx.state();
  const repo = state.repos.find((item) => item.fullName === fullName);
  if (!repo) throw new Error(`Dépôt de test inconnu : ${fullName}`);
  const slug = repo.name;
  const existing = await withStackDb(state.database.url, async (db) => {
    const [row] = await db.select().from(projects).where(and(eq(projects.githubFullName, fullName), isNull(projects.archivedAt))).limit(1);
    if (!row) return null;
    const [primary] = await db.select().from(worktrees).where(and(eq(worktrees.projectId, row.id), eq(worktrees.isPrimary, true), isNull(worktrees.removedAt))).limit(1);
    return { row, primary: primary ?? null };
  });
  if (existing?.row.status === 'ready' && existing.primary) {
    const previous = state.seeded.projects?.[key];
    return { key, id: existing.row.id, slug: existing.row.slug, name: existing.row.name, fullName, path: existing.row.path, defaultBranch: existing.row.defaultBranch, worktreeId: existing.primary.id, operationId: previous?.operationId ?? '' };
  }
  if (existing) {
    // A clone that failed or was interrupted: start afresh (rows cascade, folder of this stack only).
    ctx.log(`  ${fullName} : projet ${existing.row.status}, nouvel essai`);
    await withStackDb(state.database.url, (db) => db.delete(projects).where(eq(projects.id, existing.row.id)));
    const folder = path.resolve(existing.row.path);
    if (folder.startsWith(path.resolve(state.paths.projects) + path.sep)) rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }

  let check = await ctx.api('checkDestination', { body: { path: slug, fullName } });
  if (!check.available) {
    const folder = path.resolve(check.path);
    if (folder.startsWith(path.resolve(state.paths.projects) + path.sep) && existsSync(folder)) {
      // Leftover of a previous seed whose rows were dropped (`up --reset` keeps nothing else).
      rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      check = await ctx.api('checkDestination', { body: { path: slug, fullName } });
    }
    if (!check.available) throw new Error(`Destination occupée pour ${fullName} : ${check.path}`);
  }

  const [row] = await withStackDb(state.database.url, (db) =>
    db
      .insert(projects)
      .values({
        slug,
        name: repo.displayName,
        description: repo.description,
        githubFullName: fullName,
        githubRepoId: repo.id,
        githubInstallationId: repo.installationId,
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
  ctx.log(`  ${fullName} : clonage…`);
  const started = await ctx.api('cloneRepo', { body: { projectId: row.id, fullName, destination: check.path, installDeps: true, actorUserId: state.owner.userId } });
  const operation = await poll(
    `clonage de ${fullName}`,
    async () => {
      const snapshot = await ctx.api('getOperation', { params: { operationId: started.operationId } });
      return snapshot.status === 'succeeded' || snapshot.status === 'failed' || snapshot.status === 'cancelled' ? snapshot : null;
    },
    15 * MINUTE,
  );
  if (operation.status !== 'succeeded') {
    throw new Error(`Clonage de ${fullName} : ${operation.error?.message ?? operation.status}\n${operation.error?.raw ?? operation.log.slice(-2000)}`);
  }
  const result = operation.result as { worktreeId: string; path: string };
  // Owner actions the web records (project opened from Projets, star in the list).
  await withStackDb(state.database.url, (db) =>
    db
      .update(projects)
      .set({ lastOpenedAt: new Date(Date.now() - (OPENED_MINUTES_AGO[key] ?? 60) * MINUTE), isFavorite: key === 'devis' })
      .where(eq(projects.id, row.id)),
  );
  ctx.log(`  ${fullName} : prêt (${result.path})`);
  return { key, id: row.id, slug, name: repo.displayName, fullName, path: result.path, defaultBranch: repo.defaultBranch, worktreeId: result.worktreeId, operationId: started.operationId };
}

export async function seedProjects(ctx: SeedContext): Promise<Record<string, SeededProject>> {
  ctx.log('Projets…');
  const entries = await Promise.all(SEEDED_PROJECTS.map(async ({ key, fullName }) => [key, await ensureProject(ctx, key, fullName)] as const));
  const seeded = Object.fromEntries(entries);
  ctx.update((state) => {
    state.seeded.projects = seeded;
  });
  return seeded;
}

function requireProjects(ctx: SeedContext): Record<string, SeededProject> {
  const seeded = ctx.state().seeded.projects;
  if (!seeded?.devis || !seeded.catalogue) throw new Error("Projets absents : lancez d'abord `seed projects`.");
  return seeded;
}

// ---------------------------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------------------------

interface SessionSpec {
  key: string;
  title: string;
  branch: string;
  permissionMode: 'manual' | 'acceptEdits';
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

async function freeBranch(ctx: SeedContext, projectId: string, wanted: string): Promise<string> {
  const listed = await ctx.api('listBranches', { params: { projectId } });
  const names = new Set(listed.branches.map((branch) => branch.name));
  if (!names.has(wanted)) return wanted;
  for (let n = 2; n < 100; n += 1) if (!names.has(`${wanted}-${n}`)) return `${wanted}-${n}`;
  throw new Error(`Aucune branche libre pour ${wanted}`);
}

async function createSession(ctx: SeedContext, project: SeededProject, spec: SessionSpec): Promise<SessionDto> {
  const state = ctx.state();
  const branch = await freeBranch(ctx, project.id, spec.branch);
  // Same launch options as the web's buildSessionMcpConfig() for a project without MCP server
  // (ENABLE_CLAUDEAI_MCP_SERVERS=false is set by the runner itself).
  return ctx.api('createSession', {
    body: {
      projectId: project.id,
      title: spec.title,
      worktree: { mode: 'new', branch, base: project.defaultBranch },
      permissionMode: spec.permissionMode,
      model: null,
      effort: null,
      remoteControl: false,
      launch: { mcpConfig: { mcpServers: {} }, denyRules: [], env: {}, ...(spec.permissionWaitSeconds ? { permissionWaitSeconds: spec.permissionWaitSeconds } : {}) },
      start: false,
      createdByUserId: state.owner.userId,
    },
  });
}

const normalize = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim();
const turnDone = (instruction: string) => (session: SessionDto) =>
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

async function stillValid(ctx: SeedContext, seeded: SeededSession | undefined, predicate: (session: SessionDto) => boolean): Promise<SessionDto | null> {
  if (!seeded) return null;
  try {
    const session = await ctx.api('getSession', { params: { sessionId: seeded.id } });
    return predicate(session) ? session : null;
  } catch {
    return null;
  }
}

async function runTurn(ctx: SeedContext, session: SessionDto, instruction: string, label: string): Promise<SessionDto> {
  await ctx.api('sendInstruction', { params: { sessionId: session.id }, body: { text: instruction } });
  return waitForSession(ctx.api, session.id, turnDone(instruction), label, 12 * MINUTE);
}

async function seedFinished(ctx: SeedContext, project: SeededProject): Promise<SeededSession> {
  const spec = SESSION_SPECS.finished;
  const created = await createSession(ctx, project, spec);
  await ctx.api('sendInstruction', { params: { sessionId: created.id }, body: { text: spec.instruction } });
  const asking = await waitForSession(ctx.api, created.id, (session) => session.pendingPermission !== null, "session « terminée » : demande d'autorisation", 12 * MINUTE);
  // The owner clicks « Autoriser » in Nuera Dev.
  await ctx.api('permissionDecision', { params: { permissionId: asking.pendingPermission!.id }, body: { behavior: 'allow', always: false, decidedByUserId: ctx.state().owner.userId } });
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

export async function seedSessions(ctx: SeedContext): Promise<Record<string, SeededSession>> {
  ctx.log('Sessions…');
  const { devis } = requireProjects(ctx) as Record<'devis', SeededProject>;
  const previous = ctx.state().seeded.sessions ?? {};
  const result: Record<string, SeededSession> = {};

  const interrupted = await stillValid(ctx, previous.interrupted, (session) => session.status === 'interrupted' && session.resumable);
  const finished = await stillValid(ctx, previous.finished, (session) => session.status === 'finished');
  if (interrupted) result.interrupted = seededSession('interrupted', interrupted);
  if (finished) result.finished = seededSession('finished', finished);

  if (!interrupted) {
    // Both CLIs work at the same time, then the runner restarts: the live one becomes « Interrompue ».
    ctx.log('  « interrompue » (premier tour) et « terminée »…');
    const [turn, done] = await Promise.all([seedInterruptedTurn(ctx, devis), finished ? Promise.resolve(null) : seedFinished(ctx, devis)]);
    if (done) result.finished = done;
    ctx.log('  redémarrage du runner (interrompt les sessions vivantes, comme un redémarrage de VPS-3)…');
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

  ctx.update((state) => {
    state.seeded.sessions = { ...state.seeded.sessions, ...result };
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

async function changesStillValid(ctx: SeedContext, seeded: SeededChanges | undefined): Promise<boolean> {
  if (!seeded) return false;
  try {
    const changes = await ctx.api('worktreeChanges', { params: { worktreeId: seeded.worktreeId } });
    const ahead = await ctx.api('aheadBehind', { params: { worktreeId: seeded.worktreeId } });
    const listed = JSON.stringify(changes);
    return ahead.ahead >= 1 && UNCOMMITTED.every((item) => listed.includes(item.path));
  } catch {
    return false;
  }
}

export async function seedChanges(ctx: SeedContext): Promise<SeededChanges> {
  ctx.log('Changements (diff et Git)…');
  const { devis } = requireProjects(ctx) as Record<'devis', SeededProject>;
  const state = ctx.state();
  const previous = state.seeded.changes;
  if (await changesStillValid(ctx, previous)) {
    ctx.log('  déjà en place');
    return previous!;
  }
  const spec = SESSION_SPECS.changes;
  const created = await createSession(ctx, devis, spec);
  await runTurn(ctx, created, spec.instruction, 'session « export CSV » : premier tour');
  // The owner commits part of the work from the Git panel (runner commit route, as the web will).
  const commit = await ctx.api('commit', {
    params: { worktreeId: created.worktreeId! },
    body: {
      message: 'feat: export CSV des devis',
      body: 'Une ligne par article, puis les totaux HT, TVA et TTC.',
      author: { name: state.owner.name, email: state.owner.email },
      paths: COMMITTED,
      sessionId: created.id,
      actorUserId: state.owner.userId,
    },
  });
  const after = await runTurn(ctx, created, CHANGES_FOLLOW_UP, 'session « export CSV » : second tour');
  const seeded: SeededChanges = {
    sessionId: created.id,
    worktreeId: created.worktreeId!,
    branch: after.worktree?.branch ?? spec.branch,
    commitSha: commit.sha,
    committedPaths: COMMITTED,
    uncommitted: UNCOMMITTED,
  };
  ctx.update((current) => {
    current.seeded.changes = seeded;
    current.seeded.sessions = { ...current.seeded.sessions, changes: seededSession('changes', after) };
  });
  ctx.log(`  commit ${commit.shortSha} + ${UNCOMMITTED.length} fichiers modifiés non commités`);
  return seeded;
}

// ---------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------

async function runTests(ctx: SeedContext, project: SeededProject): Promise<SeededRun> {
  const created = await ctx.api('createRun', { body: { projectId: project.id, kind: 'test', actorUserId: ctx.state().owner.userId } });
  const run = await poll(`tests de ${project.name}`, async () => {
    const current = await ctx.api('getRun', { params: { runId: created.id } });
    return current.status !== 'running' ? current : null;
  }, 10 * MINUTE);
  return { id: run.id, projectId: project.id, command: run.command, status: run.status, summary: run.summary };
}

export async function seedRuns(ctx: SeedContext): Promise<{ passed: SeededRun; failed: SeededRun }> {
  ctx.log('Exécutions de tests…');
  const { devis, catalogue } = requireProjects(ctx) as Record<'devis' | 'catalogue', SeededProject>;
  const previous = ctx.state().seeded.runs;
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
  ctx.update((state) => {
    state.seeded.runs = { passed, failed };
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
  const seededProjects = requireProjects(ctx);
  const devis = seededProjects.devis!;
  const catalogue = seededProjects.catalogue!;
  const failedRun = state.seeded.runs?.failed;
  const inputs = [
    {
      kind: 'operation_succeeded',
      severity: 'success',
      title: `${devis.name} est prêt`,
      body: 'Clonage terminé, dépendances installées · dev · build · test · lint',
      href: `/projets/${devis.id}`,
      projectId: devis.id,
      dedupKey: `harness:clone:${devis.id}`,
    },
    {
      kind: 'operation_failed',
      severity: 'danger',
      title: `Tests en échec · ${catalogue.name}`,
      body: failedRun?.summary ? `${failedRun.summary} · ${failedRun.command}` : 'npm run test',
      href: `/projets/${catalogue.id}`,
      projectId: catalogue.id,
      dedupKey: `harness:run:${failedRun?.id ?? catalogue.id}`,
    },
  ];
  const ids: string[] = [];
  for (const input of inputs) {
    const response = await fetch(`${state.urls.web}/api/internal/notify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.secrets.runnerToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(300_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`POST /api/internal/notify → HTTP ${response.status} ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { notification?: { id?: string } };
    if (body.notification?.id) ids.push(body.notification.id);
  }
  ctx.update((current) => {
    current.seeded.notifications = { ids, at: new Date().toISOString() };
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
