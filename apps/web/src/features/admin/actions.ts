'use server';

import { headers } from 'next/headers';
import { unstable_rethrow } from 'next/navigation';
import {
  assignServer,
  changeAccountRole,
  createAccountRecoveryLink,
  createInvitation,
  deleteAccount,
  disableAccount,
  enableAccount,
  getInstanceJournal,
  loadAdministration,
  registerServer,
  restrictServerDatabase,
  retireServer,
  revokeInvitation,
  rotateServerToken,
  updateInstance,
  updateServer,
  verifyServer,
  type AdministrationData,
  type CreatedInvitation,
  type DisableAccountResult,
  type InstanceJournalEntry,
  type RecoveryLinkView,
  type RegisteredServer,
  type RestrictedDatabaseAccess,
  type RotatedToken,
  type ServerVerification,
  type UpdatedServer,
} from '@/server/admin';
import { requireAdminForApi } from '@/server/auth/session';
import { toAppError } from '@/server/errors';
import { assertSameOriginHeaders } from '@/server/security/origin';

/**
 * Server actions of /administration. Each one re-checks the administrator (requireAdminForApi) and
 * the Origin; the server module re-checks the role, rate-limits and journals. Errors come back as
 * data (`{ ok: false, error }`, French messages): Next hides thrown messages in production.
 */

export type AdminActionError = {
  code: string;
  message: string;
  detail?: string;
  untouched?: string;
};
export type AdminActionResult<T> = { ok: true; data: T } | { ok: false; error: AdminActionError };

async function run<T>(
  fn: (user: Awaited<ReturnType<typeof requireAdminForApi>>) => Promise<T>,
): Promise<AdminActionResult<T>> {
  try {
    const user = await requireAdminForApi();
    assertSameOriginHeaders(await headers());
    return { ok: true, data: await fn(user) };
  } catch (error) {
    unstable_rethrow(error);
    const appError = toAppError(error);
    if (appError.code === 'INTERNAL') console.error('[administration] action', error);
    return {
      ok: false,
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.detail ? { detail: appError.detail } : {}),
        ...(appError.untouched ? { untouched: appError.untouched } : {}),
      },
    };
  }
}

export async function reloadAdministrationAction(): Promise<AdminActionResult<AdministrationData>> {
  return run((user) => loadAdministration(user));
}

export async function inviteAccountAction(input: {
  email: string;
  role: 'admin' | 'member';
  environmentId: string | null;
  validityHours: number;
}): Promise<AdminActionResult<CreatedInvitation>> {
  return run((user) => createInvitation(user, input));
}

export async function revokeInvitationAction(
  invitationId: string,
): Promise<AdminActionResult<null>> {
  return run(async (user) => {
    await revokeInvitation(user, invitationId);
    return null;
  });
}

export async function changeRoleAction(
  userId: string,
  role: 'admin' | 'member',
): Promise<AdminActionResult<null>> {
  return run(async (user) => {
    await changeAccountRole(user, userId, { role });
    return null;
  });
}

export async function disableAccountAction(
  userId: string,
  stopSessions: boolean,
): Promise<AdminActionResult<DisableAccountResult>> {
  return run((user) => disableAccount(user, userId, { stopSessions }));
}

export async function enableAccountAction(userId: string): Promise<AdminActionResult<null>> {
  return run(async (user) => {
    await enableAccount(user, userId);
    return null;
  });
}

export async function deleteAccountAction(userId: string): Promise<AdminActionResult<null>> {
  return run(async (user) => {
    await deleteAccount(user, userId);
    return null;
  });
}

export async function recoveryLinkAction(
  userId: string,
  password: string,
  removePasskeys: boolean,
): Promise<AdminActionResult<RecoveryLinkView>> {
  return run((user) => createAccountRecoveryLink(user, userId, { password, removePasskeys }));
}

export async function registerServerAction(input: {
  name: string;
  url: string;
  location: string | null;
}): Promise<AdminActionResult<RegisteredServer>> {
  return run((user) => registerServer(user, input));
}

export async function verifyServerAction(
  environmentId: string,
): Promise<AdminActionResult<ServerVerification>> {
  return run((user) => verifyServer(user, environmentId));
}

export async function assignServerAction(
  environmentId: string,
  userId: string,
): Promise<AdminActionResult<null>> {
  return run(async (user) => {
    await assignServer(user, environmentId, { userId });
    return null;
  });
}

export async function updateServerAction(
  environmentId: string,
  input: {
    name?: string;
    location?: string | null;
    url?: string;
    maxConcurrentSessionsCap?: number;
    password?: string;
  },
): Promise<AdminActionResult<{ token: string | null }>> {
  return run(async (user) => {
    const updated: UpdatedServer = await updateServer(user, environmentId, input);
    // The view is reloaded by the console; only the one-time token travels back.
    return { token: updated.token };
  });
}

export async function rotateServerTokenAction(
  environmentId: string,
): Promise<AdminActionResult<RotatedToken>> {
  return run((user) => rotateServerToken(user, environmentId));
}

export async function restrictDatabaseAction(
  environmentId: string,
): Promise<AdminActionResult<RestrictedDatabaseAccess>> {
  return run((user) => restrictServerDatabase(user, environmentId));
}

export async function retireServerAction(environmentId: string): Promise<AdminActionResult<null>> {
  return run(async (user) => {
    await retireServer(user, environmentId);
    return null;
  });
}

export async function updateInstanceAction(
  patch: Record<string, number | boolean>,
): Promise<AdminActionResult<null>> {
  return run(async (user) => {
    await updateInstance(user, patch);
    return null;
  });
}

export async function loadJournalAction(
  before: number,
): Promise<AdminActionResult<{ items: InstanceJournalEntry[]; nextCursor: number | null }>> {
  return run((user) => getInstanceJournal(user, { before, limit: 50 }));
}
