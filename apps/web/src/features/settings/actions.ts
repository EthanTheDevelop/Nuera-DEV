'use server';

import { cookies, headers } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { z } from 'zod';
import {
  changePassword,
  deletePasskey,
  disableTwoFactor,
  regenerateBackupCodes,
  renamePasskey,
  revokeOtherSessions,
  revokeWebSession,
} from '@/server/auth/account';
import { auth } from '@/server/auth/auth';
import { toAppError } from '@/server/errors';
import {
  getAccountView,
  getClaudeCli,
  getJournalPage,
  getLiveSessions,
  getOperationLog,
  getPasskeys,
  listOperationLogs,
  listSessionLogs,
  listStaleWorktrees,
  load,
  removeStaleWorktrees,
  updateSettings,
} from '@/server/preferences';
import { assertSameOriginHeaders } from '@/server/security/origin';
import { assertRateLimit } from '@/server/security/rate-limit';
import { requireContext } from '@/server/tenancy/context';
import { auditIn } from '@/server/tenancy/scope';
import type {
  AccountView,
  ClaudeCliView,
  JournalPage,
  LiveStatusView,
  OperationLogItem,
  PasskeyView,
  RemoveWorktreesResult,
  SessionLogItem,
  SettingsValues,
  StaleWorktreesView,
} from './lib/types';

/**
 * Server actions of Paramètres. Each one re-checks the session and resolves the request context
 * (requireContext: the signed-in account, its space, its server) and the Origin of the request;
 * nothing ever reaches another account's space or server. Errors come back as data
 * (`{ ok: false, error }`, French messages), because Next hides thrown messages in production.
 * Sensitive mutations are audited by the server modules.
 */

export type ActionError = { code: string; message: string; detail?: string; untouched?: string; raw?: string };
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

async function guard() {
  const ctx = await requireContext();
  assertSameOriginHeaders(await headers());
  return ctx;
}

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    // requireUser() redirects (expired access, pending 2FA): the redirect must reach Next untouched.
    unstable_rethrow(error);
    const appError = toAppError(error);
    if (appError.code === 'INTERNAL') console.error('[paramètres] action', error);
    return {
      ok: false,
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.detail ? { detail: appError.detail } : {}),
        ...(appError.untouched ? { untouched: appError.untouched } : {}),
        ...(appError.raw ? { raw: appError.raw } : {}),
      },
    };
  }
}

// --- Réglages ----------------------------------------------------------------------------------

/**
 * Saves flat settings, each in its scope (instance, server, space, account). A refused key (« Réglage
 * réservé aux administrateurs. »…) fails the action, even when other keys of the patch went through.
 */
export async function updateSettingsAction(patch: Record<string, unknown>): Promise<ActionResult<SettingsValues>> {
  return run(async () => {
    const ctx = await guard();
    assertRateLimit('settings:update', ctx.user.id, { limit: 60, windowMs: 60_000 });
    const result = await updateSettings(ctx, patch);
    if (result.refused) throw result.refused;
    return result.values;
  });
}

// --- Claude Code -------------------------------------------------------------------------------

export async function refreshClaudeStatusAction(): Promise<ActionResult<ClaudeCliView>> {
  return run(async () => {
    const ctx = await guard();
    assertRateLimit('settings:claude-status', ctx.user.id, { limit: 20, windowMs: 60_000 });
    return getClaudeCli(ctx, { refresh: true });
  });
}

// --- Compte et sécurité ------------------------------------------------------------------------

export async function loadAccountAction(): Promise<ActionResult<AccountView>> {
  return run(async () => {
    await guard();
    return getAccountView();
  });
}

const idSchema = z.string().trim().min(1).max(200);

export async function revokeWebSessionAction(id: string): Promise<ActionResult<{ revoked: true }>> {
  return run(async () => {
    await guard();
    await revokeWebSession(idSchema.parse(id));
    return { revoked: true as const };
  });
}

export async function revokeOtherSessionsAction(): Promise<ActionResult<{ revoked: number }>> {
  return run(async () => {
    await guard();
    return revokeOtherSessions();
  });
}

export async function regenerateBackupCodesAction(password: string): Promise<ActionResult<{ codes: string[] }>> {
  return run(async () => {
    await guard();
    return regenerateBackupCodes({ password: typeof password === 'string' ? password : '' });
  });
}

export async function disableTwoFactorAction(password: string): Promise<ActionResult<{ disabled: true }>> {
  return run(async () => {
    await guard();
    return disableTwoFactor({ password: typeof password === 'string' ? password : '' });
  });
}

export async function renamePasskeyAction(id: string, name: string): Promise<ActionResult<PasskeyView[]>> {
  return run(async () => {
    const ctx = await guard();
    await renamePasskey(idSchema.parse(id), typeof name === 'string' ? name : '');
    await auditIn(ctx, { action: 'auth.passkey_renamed', summary: `clé d'accès renommée : ${String(name).trim().slice(0, 60)}`, targetType: 'passkey', targetId: id, environmentId: null });
    return getPasskeys();
  });
}

export async function deletePasskeyAction(id: string): Promise<ActionResult<PasskeyView[]>> {
  return run(async () => {
    await guard();
    await deletePasskey(idSchema.parse(id));
    return getPasskeys();
  });
}

export async function loadPasskeysAction(): Promise<ActionResult<PasskeyView[]>> {
  return run(async () => {
    await guard();
    return getPasskeys();
  });
}

const changePasswordSchema = z.object({
  currentPassword: z.string().max(256),
  newPassword: z.string().max(256),
  revokeOtherSessions: z.boolean().optional(),
});

export async function changePasswordAction(input: z.input<typeof changePasswordSchema>): Promise<ActionResult<{ changed: true }>> {
  return run(async () => {
    await guard();
    await changePassword(changePasswordSchema.parse(input));
    return { changed: true as const };
  });
}

export async function loadJournalAction(before?: number): Promise<ActionResult<JournalPage>> {
  return run(async () => {
    const ctx = await guard();
    const cursor = z.number().int().positive().optional().parse(before);
    return getJournalPage(ctx, { limit: 20, ...(cursor ? { before: cursor } : {}) });
  });
}

/**
 * « Se reconnecter » before adding a passkey (a session older than 1 h is refused: SESSION_NOT_FRESH):
 * closes this access and comes back to Compte et sécurité after the sign-in.
 */
export async function reauthenticateAction(): Promise<void> {
  await guard();
  const requestHeaders = await headers();
  try {
    await auth.api.signOut({ headers: requestHeaders });
  } catch {
    const jar = await cookies();
    for (const { name } of jar.getAll()) {
      if (/^(__Secure-)?nuera\.(session_token|session_data|dont_remember|two_factor)$/.test(name)) jar.delete(name);
    }
  }
  redirect(`/connexion?suivant=${encodeURIComponent('/parametres?onglet=compte-et-securite')}`);
}

// --- Serveur / maintenance ---------------------------------------------------------------------

/**
 * The part of the page a session status change moves (live Claude processes of the « Services »
 * list, eligibility of the inactive worktrees): re-read on `session.status` instead of the page.
 */
export async function loadLiveStatusAction(): Promise<ActionResult<LiveStatusView>> {
  return run(async () => {
    const ctx = await guard();
    assertRateLimit('settings:live-status', ctx.user.id, { limit: 60, windowMs: 60_000 });
    const [liveSessions, worktrees] = await Promise.all([load(() => getLiveSessions(ctx)), load(() => listStaleWorktrees(ctx))]);
    return { liveSessions, worktrees };
  });
}

export async function loadStaleWorktreesAction(): Promise<ActionResult<StaleWorktreesView>> {
  return run(async () => {
    const ctx = await guard();
    assertRateLimit('settings:worktrees', ctx.user.id, { limit: 30, windowMs: 60_000 });
    return listStaleWorktrees(ctx);
  });
}

export async function removeStaleWorktreesAction(ids: string[]): Promise<ActionResult<RemoveWorktreesResult>> {
  return run(async () => {
    const ctx = await guard();
    assertRateLimit('settings:worktrees-remove', ctx.user.id, { limit: 10, windowMs: 60_000 });
    return removeStaleWorktrees(ctx, { ids });
  });
}

export async function loadLogsAction(): Promise<ActionResult<{ operations: OperationLogItem[]; sessions: SessionLogItem[] }>> {
  return run(async () => {
    const ctx = await guard();
    const [operations, sessions] = await Promise.all([listOperationLogs(ctx, 40), listSessionLogs(ctx, 40)]);
    return { operations, sessions };
  });
}

export async function loadOperationLogAction(id: string): Promise<ActionResult<{ log: string; raw: string | null }>> {
  return run(async () => {
    const ctx = await guard();
    return getOperationLog(ctx, id);
  });
}
