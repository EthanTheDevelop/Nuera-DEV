import 'server-only';
import { projects, sessions } from '@nuera/db/schema';
import type { WorktreeDto } from '@nuera/shared/runner';
import { and, eq, inArray, isNotNull, isNull, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { RemoveWorktreesResult, StaleWorktree, StaleWorktreesView } from '@/features/settings/lib/types';
import { db } from '@/server/db';
import { AppError } from '@/server/errors';
import { getRunnerForEnvironment, isRunnerUnavailable, RunnerError } from '@/server/runner/client';
import { getSpaceSettings } from '@/server/settings';
import { requireEnvironment, type RequestContext } from '@/server/tenancy/context';
import { auditIn, ofSpace } from '@/server/tenancy/scope';

/**
 * « Worktrees inactifs » (D08 Maintenance, M08 « Nettoyer les worktrees inactifs », T8) of the
 * account's server: the projects of its space on that server only.
 * A session worktree (never the primary clone) is inactive when nothing happened in it for
 * `space_settings.worktree_stale_days`: last session activity, else its last use, else its creation.
 * Eligibility is computed on the server and re-checked right before removal: a worktree with
 * uncommitted changes (or unreadable git state) or a live session is excluded d'office. Only ids of
 * that list are ever removed: any other id (another space, unknown) is skipped without a runner call.
 */

type WorktreeContext = Pick<RequestContext, 'user' | 'space' | 'environment'>;

const DAY_MS = 86_400_000;

export interface StaleCandidate {
  worktree: Pick<WorktreeDto, 'id' | 'name' | 'branch' | 'isPrimary' | 'status' | 'createdAt' | 'lastUsedAt' | 'dirtyFiles' | 'liveSessionId' | 'sizeBytes'>;
  projectId: string;
  projectName: string;
  lastSessionActivityAt: Date | null;
}

/** Pure decision (unit-tested): which worktrees are inactive, and which of them may be removed. */
export function selectStaleWorktrees(candidates: readonly StaleCandidate[], staleDays: number, now: Date): StaleWorktree[] {
  const threshold = now.getTime() - staleDays * DAY_MS;
  const items: StaleWorktree[] = [];
  for (const { worktree, projectId, projectName, lastSessionActivityAt } of candidates) {
    if (worktree.isPrimary || worktree.status !== 'active') continue;
    const times = [lastSessionActivityAt?.getTime(), dateMs(worktree.lastUsedAt), dateMs(worktree.createdAt)].filter(
      (value): value is number => typeof value === 'number' && !Number.isNaN(value),
    );
    if (times.length === 0) continue;
    const last = Math.max(...times);
    if (last > threshold) continue;
    let excludedReason: string | null = null;
    if (worktree.liveSessionId) excludedReason = 'une session Claude y travaille';
    else if (worktree.dirtyFiles === null) excludedReason = 'état Git illisible';
    else if (worktree.dirtyFiles > 0) excludedReason = `${worktree.dirtyFiles} ${worktree.dirtyFiles > 1 ? 'fichiers non commités' : 'fichier non commité'}`;
    items.push({
      id: worktree.id,
      name: worktree.name,
      branch: worktree.branch,
      projectId,
      projectName,
      lastActivityAt: new Date(last).toISOString(),
      dirtyFiles: worktree.dirtyFiles,
      eligible: excludedReason === null,
      excludedReason,
      sizeBytes: worktree.sizeBytes ?? null,
    });
  }
  return items.sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.lastActivityAt.localeCompare(b.lastActivityAt));
}

function dateMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

async function lastSessionActivityByWorktree(environmentId: string, worktreeIds: string[]): Promise<Map<string, Date>> {
  const map = new Map<string, Date>();
  if (worktreeIds.length === 0) return map;
  const rows = await db
    .select({
      worktreeId: sessions.worktreeId,
      at: max(sql<string>`coalesce(${sessions.lastActivityAt}, ${sessions.endedAt}, ${sessions.updatedAt})`),
    })
    .from(sessions)
    .where(and(eq(sessions.environmentId, environmentId), isNotNull(sessions.worktreeId), inArray(sessions.worktreeId, worktreeIds)))
    .groupBy(sessions.worktreeId);
  for (const row of rows) {
    if (!row.worktreeId || !row.at) continue;
    const raw: unknown = row.at;
    const at = raw instanceof Date ? raw : new Date(String(raw));
    if (!Number.isNaN(at.getTime())) map.set(row.worktreeId, at);
  }
  return map;
}

export async function listStaleWorktrees(ctx: WorktreeContext, now = new Date()): Promise<StaleWorktreesView> {
  const { environment } = requireEnvironment(ctx);
  const runner = getRunnerForEnvironment(environment.id);
  const settings = await getSpaceSettings(ctx.space.id);
  if (!settings) throw new AppError('NOT_FOUND', "L'espace de ce compte est introuvable.");
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(ofSpace(ctx, eq(projects.environmentId, environment.id), isNull(projects.archivedAt), eq(projects.status, 'ready')));
  const unreadable: string[] = [];
  const lists = await Promise.all(
    rows.map(async (project) => {
      try {
        // Sizes are measured (and cached) by the runner: D08 « · 2,4 Go », T8 « Libère 1,8 Go ».
        const { worktrees } = await runner.listWorktrees({ params: { projectId: project.id }, query: { sizes: true } }, { timeoutMs: 30_000 });
        return worktrees.map((worktree) => ({ worktree, projectId: project.id, projectName: project.name }));
      } catch (error) {
        // The runner itself is down: the whole section is unavailable (no partial lie).
        if (isRunnerUnavailable(error)) throw error;
        unreadable.push(project.name);
        return [];
      }
    }),
  );
  const flat = lists.flat();
  const activity = await lastSessionActivityByWorktree(environment.id, flat.map((item) => item.worktree.id));
  const candidates: StaleCandidate[] = flat.map((item) => ({ ...item, lastSessionActivityAt: activity.get(item.worktree.id) ?? null }));
  return { staleDays: settings.worktreeStaleDays, items: selectStaleWorktrees(candidates, settings.worktreeStaleDays, now), unreadable };
}

export const removeStaleWorktreesInputSchema = z.object({
  ids: z.array(z.uuid('worktree invalide')).min(1, 'aucun worktree choisi').max(100),
});

/**
 * Removes the chosen inactive worktrees (T8 « Supprimer N worktrees »). The list is recomputed first:
 * an id that is no longer inactive or eligible is skipped with its reason. Never `force`: the runner
 * refuses a worktree that became dirty (WORKTREE_DIRTY). Branches are kept. Each removal is audited.
 */
export async function removeStaleWorktrees(ctx: WorktreeContext, input: z.input<typeof removeStaleWorktreesInputSchema>): Promise<RemoveWorktreesResult> {
  const parsed = removeStaleWorktreesInputSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION', 'Choix de worktrees invalide.');
  const { environment } = requireEnvironment(ctx);
  const runner = getRunnerForEnvironment(environment.id);
  const current = await listStaleWorktrees(ctx);
  const byId = new Map(current.items.map((item) => [item.id, item]));
  const result: RemoveWorktreesResult = { removed: [], skipped: [] };
  for (const id of new Set(parsed.data.ids)) {
    const item = byId.get(id);
    if (!item) {
      result.skipped.push({ id, name: id.slice(0, 8), reason: "n'est plus inactif ou n'existe plus" });
      continue;
    }
    if (!item.eligible) {
      result.skipped.push({ id, name: item.name, reason: item.excludedReason ?? 'exclu' });
      continue;
    }
    try {
      await runner.removeWorktree({ params: { worktreeId: id }, query: { force: false, deleteBranch: false } }, { timeoutMs: 60_000 });
    } catch (error) {
      if (isRunnerUnavailable(error)) {
        if (result.removed.length === 0) throw error;
        result.skipped.push({ id, name: item.name, reason: `${environment.name} ne répond plus` });
        continue;
      }
      const reason =
        error instanceof RunnerError && error.reason === 'WORKTREE_DIRTY'
          ? 'des modifications non commitées sont apparues'
          : error instanceof AppError
            ? error.message
            : 'suppression refusée';
      result.skipped.push({ id, name: item.name, reason });
      continue;
    }
    result.removed.push({ id, name: item.name });
    await auditIn(ctx, {
      action: 'maintenance.worktree_removed',
      summary: `worktree inactif ${item.name} (${item.branch}) supprimé de ${item.projectName}, branche conservée`,
      targetType: 'worktree',
      targetId: id,
      environmentId: environment.id,
      metadata: { projectId: item.projectId, branch: item.branch, lastActivityAt: item.lastActivityAt },
    });
  }
  return result;
}
