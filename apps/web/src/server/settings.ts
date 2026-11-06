import 'server-only';
import { appSettings, environments, spaceMembers, spaceSettings, spaces, user, userPreferences } from '@nuera/db/schema';
import type { EnvironmentStatus, InstanceRole, PermissionMode, SpaceRole, ThemePreference } from '@nuera/db/schema';
import { and, eq, gte, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError, formatZodIssues, type AppErrorCode } from '@/server/errors';
import { audit, AUDIT_ACTIONS } from '@/server/security/audit';

/**
 * Settings by scope (docs/MULTICOMPTE.md §8). Each scope has its own row, Zod schema, cache (a few
 * seconds, keyed by scope id, invalidated by every update) and audit trail:
 *
 *   instance    app_settings (id = 1)   web-session lifetimes, invitation validity, forced bypass block   owner/admin
 *   server      environments            name, location (admin) · parallel sessions, memory (space owner, ≤ cap)
 *   space       space_settings          model, effort, permission mode, bypass block, wait, Remote Control, stale worktrees   space owner
 *   account     user_preferences        theme, language, Git identity   the account itself
 *
 *   const policy = await getEffectiveSessionPolicy(ctx.space.id);           // what a new session gets
 *   await updateSpaceSettings(ctx.space.id, { permissionWaitSeconds: 300 }, { userId: ctx.user.id });
 *   const { results } = await applySettingsPatch(actorOf(ctx), body);        // PATCH /api/settings (flat keys)
 *
 * The deprecated `app_settings` columns (moved to the other scopes) are never read: every query
 * names its columns. The caller passes ids from the request context, never from the client; the
 * module still re-checks ownership: a foreign space or server answers NOT_FOUND like an unknown one.
 */

const FORBIDDEN_ADMIN = 'Réglage réservé aux administrateurs.';
const FORBIDDEN_SPACE_OWNER = "Réglage réservé au propriétaire de l'espace.";
const RETIRED_ENVIRONMENT = 'Ce serveur est retiré : ses réglages ne sont plus modifiables.';
const NO_ENVIRONMENT ='Aucun serveur ne vous est encore attribué : un administrateur doit vous en attribuer un.';
const PROJECTS_ROOT_IGNORED =
  "La racine des projets est fixée par chaque serveur (NUERA_PROJECTS_ROOT) : ce réglage n'a plus d'effet et a été ignoré.";

const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const satisfies readonly PermissionMode[];
const THEMES = ['light', 'dark', 'system'] as const satisfies readonly ThemePreference[];

export type SettingsScope = 'instance' | 'environment' | 'space' | 'user';

/** Who changes settings: the signed-in account and its instance role (from the request context). */
export interface SettingsActor {
  userId: string;
  role: InstanceRole;
}

export function isInstanceAdmin(role: InstanceRole): boolean {
  return role === 'owner' || role === 'admin';
}

// ---------------------------------------------------------------------------------------------
// Schemas (one per scope)
// ---------------------------------------------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `${max} caractères au maximum`)
    .transform((value) => (value === '' ? null : value))
    .nullable();

const int = () => z.int('nombre entier attendu');

/** Git ident: no control character and no « < » / « > » (they delimit the e-mail in a commit). */
const gitAuthorName = z
  .string()
  .trim()
  .max(100, '100 caractères au maximum')
  .refine((value) => !/[<>\p{Cc}]/u.test(value), 'caractères « < », « > » et de contrôle interdits')
  .transform((value) => (value === '' ? null : value))
  .nullable();

const gitAuthorEmail = z
  .string()
  .trim()
  .max(254, '254 caractères au maximum')
  .refine((value) => value === '' || z.email().safeParse(value).success, 'adresse e-mail invalide')
  .transform((value) => (value === '' ? null : value.toLowerCase()))
  .nullable();

export const instanceSettingsSchema = z.object({
  webSessionIdleHours: int().min(1, '1 h au minimum').max(168, '7 jours au maximum'),
  webSessionMaxDays: int().min(1, '1 jour au minimum').max(90, '90 jours au maximum'),
  invitationTtlHours: int().min(1, '1 h au minimum').max(168, '7 jours au maximum'),
  forceBlockBypassPermissions: z.boolean('valeur oui/non attendue'),
});
export type InstanceSettingsInput = z.infer<typeof instanceSettingsSchema>;

export const spaceSettingsSchema = z.object({
  defaultModel: optionalText(100),
  defaultEffort: optionalText(40),
  defaultPermissionMode: z.enum(PERMISSION_MODES, 'mode de permission inconnu'),
  blockBypassPermissions: z.boolean('valeur oui/non attendue'),
  permissionWaitSeconds: int().min(10, '10 s au minimum').max(1800, '30 min au maximum'),
  remoteControlByDefault: z.boolean('valeur oui/non attendue'),
  worktreeStaleDays: int().min(1, '1 jour au minimum').max(365, '365 jours au maximum'),
});
export type SpaceSettingsInput = z.infer<typeof spaceSettingsSchema>;

/** The administrator's ceiling (`max_concurrent_sessions_cap`) is checked on top. */
export const environmentLimitsSchema = z.object({
  maxConcurrentSessions: int().min(1, '1 au minimum').max(64, '64 au maximum'),
  sessionMemoryLimitMb: int().min(256, '256 Mo au minimum').max(262_144, '256 Go au maximum').nullable(),
});
export type EnvironmentLimitsInput = z.infer<typeof environmentLimitsSchema>;

export const environmentIdentitySchema = z.object({
  name: z.string().trim().min(1, 'nom requis').max(40, '40 caractères au maximum'),
  location: optionalText(80),
});
export type EnvironmentIdentityInput = z.infer<typeof environmentIdentitySchema>;

export const userPreferencesSchema = z.object({
  theme: z.enum(THEMES, 'thème inconnu'),
  locale: z.enum(['fr'], 'langue non disponible'),
  gitAuthorName,
  gitAuthorEmail,
});
export type UserPreferencesInput = z.infer<typeof userPreferencesSchema>;

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

export interface InstanceSettings {
  webSessionIdleHours: number;
  webSessionMaxDays: number;
  invitationTtlHours: number;
  forceBlockBypassPermissions: boolean;
  updatedAt: Date;
}

export interface SpaceSettings {
  spaceId: string;
  defaultModel: string | null;
  defaultEffort: string | null;
  defaultPermissionMode: PermissionMode;
  blockBypassPermissions: boolean;
  permissionWaitSeconds: number;
  remoteControlByDefault: boolean;
  worktreeStaleDays: number;
  updatedAt: Date;
}

/** A server's settings (never its token, URL or database role). */
export interface EnvironmentSettings {
  id: string;
  spaceId: string | null;
  name: string;
  location: string | null;
  status: EnvironmentStatus;
  isDefault: boolean;
  maxConcurrentSessions: number;
  maxConcurrentSessionsCap: number;
  sessionMemoryLimitMb: number | null;
  updatedAt: Date;
}

export interface UserPreferences {
  userId: string;
  theme: ThemePreference;
  locale: string;
  /** null = the account's name. */
  gitAuthorName: string | null;
  /** null = the account's e-mail. */
  gitAuthorEmail: string | null;
  updatedAt: Date;
}

const instanceColumns = {
  webSessionIdleHours: appSettings.webSessionIdleHours,
  webSessionMaxDays: appSettings.webSessionMaxDays,
  invitationTtlHours: appSettings.invitationTtlHours,
  forceBlockBypassPermissions: appSettings.forceBlockBypassPermissions,
  updatedAt: appSettings.updatedAt,
};

const spaceColumns = {
  spaceId: spaceSettings.spaceId,
  defaultModel: spaceSettings.defaultModel,
  defaultEffort: spaceSettings.defaultEffort,
  defaultPermissionMode: spaceSettings.defaultPermissionMode,
  blockBypassPermissions: spaceSettings.blockBypassPermissions,
  permissionWaitSeconds: spaceSettings.permissionWaitSeconds,
  remoteControlByDefault: spaceSettings.remoteControlByDefault,
  worktreeStaleDays: spaceSettings.worktreeStaleDays,
  updatedAt: spaceSettings.updatedAt,
};

const environmentColumns = {
  id: environments.id,
  spaceId: environments.spaceId,
  name: environments.name,
  location: environments.location,
  status: environments.status,
  isDefault: environments.isDefault,
  maxConcurrentSessions: environments.maxConcurrentSessions,
  maxConcurrentSessionsCap: environments.maxConcurrentSessionsCap,
  sessionMemoryLimitMb: environments.sessionMemoryLimitMb,
  updatedAt: environments.updatedAt,
};

const userColumns = {
  userId: userPreferences.userId,
  theme: userPreferences.theme,
  locale: userPreferences.locale,
  gitAuthorName: userPreferences.gitAuthorName,
  gitAuthorEmail: userPreferences.gitAuthorEmail,
  updatedAt: userPreferences.updatedAt,
};

// ---------------------------------------------------------------------------------------------
// Cache (per scope id; `getCurrentUser()` reads the web-session policy on every request)
// ---------------------------------------------------------------------------------------------

const CACHE_TTL_MS = 5_000;
const globalForSettings = globalThis as unknown as { __nueraScopedSettings?: Map<string, { value: unknown; at: number }> };

function cache(): Map<string, { value: unknown; at: number }> {
  globalForSettings.__nueraScopedSettings ??= new Map();
  return globalForSettings.__nueraScopedSettings;
}

/** Each caller gets its own shallow copy: mutating a result never alters the cached entry. */
async function cached<T extends object>(key: string, load: () => Promise<T | null>): Promise<T | null> {
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...(hit.value as T) };
  const value = await load();
  if (value) cache().set(key, { value: { ...value }, at: Date.now() });
  return value;
}

/** Drops cached settings: one scope id, or everything (tests, after a direct database write). */
export function invalidateSettingsCache(scope?: { kind: SettingsScope; id?: string }): void {
  if (!scope) {
    cache().clear();
    return;
  }
  cache().delete(scope.kind === 'instance' ? 'instance' : `${scope.kind}:${scope.id ?? ''}`);
}

const isUuid = (value: string): boolean => z.uuid().safeParse(value).success;

// ---------------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------------

async function readInstance(): Promise<InstanceSettings> {
  const [existing] = await db.select(instanceColumns).from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (existing) return existing;
  await db.insert(appSettings).values({ id: 1 }).onConflictDoNothing({ target: appSettings.id });
  const [created] = await db.select(instanceColumns).from(appSettings).where(eq(appSettings.id, 1)).limit(1);
  if (!created) throw new AppError('INTERNAL', 'Réglages introuvables.');
  return created;
}

export async function getInstanceSettings(): Promise<InstanceSettings> {
  const value = await cached('instance', readInstance);
  if (!value) throw new AppError('INTERNAL', 'Réglages introuvables.');
  return value;
}

/** Web-session policy read by the auth layer (hours / days). */
export async function getWebSessionPolicy(): Promise<{ idleHours: number; maxDays: number }> {
  const settings = await getInstanceSettings();
  return { idleHours: settings.webSessionIdleHours, maxDays: settings.webSessionMaxDays };
}

async function readSpace(spaceId: string): Promise<SpaceSettings | null> {
  const [existing] = await db.select(spaceColumns).from(spaceSettings).where(eq(spaceSettings.spaceId, spaceId)).limit(1);
  if (existing) return existing;
  const [space] = await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return null;
  // Created with the space; a missing row (older data) is created with the schema defaults.
  await db.insert(spaceSettings).values({ spaceId }).onConflictDoNothing({ target: spaceSettings.spaceId });
  const [created] = await db.select(spaceColumns).from(spaceSettings).where(eq(spaceSettings.spaceId, spaceId)).limit(1);
  return created ?? null;
}

/** Settings of a space; null for an unknown space. */
export function getSpaceSettings(spaceId: string): Promise<SpaceSettings | null> {
  if (!isUuid(spaceId)) return Promise.resolve(null);
  return cached(`space:${spaceId}`, () => readSpace(spaceId));
}

async function readEnvironment(environmentId: string): Promise<EnvironmentSettings | null> {
  const [row] = await db.select(environmentColumns).from(environments).where(eq(environments.id, environmentId)).limit(1);
  return row ?? null;
}

/** Settings of a server; null for an unknown server. */
export function getEnvironmentSettings(environmentId: string): Promise<EnvironmentSettings | null> {
  if (!isUuid(environmentId)) return Promise.resolve(null);
  return cached(`environment:${environmentId}`, () => readEnvironment(environmentId));
}

async function readUser(userId: string): Promise<UserPreferences | null> {
  const [existing] = await db.select(userColumns).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  if (existing) return existing;
  const [account] = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
  if (!account) return null;
  await db.insert(userPreferences).values({ userId }).onConflictDoNothing({ target: userPreferences.userId });
  const [created] = await db.select(userColumns).from(userPreferences).where(eq(userPreferences.userId, userId)).limit(1);
  return created ?? null;
}

/** Preferences of an account; null for an unknown account. */
export function getUserPreferences(userId: string): Promise<UserPreferences | null> {
  if (!userId) return Promise.resolve(null);
  return cached(`user:${userId}`, () => readUser(userId));
}

export interface EffectiveSessionPolicy {
  /** Effective block: instance OR space. */
  blockBypassPermissions: boolean;
  /** The instance forces the block (the space setting is then read-only: « Réglé par un administrateur »). */
  blockBypassForcedByInstance: boolean;
  permissionWaitSeconds: number;
  defaultModel: string | null;
  defaultEffort: string | null;
  /** Never `bypassPermissions` while the block is effective (falls back to `manual`). */
  defaultPermissionMode: PermissionMode;
  remoteControlByDefault: boolean;
  worktreeStaleDays: number;
}

/** What a session launched in this space gets (passed to the runner as launch options). */
export async function getEffectiveSessionPolicy(spaceId: string): Promise<EffectiveSessionPolicy> {
  const [instance, space] = await Promise.all([getInstanceSettings(), getSpaceSettings(spaceId)]);
  if (!space) throw new AppError('NOT_FOUND');
  const block = instance.forceBlockBypassPermissions || space.blockBypassPermissions;
  return {
    blockBypassPermissions: block,
    blockBypassForcedByInstance: instance.forceBlockBypassPermissions,
    permissionWaitSeconds: space.permissionWaitSeconds,
    defaultModel: space.defaultModel,
    defaultEffort: space.defaultEffort,
    defaultPermissionMode: block && space.defaultPermissionMode === 'bypassPermissions' ? 'manual' : space.defaultPermissionMode,
    remoteControlByDefault: space.remoteControlByDefault,
    worktreeStaleDays: space.worktreeStaleDays,
  };
}

// ---------------------------------------------------------------------------------------------
// Writers (validated, authorised, audited)
// ---------------------------------------------------------------------------------------------

/** French labels used in audit summaries (« réglages de l'espace modifiés : attente d'une autorisation »). */
const LABELS: Record<string, string> = {
  webSessionIdleHours: 'expiration après inactivité',
  webSessionMaxDays: 'durée maximale des accès',
  invitationTtlHours: 'validité des invitations',
  forceBlockBypassPermissions: 'blocage imposé du mode sans autorisation',
  name: 'nom du serveur',
  location: 'emplacement du serveur',
  maxConcurrentSessions: 'sessions parallèles',
  sessionMemoryLimitMb: 'mémoire par session',
  defaultModel: 'modèle par défaut',
  defaultEffort: 'effort par défaut',
  defaultPermissionMode: 'mode de permission',
  blockBypassPermissions: 'blocage du mode sans autorisation',
  permissionWaitSeconds: 'délai de réponse aux autorisations',
  remoteControlByDefault: 'Remote Control par défaut',
  worktreeStaleDays: 'worktrees inactifs',
  theme: 'thème',
  locale: 'langue',
  gitAuthorName: 'nom Git',
  gitAuthorEmail: 'e-mail Git',
};

function parsePatch<S extends z.ZodObject>(schema: S, patch: unknown): Partial<z.infer<S>> {
  const parsed = schema.partial().strict().safeParse(patch ?? {});
  if (!parsed.success) throw new AppError('VALIDATION', 'Réglages invalides.', { detail: formatZodIssues(parsed.error) });
  return parsed.data as Partial<z.infer<S>>;
}

function diff<T extends object>(current: T, patch: Partial<T>): Partial<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => value !== undefined && current[key as keyof T] !== value),
  ) as Partial<T>;
}

function changeLog<T extends object>(current: T, changes: Partial<T>): Record<string, { from: unknown; to: unknown }> {
  return Object.fromEntries(Object.keys(changes).map((key) => [key, { from: current[key as keyof T], to: changes[key as keyof T] }]));
}

const labelsOf = (keys: string[]): string => keys.map((key) => LABELS[key] ?? key).join(', ');

interface Applied<T> {
  value: T;
  changed: string[];
}

/** Role of `userId` in a live (not archived) space; null when not a member (or unknown space). */
async function spaceRoleOf(spaceId: string, userId: string): Promise<SpaceRole | null> {
  if (!isUuid(spaceId) || !userId) return null;
  const [row] = await db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId))
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId), isNull(spaces.archivedAt)))
    .limit(1);
  return row?.role ?? null;
}

async function requireSpaceOwner(spaceId: string, userId: string): Promise<void> {
  const role = await spaceRoleOf(spaceId, userId);
  if (!role) throw new AppError('NOT_FOUND');
  if (role !== 'owner') throw new AppError('FORBIDDEN', FORBIDDEN_SPACE_OWNER);
}

async function applyInstance(patch: unknown, actor: SettingsActor): Promise<Applied<InstanceSettings>> {
  if (!isInstanceAdmin(actor.role)) throw new AppError('FORBIDDEN', FORBIDDEN_ADMIN);
  const parsed = parsePatch(instanceSettingsSchema, patch);
  const current = await readInstance();
  const changes = diff(current, parsed);
  const changed = Object.keys(changes);
  if (changed.length === 0) return { value: current, changed };
  const [updated] = await db.update(appSettings).set(changes).where(eq(appSettings.id, 1)).returning(instanceColumns);
  if (!updated) throw new AppError('INTERNAL', 'Réglages introuvables.');
  invalidateSettingsCache({ kind: 'instance' });
  await audit({
    action: AUDIT_ACTIONS.instanceSettingsUpdated,
    summary: `réglages de l'instance modifiés : ${labelsOf(changed)}`,
    targetType: 'app_settings',
    targetId: '1',
    actorUserId: actor.userId,
    metadata: { scope: 'instance', changes: changeLog(current, changes) },
  });
  return { value: updated, changed };
}

/** Instance settings (owner and administrators only: FORBIDDEN « Réglage réservé aux administrateurs. »). */
export async function updateInstanceSettings(patch: Partial<InstanceSettingsInput>, actor: SettingsActor): Promise<InstanceSettings> {
  return (await applyInstance(patch, actor)).value;
}

async function applySpace(spaceId: string, patch: unknown, actor: { userId: string }): Promise<Applied<SpaceSettings>> {
  await requireSpaceOwner(spaceId, actor.userId);
  const parsed = parsePatch(spaceSettingsSchema, patch);
  const current = await readSpace(spaceId);
  if (!current) throw new AppError('NOT_FOUND');
  const changes = diff(current, parsed);
  const next = { ...current, ...changes };
  // The space's own block: same rule as before the split (the resulting row stays consistent).
  if (next.blockBypassPermissions && next.defaultPermissionMode === 'bypassPermissions') {
    throw new AppError('VALIDATION', 'Le mode sans autorisation est bloqué.', {
      detail: "Choisissez un autre mode de permission par défaut, ou levez d'abord le blocage.",
    });
  }
  // The instance block refuses asking for « bypass », but never an unrelated change of a space
  // whose stored default predates the block (the effective policy already falls back to manual).
  if (parsed.defaultPermissionMode === 'bypassPermissions' && (await readInstance()).forceBlockBypassPermissions) {
    throw new AppError('VALIDATION', 'Le mode sans autorisation est bloqué.', {
      detail: 'Un administrateur bloque le mode sans autorisation sur cette instance : choisissez un autre mode de permission par défaut.',
    });
  }
  const changed = Object.keys(changes);
  if (changed.length === 0) return { value: current, changed };
  const [updated] = await db.update(spaceSettings).set(changes).where(eq(spaceSettings.spaceId, spaceId)).returning(spaceColumns);
  if (!updated) throw new AppError('NOT_FOUND');
  invalidateSettingsCache({ kind: 'space', id: spaceId });
  await audit({
    action: AUDIT_ACTIONS.settingsUpdated,
    summary: `réglages de l'espace modifiés : ${labelsOf(changed)}`,
    targetType: 'space',
    targetId: spaceId,
    actorUserId: actor.userId,
    spaceId,
    metadata: { scope: 'space', changes: changeLog(current, changes) },
  });
  return { value: updated, changed };
}

/** Space settings (the space owner only; another space answers NOT_FOUND). */
export async function updateSpaceSettings(spaceId: string, patch: Partial<SpaceSettingsInput>, actor: { userId: string }): Promise<SpaceSettings> {
  return (await applySpace(spaceId, patch, actor)).value;
}

/** The server row, when it belongs to a space `userId` owns; NOT_FOUND / FORBIDDEN otherwise. */
async function ownedEnvironment(environmentId: string, userId: string): Promise<EnvironmentSettings> {
  const row = isUuid(environmentId) ? await readEnvironment(environmentId) : null;
  if (!row || !row.spaceId) throw new AppError('NOT_FOUND');
  await requireSpaceOwner(row.spaceId, userId);
  if (row.status === 'retired') throw new AppError('CONFLICT', RETIRED_ENVIRONMENT);
  return row;
}

function capMessage(cap: number): string {
  return `${cap} session${cap > 1 ? 's' : ''} parallèle${cap > 1 ? 's' : ''} au maximum sur ce serveur (plafond fixé par un administrateur).`;
}

async function applyEnvironmentLimits(environmentId: string, patch: unknown, actor: { userId: string }): Promise<Applied<EnvironmentSettings>> {
  const current = await ownedEnvironment(environmentId, actor.userId);
  const parsed = parsePatch(environmentLimitsSchema, patch);
  if (parsed.maxConcurrentSessions !== undefined && parsed.maxConcurrentSessions > current.maxConcurrentSessionsCap) {
    throw new AppError('VALIDATION', 'Réglages invalides.', { detail: `maxConcurrentSessions : ${capMessage(current.maxConcurrentSessionsCap)}` });
  }
  const changes = diff(current, parsed);
  const changed = Object.keys(changes);
  if (changed.length === 0) return { value: current, changed };
  // Space, status and ceiling are re-checked in the statement itself (an administrator may retire
  // the server or lower the ceiling meanwhile).
  const [updated] = await db
    .update(environments)
    .set(changes)
    .where(
      and(
        eq(environments.id, environmentId),
        eq(environments.spaceId, current.spaceId!),
        ne(environments.status, 'retired'),
        changes.maxConcurrentSessions !== undefined ? gte(environments.maxConcurrentSessionsCap, changes.maxConcurrentSessions) : undefined,
      ),
    )
    .returning(environmentColumns);
  if (!updated) {
    const fresh = await readEnvironment(environmentId);
    if (!fresh || fresh.spaceId !== current.spaceId) throw new AppError('NOT_FOUND');
    if (fresh.status === 'retired') throw new AppError('CONFLICT', RETIRED_ENVIRONMENT);
    throw new AppError('VALIDATION', 'Réglages invalides.', { detail: `maxConcurrentSessions : ${capMessage(fresh.maxConcurrentSessionsCap)}` });
  }
  invalidateSettingsCache({ kind: 'environment', id: environmentId });
  await audit({
    action: AUDIT_ACTIONS.settingsUpdated,
    summary: `réglages du serveur « ${current.name} » modifiés : ${labelsOf(changed)}`,
    targetType: 'environment',
    targetId: environmentId,
    actorUserId: actor.userId,
    spaceId: current.spaceId,
    environmentId,
    metadata: { scope: 'environment', changes: changeLog(current, changes) },
  });
  return { value: updated, changed };
}

/**
 * Parallel sessions and memory per session of a server (owner of its space; never above the
 * administrator's ceiling `max_concurrent_sessions_cap`).
 */
export async function updateEnvironmentLimits(
  environmentId: string,
  patch: Partial<EnvironmentLimitsInput>,
  actor: { userId: string },
): Promise<EnvironmentSettings> {
  return (await applyEnvironmentLimits(environmentId, patch, actor)).value;
}

async function applyEnvironmentIdentity(environmentId: string, patch: unknown, actor: SettingsActor): Promise<Applied<EnvironmentSettings>> {
  if (!isInstanceAdmin(actor.role)) throw new AppError('FORBIDDEN', FORBIDDEN_ADMIN);
  const current = isUuid(environmentId) ? await readEnvironment(environmentId) : null;
  if (!current) throw new AppError('NOT_FOUND');
  const parsed = parsePatch(environmentIdentitySchema, patch);
  const changes = diff(current, parsed);
  const changed = Object.keys(changes);
  if (changed.length === 0) return { value: current, changed };
  const [updated] = await db.update(environments).set(changes).where(eq(environments.id, environmentId)).returning(environmentColumns);
  if (!updated) throw new AppError('NOT_FOUND');
  invalidateSettingsCache({ kind: 'environment', id: environmentId });
  await audit({
    action: AUDIT_ACTIONS.environmentUpdated,
    summary: `serveur « ${updated.name} » modifié : ${labelsOf(changed)}`,
    targetType: 'environment',
    targetId: environmentId,
    actorUserId: actor.userId,
    spaceId: current.spaceId,
    environmentId,
    metadata: { scope: 'environment', changes: changeLog(current, changes) },
  });
  return { value: updated, changed };
}

/** Name and location of a server (owner and administrators only). */
export async function updateEnvironmentIdentity(
  environmentId: string,
  patch: Partial<EnvironmentIdentityInput>,
  actor: SettingsActor,
): Promise<EnvironmentSettings> {
  return (await applyEnvironmentIdentity(environmentId, patch, actor)).value;
}

async function applyUser(userId: string, patch: unknown): Promise<Applied<UserPreferences>> {
  const parsed = parsePatch(userPreferencesSchema, patch);
  const current = userId ? await readUser(userId) : null;
  if (!current) throw new AppError('NOT_FOUND');
  const changes = diff(current, parsed);
  const changed = Object.keys(changes);
  if (changed.length === 0) return { value: current, changed };
  const [updated] = await db.update(userPreferences).set(changes).where(eq(userPreferences.userId, userId)).returning(userColumns);
  if (!updated) throw new AppError('NOT_FOUND');
  invalidateSettingsCache({ kind: 'user', id: userId });
  await audit({
    action: AUDIT_ACTIONS.settingsUpdated,
    summary: `préférences modifiées : ${labelsOf(changed)}`,
    targetType: 'user',
    targetId: userId,
    actorUserId: userId,
    subjectUserId: userId,
    metadata: { scope: 'user', changes: changeLog(current, changes) },
  });
  return { value: updated, changed };
}

/** The signed-in account's own preferences (pass `ctx.user.id`). */
export async function updateUserPreferences(userId: string, patch: Partial<UserPreferencesInput>): Promise<UserPreferences> {
  return (await applyUser(userId, patch)).value;
}

// ---------------------------------------------------------------------------------------------
// Flat keys of PATCH /api/settings (Paramètres forms): routed to their scope
// ---------------------------------------------------------------------------------------------

type FlatGroup = 'instance' | 'environmentIdentity' | 'environmentLimits' | 'space' | 'user' | 'ignored';

/** Today's flat keys → scope (and the column name inside it). */
export const FLAT_SETTING_KEYS = {
  webSessionIdleHours: { group: 'instance', field: 'webSessionIdleHours' },
  webSessionMaxDays: { group: 'instance', field: 'webSessionMaxDays' },
  invitationTtlHours: { group: 'instance', field: 'invitationTtlHours' },
  forceBlockBypassPermissions: { group: 'instance', field: 'forceBlockBypassPermissions' },
  serverName: { group: 'environmentIdentity', field: 'name' },
  serverLocation: { group: 'environmentIdentity', field: 'location' },
  maxConcurrentSessions: { group: 'environmentLimits', field: 'maxConcurrentSessions' },
  sessionMemoryLimitMb: { group: 'environmentLimits', field: 'sessionMemoryLimitMb' },
  defaultModel: { group: 'space', field: 'defaultModel' },
  defaultEffort: { group: 'space', field: 'defaultEffort' },
  defaultPermissionMode: { group: 'space', field: 'defaultPermissionMode' },
  blockBypassPermissions: { group: 'space', field: 'blockBypassPermissions' },
  permissionWaitSeconds: { group: 'space', field: 'permissionWaitSeconds' },
  remoteControlByDefault: { group: 'space', field: 'remoteControlByDefault' },
  worktreeStaleDays: { group: 'space', field: 'worktreeStaleDays' },
  theme: { group: 'user', field: 'theme' },
  locale: { group: 'user', field: 'locale' },
  gitAuthorName: { group: 'user', field: 'gitAuthorName' },
  gitAuthorEmail: { group: 'user', field: 'gitAuthorEmail' },
  projectsRoot: { group: 'ignored', field: 'projectsRoot' },
} as const satisfies Record<string, { group: FlatGroup; field: string }>;

export type FlatSettingKey = keyof typeof FLAT_SETTING_KEYS;

const GROUP_SCHEMAS: Record<Exclude<FlatGroup, 'ignored'>, z.ZodObject> = {
  instance: instanceSettingsSchema,
  environmentIdentity: environmentIdentitySchema,
  environmentLimits: environmentLimitsSchema,
  space: spaceSettingsSchema,
  user: userPreferencesSchema,
};

/** The context of the request (`ctx.user.id`, `ctx.user.role`, `ctx.space.id`, `ctx.environment?.id`). */
export interface SettingsPatchActor extends SettingsActor {
  spaceId: string;
  environmentId: string | null;
}

export type SettingKeyResult =
  | { status: 'updated' }
  | { status: 'unchanged' }
  | { status: 'ignored'; message: string }
  | { status: 'refused'; code: AppErrorCode; message: string; detail?: string };

export interface ApplySettingsResult {
  /** One entry per key of the patch. */
  results: Partial<Record<FlatSettingKey, SettingKeyResult>>;
  /** Keys whose value changed. */
  updated: FlatSettingKey[];
  /** First refusal (FORBIDDEN, NOT_FOUND, CONFLICT…), for the HTTP answer; null when every key went through. */
  error: AppError | null;
}

const flatPatchSchema = z.record(z.string(), z.unknown(), 'objet de réglages attendu');

/**
 * Applies today's flat settings patch, each key in its scope: the instance keys and the server's
 * name/location need an administrator, the space keys the space owner, the server limits the owner
 * of the server's space, the preferences are the account's own. `projectsRoot` is ignored (no
 * effect: each runner uses NUERA_PROJECTS_ROOT). Nothing is written when a key is unknown or a value
 * invalid (VALIDATION thrown); otherwise each scope is applied on its own and a refused scope does
 * not stop the others. Every change is audited with its scope.
 */
export async function applySettingsPatch(actor: SettingsPatchActor, flatPatch: unknown): Promise<ApplySettingsResult> {
  const parsedPatch = flatPatchSchema.safeParse(flatPatch);
  if (!parsedPatch.success) throw new AppError('VALIDATION', 'Réglages invalides.', { detail: formatZodIssues(parsedPatch.error) });
  const entries = Object.entries(parsedPatch.data).filter(([, value]) => value !== undefined);
  if (entries.length === 0) throw new AppError('VALIDATION', 'Réglages invalides.', { detail: 'aucun réglage à modifier' });

  // 1. Every key known and every value valid, or nothing is written.
  const problems: string[] = [];
  const groups = new Map<FlatGroup, Array<{ key: FlatSettingKey; field: string; value: unknown }>>();
  for (const [key, value] of entries) {
    const route = (FLAT_SETTING_KEYS as Record<string, { group: FlatGroup; field: string }>)[key];
    if (!route) {
      problems.push(`${key} : réglage inconnu`);
      continue;
    }
    if (route.group !== 'ignored') {
      const fieldSchema = GROUP_SCHEMAS[route.group].shape[route.field] as z.ZodType;
      const checked = fieldSchema.safeParse(value);
      if (!checked.success) problems.push(`${key} : ${checked.error.issues[0]?.message ?? 'valeur invalide'}`);
    }
    groups.set(route.group, [...(groups.get(route.group) ?? []), { key: key as FlatSettingKey, field: route.field, value }]);
  }
  if (problems.length) throw new AppError('VALIDATION', 'Réglages invalides.', { detail: problems.slice(0, 6).join(' ; ') });

  // 2. Each scope on its own (instance first: the forced block constrains the space settings).
  const results: Partial<Record<FlatSettingKey, SettingKeyResult>> = {};
  const updated: FlatSettingKey[] = [];
  let error: AppError | null = null;
  const order: FlatGroup[] = ['instance', 'environmentIdentity', 'environmentLimits', 'space', 'user', 'ignored'];
  for (const group of order) {
    const items = groups.get(group);
    if (!items?.length) continue;
    if (group === 'ignored') {
      for (const item of items) results[item.key] = { status: 'ignored', message: PROJECTS_ROOT_IGNORED };
      continue;
    }
    const patch = Object.fromEntries(items.map((item) => [item.field, item.value]));
    try {
      const applied = await applyGroup(group, actor, patch);
      for (const item of items) {
        const changed = applied.includes(item.field);
        results[item.key] = { status: changed ? 'updated' : 'unchanged' };
        if (changed) updated.push(item.key);
      }
    } catch (failure) {
      if (!(failure instanceof AppError)) throw failure;
      error ??= failure;
      for (const item of items) {
        results[item.key] = {
          status: 'refused',
          code: failure.code,
          message: failure.message,
          ...(failure.detail ? { detail: failure.detail } : {}),
        };
      }
    }
  }
  return { results, updated, error };
}

async function applyGroup(group: Exclude<FlatGroup, 'ignored'>, actor: SettingsPatchActor, patch: Record<string, unknown>): Promise<string[]> {
  switch (group) {
    case 'instance':
      return (await applyInstance(patch, actor)).changed;
    case 'environmentIdentity':
      if (!isInstanceAdmin(actor.role)) throw new AppError('FORBIDDEN', FORBIDDEN_ADMIN);
      if (!actor.environmentId) throw new AppError('CONFLICT', NO_ENVIRONMENT);
      return (await applyEnvironmentIdentity(actor.environmentId, patch, actor)).changed;
    case 'environmentLimits':
      if (!actor.environmentId) throw new AppError('CONFLICT', NO_ENVIRONMENT);
      return (await applyEnvironmentLimits(actor.environmentId, patch, actor)).changed;
    case 'space':
      return (await applySpace(actor.spaceId, patch, actor)).changed;
    case 'user':
      return (await applyUser(actor.userId, patch)).changed;
  }
}

// ---------------------------------------------------------------------------------------------
// Everything Paramètres shows, with what this account may change
// ---------------------------------------------------------------------------------------------

export interface SettingsView {
  instance: InstanceSettings;
  space: SpaceSettings;
  /** null when no server is assigned to the space yet. */
  environment: EnvironmentSettings | null;
  user: UserPreferences;
  effective: EffectiveSessionPolicy;
  /** Keys this account may change (false: read-only « Réglé par un administrateur »). */
  editable: Record<Exclude<FlatSettingKey, 'projectsRoot'>, boolean>;
}

export async function getSettingsView(actor: SettingsPatchActor): Promise<SettingsView> {
  const [instance, space, environment, preferences, spaceRole] = await Promise.all([
    getInstanceSettings(),
    getSpaceSettings(actor.spaceId),
    actor.environmentId ? getEnvironmentSettings(actor.environmentId) : Promise.resolve(null),
    getUserPreferences(actor.userId),
    spaceRoleOf(actor.spaceId, actor.userId),
  ]);
  if (!space || !spaceRole || !preferences) throw new AppError('NOT_FOUND');
  // A server of another space is « no server » for this account.
  const ownServer = environment && environment.spaceId === actor.spaceId ? environment : null;
  const admin = isInstanceAdmin(actor.role);
  const spaceOwner = spaceRole === 'owner';
  const limits = spaceOwner && ownServer !== null && ownServer.status !== 'retired';
  const editable = {} as SettingsView['editable'];
  for (const [key, route] of Object.entries(FLAT_SETTING_KEYS) as Array<[FlatSettingKey, { group: FlatGroup }]>) {
    if (key === 'projectsRoot') continue;
    editable[key] =
      route.group === 'instance'
        ? admin
        : route.group === 'environmentIdentity'
          ? admin && ownServer !== null
          : route.group === 'environmentLimits'
            ? limits
            : route.group === 'space'
              ? spaceOwner && !(key === 'blockBypassPermissions' && instance.forceBlockBypassPermissions)
              : true;
  }
  return {
    instance,
    space,
    environment: ownServer,
    user: preferences,
    effective: await getEffectiveSessionPolicy(actor.spaceId),
    editable,
  };
}
