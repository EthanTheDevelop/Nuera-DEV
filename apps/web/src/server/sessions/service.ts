import 'server-only';
import { projects, sessions } from '@nuera/db/schema';
import type { SessionDto, SessionLaunchOptions } from '@nuera/shared/runner';
import { and, eq, notInArray } from 'drizzle-orm';
import {
  LIVE_STATUSES,
  createSessionInputSchema,
  renameSessionInputSchema,
  workspaceUrl,
  type CreateSessionInput,
  type CreateSessionResult,
  type SessionListItem,
} from '@/features/sessions/lib/contract';
import { db } from '@/server/db';
import { AppError, formatZodIssues } from '@/server/errors';
import { buildSessionMcpConfig } from '@/server/mcp';
import { RunnerError, isRunnerUnavailable, runner } from '@/server/runner/client';
import { audit } from '@/server/security/audit';
import { getAppSettings } from '@/server/settings';
import { buildSessionEnv, readProjectEnv } from './env';
import { capacityMessage, getSessionItem } from './queries';

/**
 * Write side of the sessions lot. Every disk / git / process effect goes through the runner; the
 * web writes only what the architecture gives it (title, archiving) and audits each action.
 *
 *   const { sessionId, workspaceUrl } = await createSession(input, user);
 *   await resumeSession(id, user);  await stopSession(id, user);
 *   await archiveSession(id, user); await renameSession(id, 'Export CSV', user);
 */

export interface SessionActor {
  id: string;
}

export const SESSION_AUDIT_ACTIONS = {
  create: 'session.create',
  resume: 'session.resume',
  stop: 'session.stop',
  archive: 'session.archive',
  rename: 'session.rename',
} as const;

const PERMISSION_LABELS: Record<string, string> = {
  manual: "demander avant d'agir",
  acceptEdits: 'accepter les modifications',
  plan: 'planifier sans modifier',
  auto: 'automatique',
  dontAsk: 'refuser sans demander',
  bypassPermissions: 'sans autorisation',
};

interface ProjectRow {
  id: string;
  name: string;
  status: string;
  archivedAt: Date | null;
  defaultBranch: string;
}

async function readProject(projectId: string): Promise<ProjectRow> {
  const [project] = await db
    .select({ id: projects.id, name: projects.name, status: projects.status, archivedAt: projects.archivedAt, defaultBranch: projects.defaultBranch })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project || project.archivedAt) throw new AppError('NOT_FOUND', 'Projet introuvable.');
  return project;
}

async function readSessionRow(sessionId: string) {
  const [row] = await db
    .select({ id: sessions.id, title: sessions.title, status: sessions.status, projectId: sessions.projectId, archivedAt: sessions.archivedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', 'Session introuvable.');
  return row;
}

/**
 * Launch options rebuilt at every start / resume: MCP servers of the project (with their deny
 * rules), the project's variables (decrypted, protected names left out) and the Paramètres limits.
 */
export async function buildLaunchOptions(projectId: string): Promise<SessionLaunchOptions> {
  const settings = await getAppSettings();
  const mcp = await buildSessionMcpConfig(projectId);
  const projectEnv = await readProjectEnv(projectId);
  const { env } = buildSessionEnv(projectEnv.env, mcp.env);
  return {
    mcpConfig: Object.keys(mcp.mcpConfig.mcpServers).length > 0 ? mcp.mcpConfig : null,
    denyRules: mcp.denyRules,
    env,
    permissionWaitSeconds: settings.permissionWaitSeconds,
    maxConcurrentSessions: settings.maxConcurrentSessions,
    memoryLimitMb: settings.sessionMemoryLimitMb,
  };
}

type RunnerWorktreeSpec = { mode: 'new'; branch: string; base?: string } | { mode: 'existing'; worktreeId: string } | { mode: 'primary' };

/** Turns the dialog's branch choice into the runner's worktree spec, checking it against git. */
async function resolveWorktree(project: ProjectRow, branch: ReturnType<typeof createSessionInputSchema.parse>['branch']): Promise<RunnerWorktreeSpec> {
  if (branch.mode === 'primary') return { mode: 'primary' };
  const { branches } = await runner.listBranches({ params: { projectId: project.id }, query: {} }, { timeoutMs: 20_000 });
  const matches = branches.filter((b) => b.name === branch.branch);
  if (branch.mode === 'new') {
    if (matches.length > 0) {
      throw new AppError('CONFLICT', `La branche ${branch.branch} existe déjà : choisissez « Branche existante » ou un autre nom.`, {
        untouched: 'Aucun worktree créé, aucune session démarrée.',
      });
    }
    const base = branch.base ?? project.defaultBranch;
    if (!branches.some((b) => b.name === base)) {
      throw new AppError('VALIDATION', `Branche de départ introuvable : ${base}.`, { untouched: 'Aucun worktree créé, aucune session démarrée.' });
    }
    return { mode: 'new', branch: branch.branch, base };
  }
  if (matches.length === 0) {
    throw new AppError('NOT_FOUND', `Branche introuvable : ${branch.branch}.`, { untouched: 'Aucun worktree créé, aucune session démarrée.' });
  }
  const withWorktree = matches.find((b) => b.worktreeId);
  if (withWorktree?.sessionId) {
    throw new AppError('CONFLICT', `Une session tourne déjà sur ${branch.branch} : ouvrez-la ou choisissez une autre branche.`, {
      untouched: 'Aucun worktree créé, aucune session démarrée.',
    });
  }
  if (withWorktree?.worktreeId) return { mode: 'existing', worktreeId: withWorktree.worktreeId };
  if (matches.some((b) => b.kind === 'local' && b.current)) return { mode: 'primary' };
  return { mode: 'new', branch: branch.branch };
}

/**
 * « Nouvelle session »: checks capacity and the permission mode, creates the worktree and the
 * session through the runner (the CLI starts at the first instruction, Figma W1), then types the
 * optional first instruction. Audited `session.create`.
 */
export async function createSession(input: CreateSessionInput, actor: SessionActor): Promise<CreateSessionResult> {
  const parsed = createSessionInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION', 'Session invalide.', { detail: formatZodIssues(parsed.error) });
  const data = parsed.data;
  const settings = await getAppSettings();
  const project = await readProject(data.projectId);
  if (project.status !== 'ready') {
    throw new AppError('CONFLICT', project.status === 'cloning' ? 'Le projet est encore en cours de clonage.' : "Le projet n'est pas prêt.", {
      untouched: 'Aucun worktree créé, aucune session démarrée.',
    });
  }
  const permissionMode = data.permissionMode ?? settings.defaultPermissionMode;
  if (permissionMode === 'bypassPermissions' && settings.blockBypassPermissions) {
    throw new AppError('FORBIDDEN', 'Le mode sans autorisation est bloqué dans les paramètres.', {
      untouched: 'Aucun worktree créé, aucune session démarrée.',
    });
  }

  const live = await runner.listSessions(undefined, { timeoutMs: 8_000 });
  const capacity = { active: live.capacity.live, max: settings.maxConcurrentSessions };
  if (capacity.active >= capacity.max) {
    throw new RunnerError('CONFLICT', capacityMessage(capacity), {
      reason: 'CAPACITY_REACHED',
      data: capacity,
      untouched: 'Aucun worktree créé, aucune session démarrée.',
    });
  }

  const worktree = await resolveWorktree(project, data.branch);
  const launch = await buildLaunchOptions(project.id);
  const dto = await runner.createSession({
    body: {
      projectId: project.id,
      title: data.title,
      worktree,
      permissionMode,
      model: data.model === undefined ? settings.defaultModel : data.model,
      effort: data.effort === undefined ? settings.defaultEffort : data.effort,
      remoteControl: data.remoteControl ?? settings.remoteControlByDefault,
      launch,
      start: false,
      createdByUserId: actor.id,
    },
  });

  await audit({
    action: SESSION_AUDIT_ACTIONS.create,
    summary: `session créée : « ${dto.title} » · ${project.name} · ${dto.worktree?.branch ?? 'branche inconnue'}`,
    targetType: 'session',
    targetId: dto.id,
    actorUserId: actor.id,
    metadata: {
      projectId: project.id,
      worktree: dto.worktree ? { name: dto.worktree.name, branch: dto.worktree.branch, primary: dto.worktree.isPrimary } : null,
      mode: data.branch.mode,
      permissionMode,
      permissionLabel: PERMISSION_LABELS[permissionMode],
      model: dto.model,
      effort: dto.effort,
      remoteControl: dto.remoteControl,
      withInstruction: Boolean(data.instruction),
    },
  });

  const result: CreateSessionResult = { sessionId: dto.id, workspaceUrl: workspaceUrl(dto.id), instruction: 'none', instructionError: null };
  if (data.instruction) {
    try {
      const sent = await runner.sendInstruction({ params: { sessionId: dto.id }, body: { text: data.instruction } });
      result.instruction = sent.delivered ? 'delivered' : 'queued';
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      result.instruction = 'failed';
      result.instructionError = {
        message: appError?.message ?? "L'instruction n'a pas pu être transmise.",
        ...(appError?.detail ? { detail: appError.detail } : {}),
      };
    }
  }
  return result;
}

/** Sends (again) the first instruction of a session just created, when it failed. */
export async function sendFirstInstruction(sessionId: string, text: string): Promise<'delivered' | 'queued'> {
  await readSessionRow(sessionId);
  const sent = await runner.sendInstruction({ params: { sessionId }, body: { text } });
  return sent.delivered ? 'delivered' : 'queued';
}

export interface SessionActionResult {
  session: SessionListItem;
  workspaceUrl: string;
}

/**
 * « Reprendre »: `claude --resume <id>` in the session's worktree with launch options rebuilt
 * (MCP, variables, limits as they are now). Capacity and resumability are checked by the runner
 * (CAPACITY_REACHED, SESSION_NOT_RESUMABLE). Audited `session.resume`.
 */
export async function resumeSession(sessionId: string, actor: SessionActor): Promise<SessionActionResult> {
  const row = await readSessionRow(sessionId);
  if (row.status === 'archived') {
    throw new AppError('CONFLICT', 'Session archivée : elle ne peut plus être reprise.', { untouched: "L'historique reste lisible." });
  }
  const project = await readProject(row.projectId);
  const current = await runner.getSession({ params: { sessionId } });
  if (current.live) return { session: await getSessionItem(sessionId), workspaceUrl: workspaceUrl(sessionId) };
  const launch = await buildLaunchOptions(project.id);
  const dto: SessionDto = await runner.resumeSession({ params: { sessionId }, body: { launch } });
  await audit({
    action: SESSION_AUDIT_ACTIONS.resume,
    summary: `session reprise : « ${dto.title} » · ${project.name}`,
    targetType: 'session',
    targetId: sessionId,
    actorUserId: actor.id,
    metadata: { projectId: project.id, previousStatus: row.status, resumeCount: dto.resumeCount },
  });
  return { session: await getSessionItem(sessionId), workspaceUrl: workspaceUrl(sessionId) };
}

/**
 * « Arrêter la session » (T8): Échap, `/exit`, then the process is stopped by the runner. 409
 * when nothing runs. The worktree and the conversation are kept. Audited `session.stop`.
 */
export async function stopSession(sessionId: string, actor: SessionActor, options: { force?: boolean } = {}): Promise<SessionActionResult> {
  const row = await readSessionRow(sessionId);
  const current = await runner.getSession({ params: { sessionId } });
  if (!current.live && !(LIVE_STATUSES as readonly string[]).includes(current.status)) {
    throw new AppError('CONFLICT', 'Aucun processus Claude Code ne tourne pour cette session.', { untouched: "Rien n'a été arrêté." });
  }
  const dto = await runner.stopSession({ params: { sessionId }, body: { force: options.force ?? false } });
  await audit({
    action: SESSION_AUDIT_ACTIONS.stop,
    summary: `session arrêtée : « ${dto.title} »`,
    targetType: 'session',
    targetId: sessionId,
    actorUserId: actor.id,
    metadata: { projectId: row.projectId, previousStatus: current.status, force: options.force ?? false },
  });
  return { session: await getSessionItem(sessionId), workspaceUrl: workspaceUrl(sessionId) };
}

/**
 * « Archiver »: the session leaves « EN COURS » and the default history views; its worktree and
 * its conversation are not touched. Refused while a CLI runs (stop it first). Audited.
 */
export async function archiveSession(sessionId: string, actor: SessionActor): Promise<SessionActionResult> {
  const row = await readSessionRow(sessionId);
  if (row.status === 'archived') return { session: await getSessionItem(sessionId), workspaceUrl: workspaceUrl(sessionId) };
  let live = (LIVE_STATUSES as readonly string[]).includes(row.status);
  try {
    const dto = await runner.getSession({ params: { sessionId } }, { timeoutMs: 5_000 });
    live = dto.live || (LIVE_STATUSES as readonly string[]).includes(dto.status);
  } catch (error) {
    // Runner unreachable: the database status decides (a live status is refused, it cannot be verified).
    if (!isRunnerUnavailable(error) && !(error instanceof AppError && error.code === 'NOT_FOUND')) throw error;
  }
  if (live) {
    throw new AppError('CONFLICT', "La session tourne encore : arrêtez-la avant de l'archiver.", { untouched: 'Session non archivée.' });
  }
  const [updated] = await db
    .update(sessions)
    .set({ status: 'archived', archivedAt: new Date() })
    .where(and(eq(sessions.id, sessionId), notInArray(sessions.status, [...LIVE_STATUSES, 'archived'])))
    .returning({ id: sessions.id });
  if (!updated) {
    throw new AppError('CONFLICT', "La session a changé d'état entre-temps : rechargez la page.", { untouched: 'Session non archivée.' });
  }
  await audit({
    action: SESSION_AUDIT_ACTIONS.archive,
    summary: `session archivée : « ${row.title} »`,
    targetType: 'session',
    targetId: sessionId,
    actorUserId: actor.id,
    metadata: { projectId: row.projectId, previousStatus: row.status },
  });
  return { session: await getSessionItem(sessionId), workspaceUrl: workspaceUrl(sessionId) };
}

/** « Renommer »: Nuera's title of the session (the CLI keeps its `--name` until the next launch). */
export async function renameSession(sessionId: string, title: string, actor: SessionActor): Promise<SessionActionResult> {
  const parsed = renameSessionInputSchema.safeParse({ title });
  if (!parsed.success) throw new AppError('VALIDATION', 'Titre invalide.', { detail: formatZodIssues(parsed.error) });
  const row = await readSessionRow(sessionId);
  const next = parsed.data.title;
  if (next !== row.title) {
    await db.update(sessions).set({ title: next }).where(eq(sessions.id, sessionId));
    await audit({
      action: SESSION_AUDIT_ACTIONS.rename,
      summary: `session renommée : « ${row.title} » → « ${next} »`,
      targetType: 'session',
      targetId: sessionId,
      actorUserId: actor.id,
      metadata: { projectId: row.projectId, from: row.title, to: next },
    });
  }
  return { session: await getSessionItem(sessionId), workspaceUrl: workspaceUrl(sessionId) };
}
