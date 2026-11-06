import 'server-only';
import type { AccountView, JournalPage, PasskeyView, WebSessionView } from '@/features/settings/lib/types';
import { getTwoFactorSummary, listPasskeys, listWebSessions } from '@/server/auth/account';
import { listUserJournal } from '@/server/security/audit';
import type { RequestContext } from '@/server/tenancy/context';
import { iso } from './load';

/**
 * Compte et sécurité: serializable views over `@/server/auth/account` (which re-checks the signed-in
 * account for every call and audits mutations) — always the signed-in account only.
 */

export async function getWebSessions(): Promise<WebSessionView[]> {
  const items = await listWebSessions();
  return items.map((item) => ({
    id: item.id,
    deviceLabel: item.deviceLabel,
    deviceKind: item.deviceKind,
    location: item.location,
    current: item.current,
    createdAt: item.createdAt.toISOString(),
    lastActiveAt: item.lastActiveAt.toISOString(),
    expiresAt: item.expiresAt.toISOString(),
  }));
}

export async function getPasskeys(): Promise<PasskeyView[]> {
  const items = await listPasskeys();
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    provider: item.provider,
    createdAt: iso(item.createdAt),
    deviceType: item.deviceType,
    backedUp: item.backedUp,
  }));
}

export async function getAccountView(): Promise<AccountView> {
  const [twoFactor, passkeys, sessions] = await Promise.all([getTwoFactorSummary(), getPasskeys(), getWebSessions()]);
  return {
    twoFactor: { enabled: twoFactor.enabled, backupCodesRemaining: twoFactor.backupCodesRemaining, required: twoFactor.required },
    passkeys,
    sessions,
  };
}

/**
 * Personal journal (docs/MULTICOMPTE.md §9): my `auth.*` / `settings.*` / `security.*` events, the
 * administrators' actions on my account, the authorisation and integration events of my space —
 * never another account's or another space's. An entry written by another account carries its frozen
 * label (`by`, the administrator's e-mail).
 */
export async function getJournalPage(
  ctx: Pick<RequestContext, 'user' | 'space'>,
  options: { limit?: number; before?: number } = {},
): Promise<JournalPage> {
  const page = await listUserJournal({
    userId: ctx.user.id,
    spaceIds: [ctx.space.id],
    limit: options.limit ?? 20,
    ...(options.before ? { before: options.before } : {}),
  });
  return {
    items: page.items.map((item) => ({
      id: item.id,
      at: item.createdAt.toISOString(),
      summary: item.summary,
      action: item.action,
      by: item.actorKind === 'user' && item.actorUserId && item.actorUserId !== ctx.user.id ? (item.actorLabel ?? 'un administrateur') : null,
    })),
    nextCursor: page.nextCursor,
  };
}
