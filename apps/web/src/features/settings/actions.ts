'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import {
  changePassword,
  deletePasskey,
  regenerateBackupCodes,
  renamePasskey,
  revokeOtherSessions,
  revokeWebSession,
} from '@/server/auth/account';
import { auth } from '@/server/auth/auth';
import { requireUser } from '@/server/auth/session';
import { toAppError } from '@/server/errors';
import {
  getAccountView,
  getClaudeCli,
  getJournalPage,
  getOperationLog,
  getPasskeys,
  listOperationLogs,
  listSessionLogs,
  listStaleWorktrees,
  removeStaleWorktrees,
  updateSettings,
} from '@/server/preferences';
import { audit } from '@/server/security/audit';
import { assertSameOriginHeaders } from '@/server/security/origin';
import { assertRateLimit } from '@/server/security/rate-limit';
import type {
  AccountView,
  ClaudeCliView,
  JournalPage,
  OperationLogItem,
  PasskeyView,
  RemoveWorktreesResult,
  SessionLogItem,
  SettingsValues,
  StaleWorktreesView,
} from './lib/types';

/**
 * Server actions of Paramètres. Each one re-checks the owner session (requireUser) and the Origin of
 * the request; errors come back as data (`{ ok: false, error }`, French messages), because Next
 * hides thrown messages in production. Sensitive mutations are audited by the server modules.
 */

export type ActionError = { code: string; message: string; detail?: string; untouched?: string; raw?: string };
export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: ActionError };

async function guard() {
  const user = await requireUser();
  assertSameOriginHeaders(await headers());
  return user;
}

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
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

export async function updateSettingsAction(patch: Record<string, unknown>): Promise<ActionResult<SettingsValues>> {
  return run(async () => {
    const user = await guard();
    assertRateLimit('settings:update', user.id, { limit: 60, windowMs: 60_000 });
    return updateSettings(patch, user);
  });
}

// --- Claude Code -------------------------------------------------------------------------------

export async function refreshClaudeStatusAction(): Promise<ActionResult<ClaudeCliView>> {
  return run(async () => {
    const user = await guard();
    assertRateLimit('settings:claude-status', user.id, { limit: 20, windowMs: 60_000 });
    return getClaudeCli({ refresh: true });
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

export async function renamePasskeyAction(id: string, name: string): Promise<ActionResult<PasskeyView[]>> {
  return run(async () => {
    const user = await guard();
    await renamePasskey(idSchema.parse(id), typeof name === 'string' ? name : '');
    await audit({ action: 'auth.passkey_renamed', summary: `clé d'accès renommée : ${String(name).trim().slice(0, 60)}`, actorUserId: user.id, targetType: 'passkey', targetId: id });
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
    await guard();
    const cursor = z.number().int().positive().optional().parse(before);
    return getJournalPage({ limit: 20, ...(cursor ? { before: cursor } : {}) });
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

export async function loadStaleWorktreesAction(): Promise<ActionResult<StaleWorktreesView>> {
  return run(async () => {
    const user = await guard();
    assertRateLimit('settings:worktrees', user.id, { limit: 30, windowMs: 60_000 });
    return listStaleWorktrees();
  });
}

export async function removeStaleWorktreesAction(ids: string[]): Promise<ActionResult<RemoveWorktreesResult>> {
  return run(async () => {
    const user = await guard();
    assertRateLimit('settings:worktrees-remove', user.id, { limit: 10, windowMs: 60_000 });
    return removeStaleWorktrees({ ids }, user);
  });
}

export async function loadLogsAction(): Promise<ActionResult<{ operations: OperationLogItem[]; sessions: SessionLogItem[] }>> {
  return run(async () => {
    await guard();
    const [operations, sessions] = await Promise.all([listOperationLogs(40), listSessionLogs(40)]);
    return { operations, sessions };
  });
}

export async function loadOperationLogAction(id: string): Promise<ActionResult<{ log: string; raw: string | null }>> {
  return run(async () => {
    await guard();
    return getOperationLog(id);
  });
}
