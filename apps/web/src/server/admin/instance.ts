import 'server-only';
import { environments } from '@nuera/db/schema';
import { and, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { AppError, formatZodIssues } from '@/server/errors';
import { listInstanceJournal } from '@/server/security/audit';
import {
  applySettingsPatch,
  FLAT_SETTING_KEYS,
  getInstanceSettings,
  type InstanceSettings,
  type SettingKeyResult,
} from '@/server/settings';
import { resolveContext } from '@/server/tenancy/context';
import type { CurrentUser } from '@/server/auth/session';
import { assertAdmin, assertAdminMutation, type AdminActor } from './common';
import { assessRestrictedAccess } from './db-access';
import { fullDatabaseWarning } from './servers';

/**
 * Administration › Instance and › Journal (docs/MULTICOMPTE.md §8, §9): the instance settings
 * (web-session policy, validity of the invitations, forced block of the bypass mode), written through
 * the flat settings patch of server/settings.ts (instance keys only), and the instance journal
 * (`auth.*`, `admin.*`, `environment.*`, `instance.*`, `security.*` of every account — never a Git,
 * project, session or terminal event; IP addresses are visible to administrators, as Paramètres says).
 */

export const INSTANCE_KEYS = [
  'webSessionIdleHours',
  'webSessionMaxDays',
  'invitationTtlHours',
  'forceBlockBypassPermissions',
] as const;
export type InstanceKey = (typeof INSTANCE_KEYS)[number];

export interface InstanceView {
  settings: InstanceSettings;
  /** « Le serveur VPS-3 accède encore à toute la base de données. » while the default server is unrestricted. */
  warning: string | null;
}

export async function getInstanceView(actor: AdminActor): Promise<InstanceView> {
  assertAdmin(actor);
  const settings = await getInstanceSettings();
  const [server] = await db
    .select({
      id: environments.id,
      name: environments.name,
      isDefault: environments.isDefault,
      dbRole: environments.dbRole,
      capabilities: environments.capabilities,
    })
    .from(environments)
    .where(and(eq(environments.isDefault, true), ne(environments.status, 'retired')))
    .limit(1);
  // The heartbeat alone is never trusted (a runner with the full DSN can write it): db-access.ts.
  const restricted = server
    ? (await assessRestrictedAccess([server])).get(server.id) === true
    : false;
  return { settings, warning: server && !restricted ? fullDatabaseWarning(server.name) : null };
}

export const instancePatchSchema = z
  .object({
    webSessionIdleHours: z.unknown().optional(),
    webSessionMaxDays: z.unknown().optional(),
    invitationTtlHours: z.unknown().optional(),
    forceBlockBypassPermissions: z.unknown().optional(),
  })
  .strict();

/**
 * Applies instance keys only (validated and audited by applySettingsPatch, `instance.settings_updated`).
 * VALIDATION for any other key or an invalid value; the first refusal is thrown.
 */
export async function updateInstance(
  actor: CurrentUser,
  patch: unknown,
): Promise<{
  view: InstanceView;
  results: Partial<Record<keyof typeof FLAT_SETTING_KEYS, SettingKeyResult>>;
}> {
  assertAdminMutation(actor);
  const parsed = instancePatchSchema.safeParse(patch);
  if (!parsed.success)
    throw new AppError('VALIDATION', 'Réglages invalides.', {
      detail: formatZodIssues(parsed.error),
    });
  const ctx = await resolveContext(actor);
  const applied = await applySettingsPatch(
    {
      userId: actor.id,
      role: actor.role,
      spaceId: ctx.space.id,
      environmentId: ctx.environment?.id ?? null,
    },
    parsed.data,
  );
  if (applied.error) throw applied.error;
  return { view: await getInstanceView(actor), results: applied.results };
}

export interface InstanceJournalEntry {
  id: number;
  at: string;
  action: string;
  summary: string;
  /** E-mail of the author when the event was written (null: Nuera Dev itself). */
  actor: string | null;
  ip: string | null;
}

export const journalQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  userId: z.string().trim().min(1).max(200).optional(),
});

export async function getInstanceJournal(
  actor: AdminActor,
  options: z.input<typeof journalQuerySchema> = {},
): Promise<{ items: InstanceJournalEntry[]; nextCursor: number | null }> {
  assertAdmin(actor);
  const query = journalQuerySchema.parse(options);
  const page = await listInstanceJournal({
    limit: query.limit ?? 50,
    ...(query.before ? { before: query.before } : {}),
    ...(query.userId ? { userId: query.userId } : {}),
  });
  return {
    items: page.items.map((item) => ({
      id: item.id,
      at: item.createdAt.toISOString(),
      action: item.action,
      summary: item.summary,
      actor: item.actorLabel,
      ip: item.ip,
    })),
    nextCursor: page.nextCursor,
  };
}
