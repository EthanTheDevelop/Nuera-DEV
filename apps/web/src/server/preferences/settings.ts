import 'server-only';
import { z } from 'zod';
import type { SettingKey, SettingsValues } from '@/features/settings/lib/types';
import type { AppError } from '@/server/errors';
import {
  applySettingsPatch,
  getSettingsView,
  type FlatSettingKey,
  type SettingKeyResult,
  type SettingsPatchActor,
  type SettingsView,
} from '@/server/settings';
import { invalidateRunnerEndpoint } from '@/server/runner/client';
import { invalidateContextCache, type RequestContext } from '@/server/tenancy/context';

/**
 * Paramètres ⇄ the scoped settings of `@/server/settings` (docs/MULTICOMPTE.md §8). The page keeps
 * its flat keys (`SettingsValues`); each key is read from and written to its own scope:
 *
 *   const values = await getSettingsValues(ctx);                 // + `editable` per key
 *   const { values, refused } = await updateSettings(ctx, { defaultPermissionMode: 'acceptEdits' });
 *
 * Only the account's own space, server (the one of `ctx`) and preferences are ever touched. A key
 * the account may not change is refused (« Réglage réservé aux administrateurs. »), never written.
 */

/** Body of PATCH /api/settings: flat keys, validated per scope by `applySettingsPatch`. */
export const settingsPatchSchema = z
  .record(z.string(), z.unknown(), 'objet de réglages attendu')
  .refine((patch) => Object.keys(patch).length > 0, 'aucun réglage à modifier');

export type SettingsPatch = Partial<Record<SettingKey, unknown>>;

/** Compile-time check: the page's keys are exactly the server's (projectsRoot aside). */
type ServerKeys = Exclude<FlatSettingKey, 'projectsRoot'>;
const SAME_KEYS: [ServerKeys] extends [SettingKey] ? ([SettingKey] extends [ServerKeys] ? true : never) : never = true;
void SAME_KEYS;

export function settingsActor(ctx: Pick<RequestContext, 'user' | 'space' | 'environment'>): SettingsPatchActor {
  return { userId: ctx.user.id, role: ctx.user.role, spaceId: ctx.space.id, environmentId: ctx.environment?.id ?? null };
}

export function toSettingsValues(view: SettingsView): SettingsValues {
  const latest = [view.instance.updatedAt, view.space.updatedAt, view.user.updatedAt, view.environment?.updatedAt]
    .filter((date): date is Date => date instanceof Date)
    .reduce((a, b) => (a.getTime() >= b.getTime() ? a : b));
  return {
    webSessionIdleHours: view.instance.webSessionIdleHours,
    webSessionMaxDays: view.instance.webSessionMaxDays,
    invitationTtlHours: view.instance.invitationTtlHours,
    forceBlockBypassPermissions: view.instance.forceBlockBypassPermissions,
    serverName: view.environment?.name ?? null,
    serverLocation: view.environment?.location ?? null,
    maxConcurrentSessions: view.environment?.maxConcurrentSessions ?? null,
    maxConcurrentSessionsCap: view.environment?.maxConcurrentSessionsCap ?? null,
    sessionMemoryLimitMb: view.environment?.sessionMemoryLimitMb ?? null,
    serverAccounts: view.serverAccess?.accounts ?? null,
    serverPrimary: view.serverAccess?.primary ?? null,
    // « Imposé » by the common configuration: the instance's model, read-only.
    defaultModel: view.effective.modelLockedByInstance ? view.effective.defaultModel : view.space.defaultModel,
    defaultEffort: view.space.defaultEffort,
    defaultPermissionMode: view.space.defaultPermissionMode,
    blockBypassPermissions: view.space.blockBypassPermissions,
    permissionWaitSeconds: view.space.permissionWaitSeconds,
    remoteControlByDefault: view.space.remoteControlByDefault,
    worktreeStaleDays: view.space.worktreeStaleDays,
    autoResumeAfterLimit: view.space.autoResumeAfterLimit,
    autoResumeInstruction: view.space.autoResumeInstruction,
    theme: view.user.theme,
    locale: view.user.locale,
    gitAuthorName: view.user.gitAuthorName,
    gitAuthorEmail: view.user.gitAuthorEmail,
    editable: { ...view.editable },
    updatedAt: latest.toISOString(),
  };
}

export async function getSettingsValues(ctx: Pick<RequestContext, 'user' | 'space' | 'environment'>): Promise<SettingsValues> {
  return toSettingsValues(await getSettingsView(settingsActor(ctx)));
}

export interface UpdateSettingsResult {
  values: SettingsValues;
  /** One entry per key of the patch (`updated`, `unchanged`, `ignored`, `refused`). */
  results: Partial<Record<FlatSettingKey, SettingKeyResult>>;
  /** First refusal when part of the patch went through (null otherwise). */
  refused: AppError | null;
}

const SERVER_KEYS: readonly string[] = ['serverName', 'serverLocation', 'maxConcurrentSessions'];

/**
 * Applies a flat patch, each key in its scope (validated, authorised and audited by
 * `applySettingsPatch`). Nothing went through → the refusal is thrown (VALIDATION 422, FORBIDDEN
 * 403 « Réglage réservé aux administrateurs. », CONFLICT 409 without a server…).
 */
export async function updateSettings(ctx: Pick<RequestContext, 'user' | 'space' | 'environment'>, patch: unknown): Promise<UpdateSettingsResult> {
  const result = await applySettingsPatch(settingsActor(ctx), patch);
  if (result.error && result.updated.length === 0) throw result.error;
  // The shell reads the server's name and capacity from the request context (cached 5 s), the runner
  // client its name for « {nom} ne répond pas » (cached 30 s).
  if (result.updated.some((key) => SERVER_KEYS.includes(key))) invalidateContextCache(ctx.user.id);
  if (ctx.environment && result.updated.includes('serverName')) invalidateRunnerEndpoint(ctx.environment.id);
  return { values: await getSettingsValues(ctx), results: result.results, refused: result.error };
}
