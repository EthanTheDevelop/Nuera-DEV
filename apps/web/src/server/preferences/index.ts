import 'server-only';
import type { SettingsPageData } from '@/features/settings/lib/types';
import type { RequestContext } from '@/server/tenancy/context';
import { getAccountView, getJournalPage } from './account';
import { getClaudeCli, listSeenModels } from './claude';
import { load } from './load';
import { getPushView } from './push';
import { getLiveSessions, getMetrics, getRunnerHealth, getUptime, getWebProcess } from './server-status';
import { getSettingsValues } from './settings';
import { listStaleWorktrees } from './worktrees';

/**
 * Server module of Paramètres (D08 / M08). Pages and client components never touch the database:
 * they go through these functions (Server Components) or the actions of `features/settings/actions.ts`.
 * Everything is read for the request context (docs/MULTICOMPTE.md §8): the signed-in account, its
 * space and the server of that space — never another account's data.
 *
 *   const data = await loadSettingsPage(await requireContext());   // every section loads on its own
 *
 * Without a server, the sections that need a runner fail with `noEnvironment` (no runner call):
 * « Aucun serveur ne vous est encore attribué. Un administrateur doit vous en attribuer un. »
 */

export { getAccountView, getJournalPage, getPasskeys, getWebSessions } from './account';
export { getClaudeCli, listSeenModels, toClaudeCliView } from './claude';
export { getOperationLog, listOperationLogs, listSessionLogs } from './logs';
export { load, toLoadError } from './load';
export { getPushView } from './push';
export { getLiveSessions, getMetrics, getRunnerHealth, getUptime, getWebProcess } from './server-status';
export {
  getSettingsValues,
  settingsActor,
  settingsPatchSchema,
  toSettingsValues,
  updateSettings,
  type SettingsPatch,
  type UpdateSettingsResult,
} from './settings';
export { listStaleWorktrees, removeStaleWorktrees, removeStaleWorktreesInputSchema, selectStaleWorktrees } from './worktrees';

export async function loadSettingsPage(ctx: RequestContext): Promise<SettingsPageData> {
  const [settings, claude, seenModels, account, journal, health, liveSessions, uptime, metrics, worktrees, push] = await Promise.all([
    getSettingsValues(ctx),
    load(() => getClaudeCli(ctx, { timeoutMs: 8_000 })),
    listSeenModels(ctx).catch(() => []),
    load(() => getAccountView()),
    load(() => getJournalPage(ctx, { limit: 20 })),
    load(() => getRunnerHealth(ctx)),
    load(() => getLiveSessions(ctx)),
    load(() => getUptime(ctx, 30)),
    load(() => getMetrics(ctx)),
    load(() => listStaleWorktrees(ctx)),
    load(() => getPushView(ctx.user.id)),
  ]);
  const environment = ctx.environment;
  return {
    now: new Date().toISOString(),
    profile: { name: ctx.user.name, email: ctx.user.email, role: ctx.user.role },
    space: { id: ctx.space.id, name: ctx.space.name },
    // The settings view reads the server row afresh (a rename shows at once); the context gives its id.
    environment: environment
      ? { id: environment.id, name: settings.serverName ?? environment.name, location: settings.serverLocation, isDefault: environment.isDefault }
      : null,
    settings,
    claude,
    seenModels,
    account,
    journal,
    health,
    liveSessions,
    uptime,
    metrics,
    web: getWebProcess(),
    worktrees,
    push,
  };
}
