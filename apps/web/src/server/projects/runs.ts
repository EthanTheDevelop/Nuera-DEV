import 'server-only';
import { commandRuns, projects, worktrees } from '@nuera/db/schema';
import { COMMAND_KINDS, type RunDto } from '@nuera/shared/runner';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { RunnerError, isRunnerUnavailable } from '@/server/runner/client';
import { auditIn, scopeOfRun } from '@/server/tenancy/scope';
import { gitIdentityOf, requireProject, type ProjectContext } from './access';
import { decryptedEnvForRuns } from './env';
import { listRunRows, primaryWorktreeId, toRunView } from './queries';
import type { CommandKind, RunView } from './types';

const KIND_LABEL: Record<CommandKind, string> = {
  install: 'installation',
  dev: 'serveur de développement',
  build: 'build',
  test: 'tests',
  lint: 'lint',
  custom: 'commande',
};

export const startRunInputSchema = z.object({
  projectId: z.uuid('projet invalide'),
  /** Default: the project's primary clone. */
  worktreeId: z.uuid('worktree invalide').optional(),
  kind: z.enum(COMMAND_KINDS),
  /** Override of the configured command (« npm run test -- crm »); required for `custom`. */
  command: z.string().trim().min(1).max(4000).optional(),
  cols: z.number().int().min(20).max(500).optional(),
  rows: z.number().int().min(5).max(300).optional(),
});
export type StartRunInput = z.input<typeof startRunInputSchema>;

export interface RunDetail {
  run: RunView;
  /** Still attached to a live process in the runner. */
  live: boolean;
  /** Last output kept by the runner (DB copy), for a run whose live buffer is gone. */
  outputTail: string | null;
  tests: RunDto['tests'];
  projectId: string;
}

/**
 * Starts a project command (D04 « Lancer », Workspace « Tests ») in a worktree of a project of the
 * space, on the project's server, with the project's variables decrypted server-side, the acting
 * account (`command_runs.actor_user_id`) and its Git identity (commits made by the command). The
 * command comes from `projects.commands[kind]` unless the owner typed one; the runner executes it
 * through the platform shell (its documented exception), keeps the output, detects the port and
 * parses the test results.
 */
export async function startRun(ctx: ProjectContext, input: StartRunInput): Promise<{ runId: string; run: RunDto }> {
  const parsed = startRunInputSchema.parse(input);
  const handle = await requireProject(ctx, parsed.projectId, { state: 'ready' });
  const project = handle.row;
  let worktreeId = parsed.worktreeId;
  if (worktreeId) {
    const [row] = await db
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(and(eq(worktrees.id, worktreeId), eq(worktrees.projectId, project.id), eq(worktrees.environmentId, project.environmentId), isNull(worktrees.removedAt)))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', 'Worktree introuvable dans ce projet : il a peut-être été supprimé.', { untouched: 'Aucune commande lancée.' });
  } else {
    worktreeId = (await primaryWorktreeId(project.id)) ?? undefined;
    if (!worktreeId) throw new AppError('CONFLICT', 'Le clone principal de ce projet est introuvable.', { untouched: 'Aucune commande lancée.' });
  }
  const configured = parsed.kind === 'custom' ? null : ((project.commands as Record<string, string | null | undefined>)[parsed.kind] ?? null);
  const command = parsed.command ?? configured;
  if (!command) {
    throw new AppError('VALIDATION', `Aucune commande de ${KIND_LABEL[parsed.kind]} configurée pour ce projet.`, {
      detail: "Renseignez-la dans l'onglet Environnement.",
      untouched: 'Aucune commande lancée.',
    });
  }
  const [env, gitIdentity] = await Promise.all([decryptedEnvForRuns(project.id), gitIdentityOf(ctx)]);
  const run = await handle.runner.createRun({
    body: {
      projectId: project.id,
      worktreeId,
      kind: parsed.kind,
      command,
      env,
      ...(parsed.cols ? { cols: parsed.cols } : {}),
      ...(parsed.rows ? { rows: parsed.rows } : {}),
      actorUserId: ctx.user.id,
      ...(gitIdentity ? { gitIdentity } : {}),
    },
  });
  await auditIn(ctx, {
    action: 'project.run_started',
    summary: `${KIND_LABEL[parsed.kind]} lancé dans ${project.name} : ${command}`,
    targetType: 'run',
    targetId: run.id,
    environmentId: handle.environment.id,
    metadata: { projectId: project.id, worktreeId, kind: parsed.kind, command, custom: Boolean(parsed.command && parsed.command !== configured) },
  });
  return { runId: run.id, run };
}

/** A run of the space (scope first: a run of another space is « Lancement introuvable. »). */
async function requireRun(ctx: ProjectContext, runId: string) {
  const scope = await scopeOfRun(ctx, runId);
  const [row] = await db
    .select({ run: commandRuns, worktreeName: worktrees.name, projectName: projects.name })
    .from(commandRuns)
    .innerJoin(projects, and(eq(projects.id, commandRuns.projectId), eq(projects.spaceId, ctx.space.id)))
    .leftJoin(worktrees, eq(worktrees.id, commandRuns.worktreeId))
    .where(eq(commandRuns.id, scope.runId))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'Lancement introuvable.');
  return { scope, ...row };
}

/** A run: live state from its server's runner when it answers, the stored row otherwise. */
export async function getRunDetail(ctx: ProjectContext, runId: string): Promise<RunDetail> {
  const { scope, run, worktreeName } = await requireRun(ctx, runId);
  const view = toRunView({ ...run, worktreeName });
  try {
    const live = await scope.runner.getRun({ params: { runId: run.id } }, { timeoutMs: 5_000 });
    return {
      run: { ...view, status: live.status, exitCode: live.exitCode, port: live.port, summary: live.summary, finishedAt: live.finishedAt },
      live: live.live,
      outputTail: run.outputTail,
      tests: live.tests,
      projectId: run.projectId,
    };
  } catch (error) {
    if (!(isRunnerUnavailable(error) || (error instanceof RunnerError && error.code === 'NOT_FOUND'))) throw error;
    const report = run.details?.report ?? null;
    return { run: view, live: false, outputTail: run.outputTail, tests: report, projectId: run.projectId };
  }
}

/** « Arrêter » (D04 Lancement, Workspace Tests). Idempotent on an already finished run. */
export async function stopRun(ctx: ProjectContext, runId: string): Promise<RunDto | null> {
  const { scope, run, projectName } = await requireRun(ctx, runId);
  if (run.status !== 'running') return null;
  const stopped = await scope.runner.stopRun({ params: { runId: run.id } });
  await auditIn(ctx, {
    action: 'project.run_stopped',
    summary: `${KIND_LABEL[run.kind]} arrêté dans ${projectName} : ${run.command}`,
    targetType: 'run',
    targetId: run.id,
    environmentId: scope.environmentId,
    metadata: { projectId: run.projectId, kind: run.kind },
  });
  return stopped;
}

export const listRunsQuerySchema = z.object({
  projectId: z.uuid(),
  worktreeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Recent runs of a project of the space or of one of its worktrees (Workspace « Tests », project tabs). */
export async function listRuns(ctx: ProjectContext, input: z.input<typeof listRunsQuerySchema>): Promise<RunView[]> {
  const parsed = listRunsQuerySchema.parse(input);
  const { row } = await requireProject(ctx, parsed.projectId);
  return listRunRows(row.id, {
    ...(parsed.worktreeId ? { worktreeId: parsed.worktreeId } : {}),
    limit: parsed.limit ?? 30,
  });
}
