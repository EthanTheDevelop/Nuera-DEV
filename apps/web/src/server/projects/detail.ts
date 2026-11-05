import 'server-only';
import { RunnerError, isRunnerUnavailable, runner } from '@/server/runner/client';
import { AppError } from '@/server/errors';
import { listSessions } from '@/server/sessions';
import { shapeBranches, toWorktreeView } from './branches';
import { listEnvVars } from './env';
import { listProjectMcpTools } from './mcp';
import { latestRunsByKind, listProjectSessionRows, loadListItem, primaryWorktreeId, requireProjectRow } from './queries';
import type { Part, ProjectDetail, ProjectSessionCounts, ProjectSessionView } from './types';

const RUNNER_TIMEOUT = { timeoutMs: 8_000 };

/** VPS-3 down, or so slow that the bounded read timed out: both mean « ne répond pas ». */
function runnerNotAnswering(error: unknown): boolean {
  if (isRunnerUnavailable(error)) return true;
  const cause = error instanceof RunnerError ? (error.cause as { name?: unknown } | undefined) : undefined;
  return error instanceof RunnerError && error.code === 'UPSTREAM' && cause?.name === 'TimeoutError';
}

async function part<T>(fn: () => Promise<T>): Promise<Part<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    const unavailable = runnerNotAnswering(error);
    const message = unavailable
      ? 'VPS-3 ne répond pas : cette partie revient dès que le serveur répond.'
      : error instanceof AppError
        ? error.message
        : 'Lecture impossible pour le moment.';
    if (!unavailable && !(error instanceof AppError)) console.error('[projets] détail', error);
    return { ok: false, message, unavailable };
  }
}

const notReady = <T>(message: string): Part<T> => ({ ok: false, message, unavailable: false });

/**
 * Sessions of the project through the SESSIONS lot (`listSessions`: live state and « reprise
 * possible » checked with the runner when it answers); the read-only DB query is the fallback.
 */
async function loadProjectSessions(projectId: string): Promise<ProjectSessionView[]> {
  try {
    const [active, history] = await Promise.all([
      listSessions({ projectId, status: 'active' }),
      listSessions({ projectId, status: 'history', limit: 50 }),
    ]);
    return [...active.items, ...history.items]
      .filter((item) => item.status !== 'archived')
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        branch: item.branch,
        worktreeName: item.worktree?.name ?? null,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        lastActivityAt: item.lastActivityAt,
        createdAt: item.createdAt,
        pendingPermissionId: item.pendingPermissionId,
        resumable: item.resumable,
      }));
  } catch (error) {
    console.error('[projets] sessions du projet (repli sur la base)', error);
    return listProjectSessionRows(projectId, 100);
  }
}

/**
 * Everything the project page (D04 / M04 and its tabs) shows. DB parts (project, runs, sessions,
 * variables) always load; runner parts (branches, worktrees, working tree, CLAUDE.md) and the MCP
 * registry each degrade on their own — a VPS-3 outage never breaks the page.
 */
export async function getProjectDetail(projectId: string): Promise<ProjectDetail> {
  const row = await requireProjectRow(projectId);
  const ready = row.status === 'ready' && !row.archivedAt;
  const why = row.archivedAt
    ? 'Projet archivé : restaurez-le pour lire son dépôt.'
    : row.status === 'cloning'
      ? 'Le clonage est en cours.'
      : "Le clone n'existe pas sur VPS-3 : le clonage a échoué.";

  const [item, primaryId, runs, sessionItems, env, mcp] = await Promise.all([
    loadListItem(row),
    primaryWorktreeId(projectId),
    latestRunsByKind(projectId),
    loadProjectSessions(projectId),
    listEnvVars(projectId),
    part(() => listProjectMcpTools(projectId)),
  ]);

  const [branches, worktrees, status, claudeMd] = ready
    ? await Promise.all([
        part(async () => {
          const result = await runner.listBranches({ params: { projectId } }, { timeoutMs: 15_000 });
          return shapeBranches(result.defaultBranch, result.branches);
        }),
        part(async () => {
          const result = await runner.listWorktrees({ params: { projectId } }, { timeoutMs: 15_000 });
          return result.worktrees.filter((worktree) => worktree.status !== 'removed').map(toWorktreeView);
        }),
        part(async () => {
          const result = await runner.repoStatus({ params: { projectId } }, RUNNER_TIMEOUT);
          return {
            dirtyFiles: result.files.filter((file) => file.kind !== 'ignored').length,
            conflicted: result.counts.conflicted,
            branch: result.branch,
          };
        }),
        part(async () => {
          const md = await runner.readClaudeMd({ params: { projectId } }, RUNNER_TIMEOUT);
          return { worktreeId: md.worktreeId, exists: md.exists, content: md.content, lines: md.lines, modifiedAt: md.modifiedAt, lastCommit: md.lastCommit };
        }),
      ])
    : [notReady<never>(why), notReady<never>(why), notReady<never>(why), notReady<never>(why)];

  const runnerAvailable = ![branches, worktrees, status, claudeMd].some((p) => !p.ok && p.unavailable);
  const counts: ProjectSessionCounts = item.sessions;
  const live = sessionItems.find((session) => ['running', 'waiting_permission', 'waiting_input'].includes(session.status));
  const conflict = status.ok && status.data.conflicted > 0;

  return {
    project: {
      ...item,
      // A conflicted working tree is a conflict to fix, whatever the last pull said.
      sync: { ...item.sync, conflict: item.sync.conflict || conflict },
      branch: (status.ok ? status.data.branch : null) ?? item.branch,
      commands: row.commands ?? {},
      options: row.options,
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
      claudeMdUpdatedAt: row.claudeMdUpdatedAt?.toISOString() ?? null,
      claudeMdCommitSha: row.claudeMdCommitSha,
      primaryWorktreeId: primaryId,
      isPrivate: row.isPrivate,
      primaryLanguage: row.primaryLanguage,
    },
    runnerAvailable,
    branches,
    worktrees,
    status,
    claudeMd,
    runs,
    mcp,
    env,
    sessions: { items: sessionItems, counts, liveSessionId: live?.id ?? null },
    counts: {
      branches: branches.ok ? branches.data.items.length : null,
      mcpEnabled: mcp.ok ? mcp.data.filter((tool) => tool.enabled).length : null,
      env: env.length,
      sessions: counts.total,
    },
  };
}
