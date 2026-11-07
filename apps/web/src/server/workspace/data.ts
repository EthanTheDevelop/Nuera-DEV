import 'server-only';
import { sessionConfigView } from '@/server/claude-config';
import { permissionRequests, pullRequests, sessions, worktrees } from '@nuera/db/schema';
import { CliStatusSchema, parseUsageLimit, type PermissionRequestDto, type SessionDto, type SessionEventItem } from '@nuera/shared/runner';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type {
  SiblingSession,
  WorkspaceBranchStatus,
  WorkspaceData,
  WorkspaceEventsPage,
  WorkspacePullRequest,
  WorkspaceSession,
} from '@/features/workspace/lib/contract';
import { db } from '@/server/db';
import { previewSettingsView } from '@/server/preview/handoff';
import { isRunnerUnavailable, type RunnerClient } from '@/server/runner/client';
import { environmentMaxSessions, getGitIdentity } from '@/server/sessions';
import { getEffectiveSessionPolicy } from '@/server/settings';
import type { RequestContext } from '@/server/tenancy/context';
import { findSessionContext, githubHtmlUrl, repoName, requireSessionContext, type SessionContext } from './access';

/**
 * Initial data of `/workspace/[sessionId]` (D05, W1–W7, M05, S1–S4). The database gives what the
 * web owns (titles, project, sibling sessions, pull requests); the runner gives the live view
 * (process, pending permission, conversation, git). Any runner part that fails is null: the page
 * renders a sober inline state for it, never a crash (T5 is handled by the shell). Every read is
 * scoped to the space of ctx and goes to the runner of the server holding the session.
 */

const EVENTS_PAGE = 2000;
/** Upper bound of events read for the first paint (long sessions keep loading on the client). */
const MAX_INITIAL_EVENTS = 6000;

/** Sessions shown in the switcher: every non-archived session that is not over, plus the current one. */
const SWITCHER_STATUSES = ['new', 'running', 'waiting_permission', 'waiting_input'] as const;

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function parseCliStatus(value: unknown): WorkspaceSession['cliStatus'] {
  const parsed = CliStatusSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function toWorkspaceSession(row: SessionContext['session'], dto: SessionDto | null, autoResumeDefault: boolean): WorkspaceSession {
  return {
    id: row.id,
    title: row.title,
    status: dto?.status ?? row.status,
    live: dto ? dto.live : null,
    resumable: dto ? dto.resumable : false,
    resumeMode: dto?.resumeMode ?? null,
    backend: dto?.backend ?? row.backend,
    tmuxName: dto?.tmuxName ?? row.tmuxName,
    permissionMode: dto?.permissionMode ?? row.permissionMode,
    model: dto?.model ?? row.model,
    effort: dto ? dto.effort : row.effort,
    cliStatus: dto?.cliStatus ?? parseCliStatus(row.cliStatus),
    queuedInstructions: dto?.queuedInstructions ?? 0,
    currentActivity: dto?.currentActivity ?? row.currentActivity,
    errorCode: dto?.errorCode ?? row.errorCode,
    errorMessage: dto?.errorMessage ?? row.errorMessage,
    startedAt: dto?.startedAt ?? iso(row.startedAt),
    endedAt: dto?.endedAt ?? iso(row.endedAt),
    lastActivityAt: dto?.lastActivityAt ?? iso(row.lastActivityAt),
    createdAt: row.createdAt.toISOString(),
    limit: dto && dto.limit !== undefined ? dto.limit : parseUsageLimit(row.usageLimit),
    autoResume: { override: row.autoResume, spaceDefault: autoResumeDefault },
  };
}

/** Every event after `afterVersion`, page by page (bounded), from the session's server. */
async function readSessionEvents(runner: RunnerClient, sessionId: string, afterVersion = 0, max = MAX_INITIAL_EVENTS): Promise<WorkspaceEventsPage> {
  const items: SessionEventItem[] = [];
  let version = afterVersion;
  let complete = false;
  while (items.length < max) {
    const page = await runner.sessionEvents({ params: { sessionId }, query: { afterVersion: version, limit: EVENTS_PAGE } });
    items.push(...page.items);
    version = Math.max(version, page.version);
    if (!page.hasMore || page.items.length === 0) {
      complete = true;
      break;
    }
  }
  return { items, version, complete };
}

/** `GET /api/sessions/[id]/events?afterVersion=` (reload after `stream.reset`, catch-up after W7). */
export async function getSessionEventsPage(ctx: Pick<RequestContext, 'space'>, sessionId: string, afterVersion: number): Promise<WorkspaceEventsPage> {
  const { scope } = await requireSessionContext(ctx, sessionId);
  return readSessionEvents(scope.runner, scope.sessionId, afterVersion);
}

/** Ahead / behind of a worktree (already scoped: `runner` is the client of its server). */
export async function readBranchStatus(runner: RunnerClient, worktreeId: string, base: string): Promise<WorkspaceBranchStatus> {
  const ab = await runner.aheadBehind({ params: { worktreeId }, query: { base } }, { timeoutMs: 10_000 });
  return { branch: ab.branch, base: ab.base, ahead: ab.ahead, behind: ab.behind, upstream: ab.upstream, dirtyFiles: ab.dirtyFiles };
}

async function readSiblings(context: SessionContext): Promise<SiblingSession[]> {
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      status: sessions.status,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      createdAt: sessions.createdAt,
      branch: worktrees.branch,
      worktreeName: worktrees.name,
    })
    .from(sessions)
    .leftJoin(worktrees, eq(worktrees.id, sessions.worktreeId))
    .where(
      and(
        eq(sessions.projectId, context.project.id),
        isNull(sessions.archivedAt),
        or(inArray(sessions.status, [...SWITCHER_STATUSES]), eq(sessions.id, context.session.id)),
      ),
    )
    .orderBy(desc(sessions.createdAt))
    .limit(20);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    branch: row.branch,
    worktreeName: row.worktreeName,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    current: row.id === context.session.id,
  }));
}

async function readLatestPullRequest(projectId: string, headBranch: string | null): Promise<WorkspacePullRequest | null> {
  if (!headBranch) return null;
  const [row] = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.projectId, projectId), eq(pullRequests.headBranch, headBranch)))
    .orderBy(desc(pullRequests.createdAt))
    .limit(1);
  if (!row) return null;
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    state: row.state,
    draft: row.draft,
    baseBranch: row.baseBranch,
    headBranch: row.headBranch,
  };
}

async function countAllowed(sessionId: string): Promise<number> {
  const rows = await db
    .select({ id: permissionRequests.id })
    .from(permissionRequests)
    .where(and(eq(permissionRequests.sessionId, sessionId), inArray(permissionRequests.status, ['allowed', 'allowed_always'])));
  return rows.length;
}

/** Live sessions of ONE server (archived ones excluded). */
async function liveCount(environmentId: string): Promise<number> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.environmentId, environmentId),
        inArray(sessions.status, ['running', 'waiting_permission', 'waiting_input']),
        isNull(sessions.archivedAt),
      ),
    );
  return rows.length;
}

/**
 * Everything the Workspace needs for its first paint. Returns null for an unknown session, a
 * session of another space, an archived session or a session of an archived project (the page
 * answers 404, the same for all of them).
 */
export async function getWorkspaceData(ctx: Pick<RequestContext, 'space' | 'user'>, sessionId: string): Promise<WorkspaceData | null> {
  const context = await findSessionContext(ctx, sessionId);
  if (!context || context.session.status === 'archived' || context.session.archivedAt) return null;
  const { scope, session, project, worktree } = context;
  const { runner } = scope;
  const base = worktree?.baseBranch ?? project.defaultBranch;
  const worktreePresent = Boolean(worktree && !worktree.removedAt && worktree.status !== 'removed');

  let runnerDown = false;
  const guard = async <T>(promise: Promise<T>): Promise<T | null> => {
    try {
      return await promise;
    } catch (error) {
      if (isRunnerUnavailable(error)) runnerDown = true;
      else console.warn('[workspace] lecture partielle', (error as Error)?.message ?? error);
      return null;
    }
  };

  const [dto, events, changes, branch, claudeMd, siblings, pullRequest, allowedCommands, live] = await Promise.all([
    guard(runner.getSession({ params: { sessionId } }, { timeoutMs: 8_000 })),
    guard(readSessionEvents(runner, sessionId)),
    worktreePresent && worktree ? guard(runner.worktreeChanges({ params: { worktreeId: worktree.id } }, { timeoutMs: 15_000 })) : null,
    worktreePresent && worktree ? guard(readBranchStatus(runner, worktree.id, base)) : null,
    worktreePresent && worktree && session.status === 'new'
      ? guard(runner.readClaudeMd({ params: { projectId: project.id }, query: { worktreeId: worktree.id } }, { timeoutMs: 8_000 }))
      : null,
    readSiblings(context),
    readLatestPullRequest(project.id, worktree?.branch ?? null),
    countAllowed(sessionId),
    liveCount(scope.environmentId),
  ]);
  const [max, identity, policy, commonConfig] = await Promise.all([
    environmentMaxSessions(scope.environmentId, 4),
    getGitIdentity(ctx.user),
    getEffectiveSessionPolicy(scope.spaceId),
    sessionConfigView(scope.spaceId, sessionId).catch((error: unknown) => {
      console.warn('[workspace] configuration commune illisible', (error as Error)?.message ?? error);
      return null;
    }),
  ]);

  const permission: PermissionRequestDto | null = dto?.pendingPermission ?? null;

  return {
    session: toWorkspaceSession(session, dto, policy.autoResumeAfterLimit),
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug,
      fullName: project.githubFullName,
      repoName: repoName(project.githubFullName),
      defaultBranch: project.defaultBranch,
      htmlUrl: githubHtmlUrl(project),
      commands: {
        install: project.commands.install ?? null,
        dev: project.commands.dev ?? null,
        build: project.commands.build ?? null,
        test: project.commands.test ?? null,
        lint: project.commands.lint ?? null,
      },
      readClaudeMd: project.options.readClaudeMd !== false,
    },
    worktree: worktree
      ? {
          id: worktree.id,
          name: worktree.name,
          branch: worktree.branch,
          baseBranch: worktree.baseBranch,
          isPrimary: worktree.isPrimary,
          present: worktreePresent,
        }
      : null,
    permission,
    events,
    branch,
    changes,
    siblings: siblings.map((s) => (s.current && dto ? { ...s, status: dto.status } : s)),
    capacity: { live, max },
    claudeMd: claudeMd ? { exists: claudeMd.exists, lines: claudeMd.lines } : null,
    pullRequest,
    allowedCommands,
    runner: runnerDown ? 'unavailable' : 'available',
    author: identity ?? { name: ctx.user.name, email: ctx.user.email },
    environment: { id: scope.environmentId, name: scope.environmentName },
    preview: previewSettingsView(),
    commonConfig,
    generatedAt: new Date().toISOString(),
  };
}
