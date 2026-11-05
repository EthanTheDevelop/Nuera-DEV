import { apiRoute } from '@/server/http';
import { getSettingsValues, settingsPatchSchema, updateSettings } from '@/server/preferences';

/**
 * Réglages de Nuera Dev (Paramètres).
 *   GET   → SettingsValues (no secret: app_settings holds none)
 *   PATCH { maxConcurrentSessions?, defaultModel?, defaultEffort?, defaultPermissionMode?,
 *           blockBypassPermissions?, permissionWaitSeconds?, remoteControlByDefault?,
 *           webSessionIdleHours?, webSessionMaxDays?, serverName?, serverLocation?,
 *           sessionMemoryLimitMb?, worktreeStaleDays? } → SettingsValues (validated, audited)
 */

export const dynamic = 'force-dynamic';

export const GET = apiRoute({
  handler: async () => getSettingsValues(),
});

export const PATCH = apiRoute({
  body: settingsPatchSchema,
  maxBodyBytes: 8 * 1024,
  rateLimit: { limit: 60, windowMs: 60_000 },
  handler: async ({ body, user }) => updateSettings(body, user),
});
