import 'server-only';
import type { AccountView, JournalPage, PasskeyView, WebSessionView } from '@/features/settings/lib/types';
import { getTwoFactorSummary, listPasskeys, listSecurityJournal, listWebSessions } from '@/server/auth/account';
import { iso } from './load';

/**
 * Compte et sécurité: serializable views over `@/server/auth/account` (which re-checks the owner
 * session for every call and audits mutations).
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
    twoFactor: { enabled: twoFactor.enabled, backupCodesRemaining: twoFactor.backupCodesRemaining },
    passkeys,
    sessions,
  };
}

export async function getJournalPage(options: { limit?: number; before?: number } = {}): Promise<JournalPage> {
  const page = await listSecurityJournal({ limit: options.limit ?? 20, ...(options.before ? { before: options.before } : {}) });
  return {
    items: page.items.map((item) => ({ id: item.id, at: item.createdAt.toISOString(), summary: item.summary, action: item.action })),
    nextCursor: page.nextCursor,
  };
}
