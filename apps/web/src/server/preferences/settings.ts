import 'server-only';
import { z } from 'zod';
import type { SettingsValues } from '@/features/settings/lib/types';
import { AppError, formatZodIssues } from '@/server/errors';
import { appSettingsInputSchema, getAppSettings, updateAppSettings, type AppSettings } from '@/server/settings';

/**
 * Subset of `app_settings` editable from Paramètres (forms, PATCH /api/settings). The theme goes
 * through `setThemePreferenceAction` (cookie mirror for SSR), the language is French only, and the
 * projects root is the runner's own NUERA_PROJECTS_ROOT (read-only here: the runner confines paths to it).
 */
export const settingsPatchSchema = appSettingsInputSchema
  .pick({
    maxConcurrentSessions: true,
    defaultModel: true,
    defaultEffort: true,
    defaultPermissionMode: true,
    blockBypassPermissions: true,
    permissionWaitSeconds: true,
    remoteControlByDefault: true,
    webSessionIdleHours: true,
    webSessionMaxDays: true,
    serverName: true,
    serverLocation: true,
    sessionMemoryLimitMb: true,
    worktreeStaleDays: true,
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'aucun réglage à modifier');

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export function toSettingsValues(row: AppSettings): SettingsValues {
  return {
    maxConcurrentSessions: row.maxConcurrentSessions,
    defaultModel: row.defaultModel,
    defaultEffort: row.defaultEffort,
    defaultPermissionMode: row.defaultPermissionMode,
    blockBypassPermissions: row.blockBypassPermissions,
    permissionWaitSeconds: row.permissionWaitSeconds,
    remoteControlByDefault: row.remoteControlByDefault,
    webSessionIdleHours: row.webSessionIdleHours,
    webSessionMaxDays: row.webSessionMaxDays,
    serverName: row.serverName,
    serverLocation: row.serverLocation,
    sessionMemoryLimitMb: row.sessionMemoryLimitMb,
    worktreeStaleDays: row.worktreeStaleDays,
    theme: row.theme,
    locale: row.locale,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getSettingsValues(): Promise<SettingsValues> {
  return toSettingsValues(await getAppSettings());
}

/** Validated (strict subset), audited by `updateAppSettings` (« réglages modifiés : … »). */
export async function updateSettings(patch: unknown, actor: { id: string }): Promise<SettingsValues> {
  const parsed = settingsPatchSchema.safeParse(patch);
  if (!parsed.success) throw new AppError('VALIDATION', 'Réglages invalides.', { detail: formatZodIssues(parsed.error) });
  return toSettingsValues(await updateAppSettings(parsed.data, { actorUserId: actor.id }));
}
