import 'server-only';
import { commandRuns, worktrees } from '@nuera/db/schema';
import { COMMAND_KINDS, type RunDto } from '@nuera/shared/runner';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { RunnerError, isRunnerUnavailable, runner } from '@/server/runner/client';
import { audit } from '@/server/security/audit';
import { decryptedEnvForRuns } from './env';
import { listRunRows, primaryWorktreeId, requireProjectRow, requireReadyProject, toRunView } from './queries';
import type { CommandKind, RunView } from './types';

type Actor = { id: string };

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
 * Starts a project command (D04 « Lancer », Workspace « Tests ») in a worktree of the project, with
 * the project's variables decrypted server-side. The command comes from `projects.commands[kind]`
 * unless the owner typed one; the runner executes it through the platform shell (its documented
 * exception), keeps the output, detects the port and parses the test results.
 */
export async function startRun(input: StartRunInput, actor: Actor): Promise<{ runId: string; run: RunDto }> {
  const parsed = startRunInputSchema.parse(input);
  const project = await requireReadyProject(parsed.projectId);
  let worktreeId = parsed.worktreeId;
  if (worktreeId) {
    const [row] = await db
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(and(eq(worktrees.id, worktreeId), eq(worktrees.projectId, project.id), isNull(worktrees.removedAt)))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', "Worktree introuvable dans ce projet : il a peut-être été supprimé.", { untouched: 'Aucune commande lancée.' });
  } else {
    worktreeId = (await primaryWorktreeId(project.id)) ?? undefined;
    if (!worktreeId) throw new AppError('CONFLICT', "Le clone principal de ce projet est introuvable.", { untouched: 'Aucune commande lancée.' });
  }
  const configured = parsed.kind === 'custom' ? null : ((project.commands as Record<string, string | null | undefined>)[parsed.kind] ?? null);
  const command = parsed.command ?? configured;
  if (!command) {
    throw new AppError('VALIDATION', `Aucune commande de ${KIND_LABEL[parsed.kind]} configurée pour ce projet.`, {
      detail: "Renseignez-la dans l'onglet Environnement.",
      untouched: 'Aucune commande lancée.',
    });
  }
  const env = await decryptedEnvForRuns(project.id);
  const run = await runner.createRun({
    body: {
      projectId: project.id,
      worktreeId,
      kind: parsed.kind,
      command,
      env,
      ...(parsed.cols ? { cols: parsed.cols } : {}),
      ...(parsed.rows ? { rows: parsed.rows } : {}),
      actorUserId: actor.id,
    },
  });
  await audit({
    action: 'project.run_started',
    summary: `${KIND_LABEL[parsed.kind]} lancé dans ${project.name} : ${command}`,
    targetType: 'run',
    targetId: run.id,
    metadata: { projectId: project.id, worktreeId, kind: parsed.kind, command, custom: Boolean(parsed.command && parsed.command !== configured) },
    actorUserId: actor.id,
  });
  return { runId: run.id, run };
}

async function runRow(runId: string) {
  const [row] = await db
    .select({ run: commandRuns, worktreeName: worktrees.name })
    .from(commandRuns)
    .leftJoin(worktrees, eq(worktrees.id, commandRuns.worktreeId))
    .where(eq(commandRuns.id, runId))
    .limit(1);
  return row ?? null;
}

/** A run: live state from the runner when it answers, the stored row otherwise. */
export async function getRunDetail(runId: string): Promise<RunDetail> {
  const row = await runRow(runId);
  if (!row) throw new AppError('NOT_FOUND', 'Lancement introuvable.');
  const view = toRunView({ ...row.run, worktreeName: row.worktreeName });
  try {
    const live = await runner.getRun({ params: { runId } }, { timeoutMs: 5_000 });
    return {
      run: { ...view, status: live.status, exitCode: live.exitCode, port: live.port, summary: live.summary, finishedAt: live.finishedAt },
      live: live.live,
      outputTail: row.run.outputTail,
      tests: live.tests,
      projectId: row.run.projectId,
    };
  } catch (error) {
    if (!(isRunnerUnavailable(error) || (error instanceof RunnerError && error.code === 'NOT_FOUND'))) throw error;
    const report = row.run.details?.report ?? null;
    return { run: view, live: false, outputTail: row.run.outputTail, tests: report, projectId: row.run.projectId };
  }
}

/** « Arrêter » (D04 Lancement, Workspace Tests). Idempotent on an already finished run. */
export async function stopRun(runId: string, actor: Actor): Promise<RunDto | null> {
  const row = await runRow(runId);
  if (!row) throw new AppError('NOT_FOUND', 'Lancement introuvable.');
  if (row.run.status !== 'running') return null;
  const project = await requireProjectRow(row.run.projectId);
  const run = await runner.stopRun({ params: { runId } });
  await audit({
    action: 'project.run_stopped',
    summary: `${KIND_LABEL[row.run.kind]} arrêté dans ${project.name} : ${row.run.command}`,
    targetType: 'run',
    targetId: runId,
    metadata: { projectId: project.id, kind: row.run.kind },
    actorUserId: actor.id,
  });
  return run;
}

export const listRunsQuerySchema = z.object({
  projectId: z.uuid(),
  worktreeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/** Recent runs of a project or of one of its worktrees (Workspace « Tests », project tabs). */
export async function listRuns(input: z.input<typeof listRunsQuerySchema>): Promise<RunView[]> {
  const parsed = listRunsQuerySchema.parse(input);
  await requireProjectRow(parsed.projectId);
  return listRunRows(parsed.projectId, {
    ...(parsed.worktreeId ? { worktreeId: parsed.worktreeId } : {}),
    limit: parsed.limit ?? 30,
  });
}
