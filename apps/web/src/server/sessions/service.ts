import 'server-only';
import { projects, sessions } from '@nuera/db/schema';
import { parseUsageLimit, type AutoResumeOptions, type SessionDto, type SessionLaunchOptions } from '@nuera/shared/runner';
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
import { launchCommonParts, recordSessionConfig, type SessionConfigSnapshot } from '@/server/claude-config';
import { buildSessionMcpConfig } from '@/server/mcp';
import { RunnerError, isRunnerUnavailable } from '@/server/runner/client';
import { getEffectiveSessionPolicy, type EffectiveSessionPolicy } from '@/server/settings';
import type { RequestContext } from '@/server/tenancy/context';
import { auditIn, NOT_FOUND_MESSAGES, scopeOfSession, type ProjectScope, type SessionScope } from '@/server/tenancy/scope';
import { assertCanDriveSession, readScopedProject, type ProjectRow } from './access';
import { buildSessionEnv, readProjectEnv } from './env';
import { getGitIdentity } from './git-identity';
import { capacityMessage, environmentMaxSessions, readSessionItem } from './queries';

/**
 * Write side of the sessions lot. Every disk / git / process effect goes through the runner of
 * the server HOLDING the project (`projects.environment_id`); the web writes only what the
 * architecture gives it (title, archiving) and audits each action in the space.
 *
 *   const { sessionId, workspaceUrl } = await createSession(ctx, input);
 *   await resumeSession(ctx, id);  await stopSession(ctx, id);
 *   await archiveSession(ctx, id); await renameSession(ctx, id, 'Export CSV');
 *
 * An id of another space answers exactly like an unknown id (`scopeOf*()`): same NOT_FOUND, no
 * runner call, nothing written, nothing journaled.
 */

/** Who acts and where: the request context (account, its space, its server). */
export type SessionActorContext = Pick<RequestContext, 'user' | 'space' | 'environment'>;

export const SESSION_AUDIT_ACTIONS = {
  create: 'session.create',
  resume: 'session.resume',
  stop: 'session.stop',
  archive: 'session.archive',
  rename: 'session.rename',
  autoResumeChanged: 'session.auto_resume_changed',
  resumeNow: 'session.auto_resume_now',
} as const;

const PERMISSION_LABELS: Record<string, string> = {
  manual: "demander avant d'agir",
  acceptEdits: 'accepter les modifications',
  plan: 'planifier sans modifier',
  auto: 'automatique',
  dontAsk: 'refuser sans demander',
  bypassPermissions: 'sans autorisation',
};

const SESSION_NOT_FOUND = NOT_FOUND_MESSAGES.session;

/** Session of the space (scope + the columns the actions need). */
async function readScopedSession(ctx: SessionActorContext, sessionId: string) {
  const scope = await scopeOfSession(ctx, sessionId);
  assertCanDriveSession(ctx, scope);
  const [row] = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      status: sessions.status,
      projectId: sessions.projectId,
      archivedAt: sessions.archivedAt,
      autoResume: sessions.autoResume,
      usageLimit: sessions.usageLimit,
      projectName: projects.name,
    })
    .from(sessions)
    .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.spaceId, scope.spaceId)))
    .where(and(eq(sessions.id, scope.sessionId), eq(sessions.environmentId, scope.environmentId)))
    .limit(1);
  if (!row) throw new AppError('NOT_FOUND', SESSION_NOT_FOUND);
  return { scope, row };
}

/**
 * Launch options rebuilt at every start / resume, for the account that starts or resumes: MCP
 * servers of the project (with their deny rules), the project's variables (decrypted, protected
 * names left out), the effective policy of the space (permission wait, bypass block = instance OR
 * space) and the Git identity of the account.
 *
 * No capacity or memory limit is sent: the runner reads them from its own server row
 * (`environments`). A launch value would only be kept in `launch.json` as a stricter cap that a
 * later raise of the server's limits could not lift.
 */
export async function buildLaunchOptions(
  ctx: Pick<RequestContext, 'user'>,
  scope: Pick<ProjectScope, 'projectId' | 'spaceId'>,
  /** « Reprise automatique » chosen for the session (`sessions.auto_resume`); null/absent = the space default. */
  session: { autoResume?: boolean | null } = {},
): Promise<SessionLaunchOptions> {
  return (await buildLaunchPlan(ctx, scope, session)).launch;
}

export interface LaunchPlan {
  launch: SessionLaunchOptions;
  /** What the session receives from the common configuration (recorded once the runner accepted it). */
  common: SessionConfigSnapshot;
  /** Model imposed by the instance (« Imposé »), or null. */
  lockedModel: string | null;
  /** Default model of new sessions: the space's, else the instance's. */
  defaultModel: string | null;
}

/**
 * Launch options + the common configuration (lot K1): instance MCP servers merged with the project's,
 * permission rules of the instance policy and of the instance servers (deny > ask > allow in the CLI),
 * « Par défaut » variables BEFORE the project's (which win), « Imposé » ones in the session settings,
 * bypass block forced when an instance server can act on production (Coolify), and the hash of the
 * rules and skills the runner must hold before starting the CLI.
 */
export async function buildLaunchPlan(
  ctx: Pick<RequestContext, 'user'>,
  scope: Pick<ProjectScope, 'projectId' | 'spaceId'>,
  session: { autoResume?: boolean | null } = {},
): Promise<LaunchPlan> {
  const common = await launchCommonParts(scope.spaceId);
  const [policy, mcp, projectEnv, gitIdentity] = await Promise.all([
    getEffectiveSessionPolicy(scope.spaceId),
    buildSessionMcpConfig(scope.projectId, common.mcp),
    readProjectEnv(scope),
    getGitIdentity(ctx.user),
  ]);
  const { env } = buildSessionEnv(common.env.defaults, projectEnv.env, mcp.env);
  const { env: settingsEnv } = buildSessionEnv(common.env.locked);
  const unique = (...lists: string[][]) => [...new Set(lists.flat())];
  const launch: SessionLaunchOptions = {
    mcpConfig: Object.keys(mcp.mcpConfig.mcpServers).length > 0 ? mcp.mcpConfig : null,
    denyRules: unique(mcp.denyRules, common.rules.deny),
    allowRules: unique(common.rules.allow, mcp.allowRules ?? []),
    askRules: unique(common.rules.ask, mcp.askRules ?? []),
    settingsEnv,
    env,
    permissionWaitSeconds: policy.permissionWaitSeconds,
    blockBypassPermissions: policy.blockBypassPermissions || mcp.blockBypass === true,
    gitIdentity,
    autoResume: autoResumeOptions(policy, session.autoResume),
    commonConfig: { hash: common.hash, revision: common.revision },
  };
  return {
    launch,
    common: { ...common.snapshot, skipped: mcp.skipped ?? [] },
    lockedModel: common.model.locked ? common.model.value : null,
    defaultModel: policy.defaultModel ?? common.model.value,
  };
}

/** Effective « Reprise automatique après la limite d'utilisation » of a session, for its runner. */
function autoResumeOptions(policy: Pick<EffectiveSessionPolicy, 'autoResumeAfterLimit' | 'autoResumeInstruction'>, override: boolean | null | undefined): AutoResumeOptions {
  return { enabled: override ?? policy.autoResumeAfterLimit, instruction: policy.autoResumeInstruction };
}

type RunnerWorktreeSpec = { mode: 'new'; branch: string; base?: string } | { mode: 'existing'; worktreeId: string } | { mode: 'primary' };

/** Turns the dialog's branch choice into the runner's worktree spec, checking it against git. */
async function resolveWorktree(
  scope: ProjectScope,
  project: ProjectRow,
  branch: ReturnType<typeof createSessionInputSchema.parse>['branch'],
): Promise<RunnerWorktreeSpec> {
  if (branch.mode === 'primary') return { mode: 'primary' };
  const { branches } = await scope.runner.listBranches({ params: { projectId: project.id }, query: {} }, { timeoutMs: 20_000 });
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
 * « Nouvelle session »: on the server of the project, checks capacity and the permission mode,
 * creates the worktree and the session through its runner (the CLI starts at the first
 * instruction, Figma W1), then types the optional first instruction. Audited `session.create`.
 */
export async function createSession(ctx: SessionActorContext, input: CreateSessionInput): Promise<CreateSessionResult> {
  const parsed = createSessionInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION', 'Session invalide.', { detail: formatZodIssues(parsed.error) });
  const data = parsed.data;
  const { scope, project } = await readScopedProject(ctx, data.projectId);
  assertCanDriveSession(ctx, scope);
  if (project.status !== 'ready') {
    throw new AppError('CONFLICT', project.status === 'cloning' ? 'Le projet est encore en cours de clonage.' : "Le projet n'est pas prêt.", {
      untouched: 'Aucun worktree créé, aucune session démarrée.',
    });
  }
  const policy = await getEffectiveSessionPolicy(scope.spaceId);
  const permissionMode = data.permissionMode ?? policy.defaultPermissionMode;
  if (permissionMode === 'bypassPermissions' && policy.blockBypassPermissions) {
    throw new AppError('FORBIDDEN', 'Le mode sans autorisation est bloqué dans les paramètres.', {
      untouched: 'Aucun worktree créé, aucune session démarrée.',
    });
  }

  const live = await scope.runner.listSessions(undefined, { timeoutMs: 8_000 });
  const capacity = { active: live.capacity.live, max: await environmentMaxSessions(scope.environmentId, live.capacity.max) };
  if (capacity.active >= capacity.max) {
    throw new RunnerError('CONFLICT', capacityMessage(capacity), {
      reason: 'CAPACITY_REACHED',
      data: capacity,
      untouched: 'Aucun worktree créé, aucune session démarrée.',
      environmentId: scope.environmentId,
    });
  }

  const worktree = await resolveWorktree(scope, project, data.branch);
  const plan = await buildLaunchPlan(ctx, scope);
  const launch = plan.launch;
  if (permissionMode === 'bypassPermissions' && launch.blockBypassPermissions) {
    throw new AppError('FORBIDDEN', 'Le mode sans autorisation est bloqué pour les sessions qui reçoivent Coolify (administrateurs).', {
      untouched: 'Aucun worktree créé, aucune session démarrée.',
    });
  }
  const dto = await scope.runner.createSession({
    body: {
      projectId: project.id,
      title: data.title,
      worktree,
      permissionMode,
      // « Imposé » by the instance wins over the dialog; otherwise the dialog, the space, the instance.
      model: plan.lockedModel ?? (data.model === undefined ? plan.defaultModel : data.model),
      effort: data.effort === undefined ? policy.defaultEffort : data.effort,
      remoteControl: data.remoteControl ?? policy.remoteControlByDefault,
      launch,
      start: false,
      createdByUserId: ctx.user.id,
    },
  });

  await recordSessionConfig(dto.id, scope.spaceId, plan.common);
  await auditIn(ctx, {
    action: SESSION_AUDIT_ACTIONS.create,
    summary: `session créée : « ${dto.title} » · ${project.name} · ${dto.worktree?.branch ?? 'branche inconnue'}`,
    targetType: 'session',
    targetId: dto.id,
    environmentId: scope.environmentId,
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
      const sent = await scope.runner.sendInstruction({ params: { sessionId: dto.id }, body: { text: data.instruction } });
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

/** Sends (again) the first instruction of a session of the space just created, when it failed. */
export async function sendFirstInstruction(ctx: SessionActorContext, sessionId: string, text: string): Promise<'delivered' | 'queued'> {
  const { scope } = await readScopedSession(ctx, sessionId);
  const sent = await scope.runner.sendInstruction({ params: { sessionId: scope.sessionId }, body: { text } });
  return sent.delivered ? 'delivered' : 'queued';
}

/**
 * First start of a session of the space that has not run yet (status `new`, e.g. the composer's
 * first instruction): the runner starts its CLI with launch options rebuilt for the account that
 * starts it, the effective policy of the space included. A session created before the launch
 * options carried the bypass block has a `launch.json` without it, and the runner, which then
 * fails closed, would refuse a « sans autorisation » session that the space allows
 * (BYPASS_BLOCKED). Starting a session that is already starting joins that run (runner).
 */
export async function startNewSession(ctx: SessionActorContext, sessionId: string): Promise<SessionDto> {
  const { scope, row } = await readScopedSession(ctx, sessionId);
  if (row.status === 'archived' || row.archivedAt) {
    throw new AppError('CONFLICT', 'Session archivée : elle ne peut plus démarrer.', { untouched: "L'historique reste lisible." });
  }
  if (scope.projectArchivedAt) throw new AppError('NOT_FOUND', 'Projet introuvable.');
  const plan = await buildLaunchPlan(ctx, scope, row);
  const dto = await scope.runner.startSession({ params: { sessionId: scope.sessionId }, body: { launch: plan.launch } });
  await recordSessionConfig(scope.sessionId, scope.spaceId, plan.common);
  return dto;
}

export interface SessionActionResult {
  session: SessionListItem;
  workspaceUrl: string;
}

function actionResult(ctx: SessionActorContext, scope: SessionScope): Promise<SessionActionResult> {
  return readSessionItem(ctx, scope.sessionId, scope.runner).then((session) => ({ session, workspaceUrl: workspaceUrl(scope.sessionId) }));
}

/**
 * « Reprendre »: `claude --resume <id>` in the session's worktree, on its server, with launch
 * options rebuilt for the account that resumes (MCP, variables, policy, limits, Git identity as
 * they are now). Capacity and resumability are checked by the runner (CAPACITY_REACHED,
 * SESSION_NOT_RESUMABLE). Audited `session.resume`.
 */
export async function resumeSession(ctx: SessionActorContext, sessionId: string): Promise<SessionActionResult> {
  const { scope, row } = await readScopedSession(ctx, sessionId);
  if (row.status === 'archived') {
    throw new AppError('CONFLICT', 'Session archivée : elle ne peut plus être reprise.', { untouched: "L'historique reste lisible." });
  }
  if (scope.projectArchivedAt) throw new AppError('NOT_FOUND', 'Projet introuvable.');
  const current = await scope.runner.getSession({ params: { sessionId: scope.sessionId } });
  if (current.live) return actionResult(ctx, scope);
  const plan = await buildLaunchPlan(ctx, scope, row);
  const dto: SessionDto = await scope.runner.resumeSession({ params: { sessionId: scope.sessionId }, body: { launch: plan.launch } });
  await recordSessionConfig(scope.sessionId, scope.spaceId, plan.common);
  await auditIn(ctx, {
    action: SESSION_AUDIT_ACTIONS.resume,
    summary: `session reprise : « ${dto.title} » · ${row.projectName}`,
    targetType: 'session',
    targetId: scope.sessionId,
    environmentId: scope.environmentId,
    metadata: { projectId: scope.projectId, previousStatus: row.status, resumeCount: dto.resumeCount },
  });
  return actionResult(ctx, scope);
}

/**
 * « Arrêter la session » (T8): Échap, `/exit`, then the process is stopped by the runner of its
 * server. 409 when nothing runs. The worktree and the conversation are kept. Audited `session.stop`.
 */
export async function stopSession(ctx: SessionActorContext, sessionId: string, options: { force?: boolean } = {}): Promise<SessionActionResult> {
  const { scope, row } = await readScopedSession(ctx, sessionId);
  const current = await scope.runner.getSession({ params: { sessionId: scope.sessionId } });
  if (!current.live && !(LIVE_STATUSES as readonly string[]).includes(current.status)) {
    throw new AppError('CONFLICT', 'Aucun processus Claude Code ne tourne pour cette session.', { untouched: "Rien n'a été arrêté." });
  }
  const dto = await scope.runner.stopSession({ params: { sessionId: scope.sessionId }, body: { force: options.force ?? false } });
  await auditIn(ctx, {
    action: SESSION_AUDIT_ACTIONS.stop,
    summary: `session arrêtée : « ${dto.title} »`,
    targetType: 'session',
    targetId: scope.sessionId,
    environmentId: scope.environmentId,
    metadata: { projectId: row.projectId, previousStatus: current.status, force: options.force ?? false },
  });
  return actionResult(ctx, scope);
}

/**
 * « Archiver »: the session leaves « EN COURS » and the default history views; its worktree and
 * its conversation are not touched. Refused while a CLI runs (stop it first). Audited.
 */
export async function archiveSession(ctx: SessionActorContext, sessionId: string): Promise<SessionActionResult> {
  const { scope, row } = await readScopedSession(ctx, sessionId);
  if (row.status === 'archived') return actionResult(ctx, scope);
  let live = (LIVE_STATUSES as readonly string[]).includes(row.status);
  try {
    const dto = await scope.runner.getSession({ params: { sessionId: scope.sessionId } }, { timeoutMs: 5_000 });
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
    // An archived session never resumes by itself: a limit in play is dropped with it.
    .set({ status: 'archived', archivedAt: new Date(), usageLimit: null })
    .where(
      and(
        eq(sessions.id, scope.sessionId),
        eq(sessions.environmentId, scope.environmentId),
        notInArray(sessions.status, [...LIVE_STATUSES, 'archived']),
      ),
    )
    .returning({ id: sessions.id });
  if (!updated) {
    throw new AppError('CONFLICT', "La session a changé d'état entre-temps : rechargez la page.", { untouched: 'Session non archivée.' });
  }
  await auditIn(ctx, {
    action: SESSION_AUDIT_ACTIONS.archive,
    summary: `session archivée : « ${row.title} »`,
    targetType: 'session',
    targetId: scope.sessionId,
    environmentId: scope.environmentId,
    metadata: { projectId: row.projectId, previousStatus: row.status },
  });
  await announceStatus(scope);
  return actionResult(ctx, scope);
}

/**
 * Other tabs follow a web-side change (archive, rename) through the runner's `session.status`.
 * Best effort: the change is already written and audited; an unreachable runner only delays them
 * until their next refresh.
 */
async function announceStatus(scope: SessionScope): Promise<void> {
  try {
    await scope.runner.announceSession({ params: { sessionId: scope.sessionId } }, { timeoutMs: 5_000 });
  } catch (error) {
    if (!isRunnerUnavailable(error) && !(error instanceof AppError && error.code === 'NOT_FOUND')) {
      console.error('[sessions] publication du statut impossible', error instanceof Error ? error.message : error);
    }
  }
}

/** « Renommer »: Nuera's title of the session (the CLI keeps its `--name` until the next launch). */
export async function renameSession(ctx: SessionActorContext, sessionId: string, title: string): Promise<SessionActionResult> {
  const parsed = renameSessionInputSchema.safeParse({ title });
  if (!parsed.success) throw new AppError('VALIDATION', 'Titre invalide.', { detail: formatZodIssues(parsed.error) });
  const { scope, row } = await readScopedSession(ctx, sessionId);
  const next = parsed.data.title;
  if (next !== row.title) {
    await db
      .update(sessions)
      .set({ title: next })
      .where(and(eq(sessions.id, scope.sessionId), eq(sessions.environmentId, scope.environmentId)));
    await auditIn(ctx, {
      action: SESSION_AUDIT_ACTIONS.rename,
      summary: `session renommée : « ${row.title} » → « ${next} »`,
      targetType: 'session',
      targetId: scope.sessionId,
      environmentId: scope.environmentId,
      metadata: { projectId: row.projectId, from: row.title, to: next },
    });
    await announceStatus(scope);
  }
  return actionResult(ctx, scope);
}

/**
 * « Reprise automatique après la limite d'utilisation » of one session (« … » menu, banner switch):
 * `true` / `false` for this session only, `null` = back to the space default. The runner of its
 * server gets the effective value first (it reschedules or cancels a limit in play); only then is
 * the choice written. Audited `session.auto_resume_changed`.
 */
export async function setSessionAutoResume(ctx: SessionActorContext, sessionId: string, enabled: boolean | null): Promise<SessionActionResult> {
  const { scope, row } = await readScopedSession(ctx, sessionId);
  if (row.status === 'archived' || row.archivedAt) {
    throw new AppError('CONFLICT', 'Session archivée : elle ne reprend plus.', { untouched: 'Réglage inchangé.' });
  }
  const policy = await getEffectiveSessionPolicy(scope.spaceId);
  const effective = autoResumeOptions(policy, enabled);
  await scope.runner.setSessionAutoResume({ params: { sessionId: scope.sessionId }, body: effective }, { timeoutMs: 10_000 });
  if (enabled !== row.autoResume) {
    await db
      .update(sessions)
      .set({ autoResume: enabled })
      .where(and(eq(sessions.id, scope.sessionId), eq(sessions.environmentId, scope.environmentId)));
  }
  const choice = enabled === null ? `défaut de l'espace (${effective.enabled ? 'activée' : 'désactivée'})` : enabled ? 'activée' : 'désactivée';
  await auditIn(ctx, {
    action: SESSION_AUDIT_ACTIONS.autoResumeChanged,
    summary: `reprise automatique après la limite : ${choice} · « ${row.title} »`,
    targetType: 'session',
    targetId: scope.sessionId,
    environmentId: scope.environmentId,
    metadata: { projectId: row.projectId, from: row.autoResume, to: enabled, effective: effective.enabled },
  });
  return actionResult(ctx, scope);
}

/**
 * « Reprendre maintenant » (usage-limit banner): the owner does not wait for the scheduled time —
 * the instruction of reprise is typed now like any instruction of the owner (a CLI gone is resumed
 * with `claude --resume` first), which cancels the schedule. The limit may still be there: the CLI
 * then says so again. Audited `session.auto_resume_now`.
 */
export async function resumeAfterLimitNow(
  ctx: SessionActorContext,
  sessionId: string,
  send: (text: string) => Promise<unknown>,
): Promise<SessionActionResult> {
  const { scope, row } = await readScopedSession(ctx, sessionId);
  if (row.status === 'archived' || row.archivedAt) {
    throw new AppError('CONFLICT', 'Session archivée : elle ne reprend plus.', { untouched: "Aucune instruction n'a été envoyée." });
  }
  const limit = parseUsageLimit(row.usageLimit);
  if (!limit?.active) {
    throw new AppError('CONFLICT', "Aucune limite d'utilisation n'arrête cette session.", { untouched: "Aucune instruction n'a été envoyée." });
  }
  const policy = await getEffectiveSessionPolicy(scope.spaceId);
  await send(policy.autoResumeInstruction);
  await auditIn(ctx, {
    action: SESSION_AUDIT_ACTIONS.resumeNow,
    summary: `session reprise après la limite d'utilisation (sans attendre) : « ${row.title} »`,
    targetType: 'session',
    targetId: scope.sessionId,
    environmentId: scope.environmentId,
    metadata: { projectId: row.projectId, resetsAt: limit.resetsAt, scheduledAt: limit.autoResume?.nextAttemptAt ?? null },
  });
  return actionResult(ctx, scope);
}
