import 'server-only';
import type { SettingsPageData } from '@/features/settings/lib/types';
import type { CurrentUser } from '@/server/auth/session';
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
 *
 *   const data = await loadSettingsPage(user);     // every section loads on its own (Load<T>)
 */

export { getAccountView, getJournalPage, getPasskeys, getWebSessions } from './account';
export { getClaudeCli, listSeenModels, toClaudeCliView } from './claude';
export { getOperationLog, listOperationLogs, listSessionLogs } from './logs';
export { load, toLoadError } from './load';
export { getPushView } from './push';
export { getLiveSessions, getMetrics, getRunnerHealth, getUptime, getWebProcess } from './server-status';
export { getSettingsValues, settingsPatchSchema, toSettingsValues, updateSettings, type SettingsPatch } from './settings';
export { listStaleWorktrees, removeStaleWorktrees, removeStaleWorktreesInputSchema, selectStaleWorktrees } from './worktrees';

export async function loadSettingsPage(user: CurrentUser): Promise<SettingsPageData> {
  const [settings, claude, seenModels, account, journal, health, liveSessions, uptime, metrics, worktrees, push] = await Promise.all([
    getSettingsValues(),
    load(() => getClaudeCli({ timeoutMs: 8_000 })),
    listSeenModels().catch(() => []),
    load(() => getAccountView()),
    load(() => getJournalPage({ limit: 20 })),
    load(() => getRunnerHealth()),
    load(() => getLiveSessions()),
    load(() => getUptime(30)),
    load(() => getMetrics()),
    load(() => listStaleWorktrees()),
    load(() => getPushView(user.id)),
  ]);
  return {
    now: new Date().toISOString(),
    owner: { name: user.name, email: user.email },
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
