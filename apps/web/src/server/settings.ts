import 'server-only';
import { appSettings } from '@nuera/db/schema';
import type { PermissionMode, ThemePreference } from '@nuera/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError, formatZodIssues } from '@/server/errors';
import { audit, AUDIT_ACTIONS } from '@/server/security/audit';

/**
 * Application settings: single row `app_settings` (id = 1), created with the schema defaults on
 * first read. Reads are cached in memory for a few seconds (invalidated by `updateAppSettings`),
 * because `getCurrentUser()` reads the web-session policy on every request.
 *
 *   const settings = await getAppSettings();
 *   await updateAppSettings({ maxConcurrentSessions: 6 });   // Zod-validated, audited
 */

export type AppSettings = typeof appSettings.$inferSelect;

const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const satisfies readonly PermissionMode[];
const THEMES = ['light', 'dark', 'system'] as const satisfies readonly ThemePreference[];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `${max} caractères au maximum`)
    .transform((value) => (value === '' ? null : value))
    .nullable();

const absolutePath = z
  .string()
  .trim()
  .max(500, '500 caractères au maximum')
  .refine((value) => value === '' || /^(\/|[A-Za-z]:[\\/])/.test(value), 'chemin absolu attendu (ex. /srv/dev)')
  .transform((value) => (value === '' ? null : value))
  .nullable();

export const appSettingsInputSchema = z.object({
  maxConcurrentSessions: z.int('nombre entier attendu').min(1, '1 au minimum').max(16, '16 au maximum'),
  defaultModel: optionalText(100),
  defaultEffort: optionalText(40),
  defaultPermissionMode: z.enum(PERMISSION_MODES, 'mode de permission inconnu'),
  blockBypassPermissions: z.boolean(),
  permissionWaitSeconds: z.int('nombre entier attendu').min(10, '10 s au minimum').max(1800, '30 min au maximum'),
  remoteControlByDefault: z.boolean(),
  webSessionIdleHours: z.int('nombre entier attendu').min(1, '1 h au minimum').max(168, '7 jours au maximum'),
  webSessionMaxDays: z.int('nombre entier attendu').min(1, '1 jour au minimum').max(90, '90 jours au maximum'),
  projectsRoot: absolutePath,
  serverName: z.string().trim().min(1, 'nom requis').max(40, '40 caractères au maximum'),
  serverLocation: optionalText(80),
  sessionMemoryLimitMb: z.int('nombre entier attendu').min(256, '256 Mo au minimum').max(262_144).nullable(),
  worktreeStaleDays: z.int('nombre entier attendu').min(1, '1 jour au minimum').max(365, '365 jours au maximum'),
  theme: z.enum(THEMES, 'thème inconnu'),
  locale: z.enum(['fr'], 'langue non disponible'),
});

export type AppSettingsInput = z.infer<typeof appSettingsInputSchema>;
export const appSettingsPatchSchema = appSettingsInputSchema.partial();

/** French labels used in audit summaries (« réglages modifiés : sessions parallèles, thème »). */
const LABELS: Record<keyof AppSettingsInput, string> = {
  maxConcurrentSessions: 'sessions parallèles',
  defaultModel: 'modèle par défaut',
  defaultEffort: 'effort par défaut',
  defaultPermissionMode: 'mode de permission',
  blockBypassPermissions: 'blocage du mode sans autorisation',
  permissionWaitSeconds: 'délai de réponse aux autorisations',
  remoteControlByDefault: 'Remote Control par défaut',
  webSessionIdleHours: 'expiration après inactivité',
  webSessionMaxDays: 'durée maximale des accès',
  projectsRoot: 'racine des projets',
  serverName: 'nom du serveur',
  serverLocation: 'emplacement du serveur',
  sessionMemoryLimitMb: 'mémoire par session',
  worktreeStaleDays: 'worktrees inactifs',
  theme: 'thème',
  locale: 'langue',
};

const CACHE_TTL_MS = 5_000;
const globalForSettings = globalThis as unknown as { __nueraSettings?: { value: AppSettings; at: number } };

export function invalidateAppSettingsCache(): void {
  globalForSettings.__nueraSettings = undefined;
}

async function readOrCreate(): Promise<AppSettings> {
  const [existing] = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (existing) return existing;
  await db.insert(appSettings).values({ id: 1 }).onConflictDoNothing({ target: appSettings.id });
  const [created] = await db.select().from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (!created) throw new AppError('INTERNAL', 'Réglages introuvables.');
  return created;
}

export async function getAppSettings(): Promise<AppSettings> {
  const cached = globalForSettings.__nueraSettings;
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const value = await readOrCreate();
  globalForSettings.__nueraSettings = { value, at: Date.now() };
  return value;
}

/**
 * Validates and applies a partial update, audits the changed fields (old → new values), returns
 * the new row. Throws AppError VALIDATION (French detail) on invalid input.
 */
export async function updateAppSettings(
  patch: Partial<AppSettingsInput>,
  options: { actorUserId?: string | null } = {},
): Promise<AppSettings> {
  const parsed = appSettingsPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Réglages invalides.', { detail: formatZodIssues(parsed.error) });
  }
  const current = await readOrCreate();
  const changes = Object.fromEntries(
    Object.entries(parsed.data).filter(
      ([key, value]) => value !== undefined && current[key as keyof AppSettings] !== value,
    ),
  ) as Partial<AppSettingsInput>;

  const next = { ...current, ...changes };
  if (next.blockBypassPermissions && next.defaultPermissionMode === 'bypassPermissions') {
    throw new AppError('VALIDATION', 'Le mode sans autorisation est bloqué.', {
      detail: "Choisissez un autre mode de permission par défaut, ou levez d'abord le blocage.",
    });
  }
  if (Object.keys(changes).length === 0) return current;

  const [updated] = await db.update(appSettings).set(changes).where(eq(appSettings.id, 1)).returning();
  if (!updated) throw new AppError('INTERNAL', 'Réglages introuvables.');
  invalidateAppSettingsCache();

  const changedKeys = Object.keys(changes) as Array<keyof AppSettingsInput>;
  // Actor defaults to the signed-in owner of the current request (lazy import: no cycle at load time).
  const actorUserId =
    options.actorUserId !== undefined
      ? options.actorUserId
      : ((await import('@/server/auth/session').then((m) => m.getCurrentUser()).catch(() => null))?.id ?? null);
  await audit({
    action: AUDIT_ACTIONS.settingsUpdated,
    summary: `réglages modifiés : ${changedKeys.map((key) => LABELS[key]).join(', ')}`,
    targetType: 'app_settings',
    targetId: '1',
    actorUserId,
    metadata: {
      changes: Object.fromEntries(changedKeys.map((key) => [key, { from: current[key], to: changes[key] }])),
    },
  });
  return updated;
}

/** Web-session policy read by the auth layer (hours / days). */
export async function getWebSessionPolicy(): Promise<{ idleHours: number; maxDays: number }> {
  const settings = await getAppSettings();
  return { idleHours: settings.webSessionIdleHours, maxDays: settings.webSessionMaxDays };
}
