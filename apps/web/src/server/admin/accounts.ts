import 'server-only';
import type { Transaction } from '@nuera/db';
import {
  account,
  auditLog,
  environmentSpaces,
  environments,
  invitations,
  passkey,
  projects,
  pushSubscriptions,
  session,
  sessions,
  spaces,
  twoFactor,
  user,
  verification,
} from '@nuera/db/schema';
import type { EnvironmentStatus, InstanceRole } from '@nuera/db/schema';
import { createRecoveryLink, RecoveryLinkError } from '@nuera/db/recovery';
import { and, asc, count, eq, gt, inArray, isNull, like, max, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/server/db';
import { getAppOrigin } from '@/server/auth/auth';
import { AppError } from '@/server/errors';
import { createNotification } from '@/server/notifications';
import { deleteSubscriptionsForUser } from '@/server/push';
import { getRunnerForEnvironment } from '@/server/runner/client';
import { invalidateRunnerEndpoint } from '@/server/runner/config';
import { audit, AUDIT_ACTIONS } from '@/server/security/audit';
import { invalidateSettingsCache } from '@/server/settings';
import { invalidateContextCache } from '@/server/tenancy/context';
import {
  closeRunnerRoleConnections,
  disableRunnerRoleLogin,
  refusedConnectionsNote,
} from './db-roles';
import {
  assertAdmin,
  assertAdminMutation,
  iso,
  NOT_FOUND_ACCOUNT,
  verifyOwnPassword,
  type AdminActor,
} from './common';

/**
 * Administration › Comptes (docs/MULTICOMPTE.md §6): list, role, disable / enable, delete, recovery
 * link. Guards: the owner is never demoted, disabled nor deleted; an administrator never acts on its
 * own account (no self-lockout); the last active administrator is protected. An administrator sees
 * each account's space, server, second factor, last sign-in and open accesses — never the content of
 * a space, never an IP of another space's business event, never the identity of a Claude account.
 */

const LIVE_SESSION_STATUSES = ['running', 'waiting_permission', 'waiting_input'] as const;
const SIGN_IN_ACTIONS = [AUDIT_ACTIONS.signIn, AUDIT_ACTIONS.signInNewDevice];

export const ACCOUNT_GUARDS = {
  owner: 'Le propriétaire ne peut être ni désactivé, ni supprimé, ni rétrogradé.',
  ownerRecovery:
    "Le compte du propriétaire ne se récupère qu'en ligne de commande, sur le serveur (voir l'aide du journal).",
  self: 'Vous ne pouvez pas faire cette action sur votre propre compte.',
  lastAdmin: "C'est le dernier administrateur actif : nommez d'abord un autre administrateur.",
  notDisabled: "Désactivez d'abord le compte.",
} as const;

export interface AdminAccountView {
  id: string;
  name: string;
  email: string;
  role: InstanceRole;
  twoFactorEnabled: boolean;
  disabledAt: string | null;
  createdAt: string;
  lastSignInAt: string | null;
  /** Web accesses still open. */
  openAccesses: number;
  space: { id: string; name: string } | null;
  server: { id: string; name: string; status: EnvironmentStatus } | null;
  /** Claude Code sessions running on the account's server (the « Arrêter aussi… (N) » option). */
  liveSessions: number;
  isSelf: boolean;
}

/** Every account that is not deleted, owner first, then by creation date. */
export async function listAccounts(actor: AdminActor): Promise<AdminAccountView[]> {
  assertAdmin(actor);
  const linked = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      twoFactorEnabled: user.twoFactorEnabled,
      disabledAt: user.disabledAt,
      createdAt: user.createdAt,
      spaceId: spaces.id,
      spaceName: spaces.name,
      environmentId: environments.id,
      environmentName: environments.name,
      environmentStatus: environments.status,
    })
    .from(user)
    .leftJoin(spaces, and(eq(spaces.ownerUserId, user.id), eq(spaces.kind, 'personal')))
    // The server the space works on, its first account or not (lot P1, shared servers).
    .leftJoin(environmentSpaces, eq(environmentSpaces.spaceId, spaces.id))
    .leftJoin(
      environments,
      and(eq(environments.id, environmentSpaces.environmentId), ne(environments.status, 'retired')),
    )
    .where(isNull(user.deletedAt))
    .orderBy(sql`case when ${user.role} = 'owner' then 0 else 1 end`, asc(user.createdAt));
  // One row per account: the server in use wins over a retired one.
  const byUser = new Map<string, (typeof linked)[number]>();
  for (const row of linked) {
    const seen = byUser.get(row.id);
    if (!seen || (!seen.environmentId && row.environmentId)) byUser.set(row.id, row);
  }
  const rows = [...byUser.values()];
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return [];

  const now = new Date();
  const [accesses, signIns, live] = await Promise.all([
    db
      .select({ userId: session.userId, total: count() })
      .from(session)
      .where(and(inArray(session.userId, ids), gt(session.expiresAt, now)))
      .groupBy(session.userId),
    db
      .select({ userId: auditLog.actorUserId, at: max(auditLog.createdAt) })
      .from(auditLog)
      .where(and(inArray(auditLog.actorUserId, ids), inArray(auditLog.action, SIGN_IN_ACTIONS)))
      .groupBy(auditLog.actorUserId),
    (() => {
      // Live sessions of each account's own space (a shared server runs other accounts' too).
      const spaceIds = rows.map((row) => row.spaceId).filter((id): id is string => Boolean(id));
      return spaceIds.length
        ? db
            .select({ spaceId: projects.spaceId, total: count() })
            .from(sessions)
            .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.environmentId, sessions.environmentId)))
            .where(
              and(
                inArray(projects.spaceId, spaceIds),
                inArray(sessions.status, [...LIVE_SESSION_STATUSES]),
              ),
            )
            .groupBy(projects.spaceId)
        : Promise.resolve([] as Array<{ spaceId: string; total: number }>);
    })(),
  ]);
  const accessBy = new Map(accesses.map((row) => [row.userId, Number(row.total)]));
  const signInBy = new Map(signIns.map((row) => [row.userId, row.at]));
  const liveBy = new Map(live.map((row) => [row.spaceId, Number(row.total)]));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    twoFactorEnabled: row.twoFactorEnabled === true,
    disabledAt: iso(row.disabledAt),
    createdAt: row.createdAt.toISOString(),
    lastSignInAt: iso(signInBy.get(row.id) ?? null),
    openAccesses: accessBy.get(row.id) ?? 0,
    space: row.spaceId && row.spaceName ? { id: row.spaceId, name: row.spaceName } : null,
    server:
      row.environmentId && row.environmentName && row.environmentStatus
        ? { id: row.environmentId, name: row.environmentName, status: row.environmentStatus }
        : null,
    liveSessions: row.environmentId && row.spaceId ? (liveBy.get(row.spaceId) ?? 0) : 0,
    isSelf: row.id === actor.id,
  }));
}

/** One account (same shape as the list), or AppError NOT_FOUND « Compte introuvable. ». */
export async function getAccount(actor: AdminActor, userId: string): Promise<AdminAccountView> {
  const found = (await listAccounts(actor)).find((item) => item.id === userId);
  if (!found) throw new AppError('NOT_FOUND', NOT_FOUND_ACCOUNT);
  return found;
}

interface TargetRow {
  id: string;
  name: string;
  email: string;
  role: InstanceRole;
  disabledAt: Date | null;
}

/** The target account, locked for the transaction (deleted accounts do not exist for the console). */
async function lockTarget(tx: Transaction, userId: string): Promise<TargetRow> {
  const [row] = await tx
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      disabledAt: user.disabledAt,
    })
    .from(user)
    .where(and(eq(user.id, userId), isNull(user.deletedAt)))
    .for('update');
  if (!row) throw new AppError('NOT_FOUND', NOT_FOUND_ACCOUNT);
  return row;
}

/** Other active administrators (owner included), administrators' rows locked: the last one is protected. */
async function otherActiveAdmins(tx: Transaction, exceptUserId: string): Promise<number> {
  const rows = await tx
    .select({ id: user.id })
    .from(user)
    .where(
      and(
        inArray(user.role, ['owner', 'admin']),
        isNull(user.disabledAt),
        isNull(user.deletedAt),
        ne(user.id, exceptUserId),
      ),
    )
    .for('update');
  return rows.length;
}

function guardTarget(actor: AdminActor, target: TargetRow): void {
  if (target.role === 'owner') throw new AppError('FORBIDDEN', ACCOUNT_GUARDS.owner);
  if (target.id === actor.id) throw new AppError('FORBIDDEN', ACCOUNT_GUARDS.self);
}

async function spaceOf(tx: Transaction, userId: string): Promise<{ id: string } | null> {
  const [row] = await tx
    .select({ id: spaces.id })
    .from(spaces)
    .where(and(eq(spaces.ownerUserId, userId), eq(spaces.kind, 'personal')))
    .limit(1);
  return row ?? null;
}

/**
 * Server in use of a space (lot P1: its first account or not) and whether another account still
 * working there is active (then the server is never suspended nor retired for this one).
 */
async function serverOfAccount(
  tx: Pick<Transaction, 'select'>,
  spaceId: string,
): Promise<{ id: string; name: string; primary: boolean; othersActive: number } | null> {
  const [row] = await tx
    .select({ id: environments.id, name: environments.name, primarySpaceId: environments.spaceId })
    .from(environmentSpaces)
    .innerJoin(environments, eq(environments.id, environmentSpaces.environmentId))
    .where(and(eq(environmentSpaces.spaceId, spaceId), ne(environments.status, 'retired')))
    .limit(1);
  if (!row) return null;
  const [others] = await tx
    .select({ total: count() })
    .from(environmentSpaces)
    .innerJoin(spaces, eq(spaces.id, environmentSpaces.spaceId))
    .innerJoin(user, eq(user.id, spaces.ownerUserId))
    .where(
      and(
        eq(environmentSpaces.environmentId, row.id),
        ne(environmentSpaces.spaceId, spaceId),
        isNull(user.disabledAt),
        isNull(user.deletedAt),
        isNull(spaces.archivedAt),
      ),
    );
  return { id: row.id, name: row.name, primary: row.primarySpaceId === spaceId, othersActive: Number(others?.total ?? 0) };
}

function invalidateAccount(userId: string, environmentIds: Array<string | null | undefined>): void {
  invalidateContextCache(userId);
  for (const id of environmentIds) {
    if (!id) continue;
    invalidateRunnerEndpoint(id);
    invalidateSettingsCache({ kind: 'environment', id });
  }
}

/**
 * Stops the Claude Code sessions still live on a server, through THAT server's runner (never another
 * one). Best effort: a session the runner cannot stop (unreachable…) is counted in `failed`.
 */
async function stopLiveSessions(
  environmentId: string,
  spaceId: string,
): Promise<{ stopped: number; failed: number }> {
  // The account's own sessions only (a shared server also runs other accounts', lot P1).
  const live = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(projects, and(eq(projects.id, sessions.projectId), eq(projects.environmentId, sessions.environmentId)))
    .where(
      and(
        eq(sessions.environmentId, environmentId),
        eq(projects.spaceId, spaceId),
        inArray(sessions.status, [...LIVE_SESSION_STATUSES]),
      ),
    );
  if (live.length === 0) return { stopped: 0, failed: 0 };
  const runner = getRunnerForEnvironment(environmentId);
  let stopped = 0;
  let failed = 0;
  for (const item of live) {
    try {
      await runner.stopSession({ params: { sessionId: item.id }, body: { force: false } });
      stopped += 1;
    } catch (error) {
      failed += 1;
      console.warn(
        '[administration] arrêt de session impossible',
        item.id,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { stopped, failed };
}

// ---------------------------------------------------------------------------------------------
// Rôle
// ---------------------------------------------------------------------------------------------

export const changeRoleSchema = z.object({
  role: z.enum(['admin', 'member'], 'rôle attendu : admin ou member'),
});

const ROLE_LABEL: Record<InstanceRole, string> = {
  owner: 'propriétaire',
  admin: 'administrateur',
  member: 'membre',
};

export async function changeAccountRole(
  actor: AdminActor,
  userId: string,
  input: { role: 'admin' | 'member' },
): Promise<AdminAccountView> {
  assertAdminMutation(actor);
  const { role } = changeRoleSchema.parse(input);
  const changed = await db.transaction(async (tx) => {
    const target = await lockTarget(tx, userId);
    guardTarget(actor, target);
    if (target.role === role) return null;
    if (
      target.role === 'admin' &&
      role === 'member' &&
      !target.disabledAt &&
      (await otherActiveAdmins(tx, target.id)) === 0
    ) {
      throw new AppError('CONFLICT', ACCOUNT_GUARDS.lastAdmin);
    }
    await tx.update(user).set({ role }).where(eq(user.id, target.id));
    return target;
  });
  if (changed) {
    invalidateContextCache(userId);
    await audit({
      action: 'admin.role_changed',
      summary: `rôle de ${changed.email} : ${ROLE_LABEL[changed.role]} → ${ROLE_LABEL[role]}`,
      actorUserId: actor.id,
      subjectUserId: changed.id,
      targetType: 'user',
      targetId: changed.id,
      metadata: { from: changed.role, to: role },
    });
  }
  return getAccount(actor, userId);
}

// ---------------------------------------------------------------------------------------------
// Désactiver / réactiver
// ---------------------------------------------------------------------------------------------

export const disableAccountSchema = z.object({ stopSessions: z.boolean().default(true) });

export interface DisableAccountResult {
  account: AdminAccountView;
  closedAccesses: number;
  server: { id: string; name: string } | null;
  stoppedSessions: number;
  /** Sessions the server could not stop (unreachable runner…): they keep running on it. */
  failedSessions: number;
}

/**
 * Disables an account: web accesses and trusted devices deleted, push subscriptions deleted, its
 * server `suspended` (the runner refuses new work, the web refuses its callbacks). With
 * `stopSessions` (default), its running Claude Code sessions are stopped through its server's runner.
 */
export async function disableAccount(
  actor: AdminActor,
  userId: string,
  input: { stopSessions?: boolean } = {},
): Promise<DisableAccountResult> {
  assertAdminMutation(actor);
  const { stopSessions } = disableAccountSchema.parse(input);
  const outcome = await db.transaction(async (tx) => {
    const target = await lockTarget(tx, userId);
    guardTarget(actor, target);
    if (
      target.role === 'admin' &&
      !target.disabledAt &&
      (await otherActiveAdmins(tx, target.id)) === 0
    ) {
      throw new AppError('CONFLICT', ACCOUNT_GUARDS.lastAdmin);
    }
    const now = new Date();
    if (!target.disabledAt)
      await tx.update(user).set({ disabledAt: now }).where(eq(user.id, target.id));
    const closed = await tx
      .delete(session)
      .where(eq(session.userId, target.id))
      .returning({ id: session.id });
    await tx
      .delete(verification)
      .where(
        and(like(verification.identifier, 'trust-device-%'), eq(verification.value, target.id)),
      );
    await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, target.id));
    const space = await spaceOf(tx, target.id);
    let server: { id: string; name: string } | null = null;
    let working: { id: string; name: string } | null = null;
    if (space) {
      const used = await serverOfAccount(tx, space.id);
      working = used ? { id: used.id, name: used.name } : null;
      // A shared server (lot P1) keeps serving its other active accounts: suspended only when this
      // account is its first one and nobody else still works there.
      if (!used || (used.primary && used.othersActive === 0)) {
        const [suspended] = await tx
          .update(environments)
          .set({ status: 'suspended' })
          .where(
            and(
              eq(environments.spaceId, space.id),
              inArray(environments.status, ['active', 'suspended']),
            ),
          )
          .returning({ id: environments.id, name: environments.name });
        server = suspended ?? null;
      }
    }
    return { target, closed: closed.length, server, working, spaceId: space?.id ?? null, wasDisabled: Boolean(target.disabledAt) };
  });
  invalidateAccount(userId, [outcome.server?.id, outcome.working?.id]);

  const { stopped, failed } =
    stopSessions && outcome.working && outcome.spaceId
      ? await stopLiveSessions(outcome.working.id, outcome.spaceId)
      : { stopped: 0, failed: 0 };

  if (!outcome.wasDisabled) {
    await audit({
      action: 'admin.account_disabled',
      summary: `compte désactivé : ${outcome.target.email}${outcome.server ? ` · serveur « ${outcome.server.name} » suspendu` : ''}`,
      actorUserId: actor.id,
      subjectUserId: outcome.target.id,
      targetType: 'user',
      targetId: outcome.target.id,
      environmentId: outcome.server?.id ?? outcome.working?.id ?? null,
      metadata: {
        closedAccesses: outcome.closed,
        stopSessions,
        stoppedSessions: stopped,
        failedSessions: failed,
      },
    });
  }
  return {
    account: await getAccount(actor, userId),
    closedAccesses: outcome.closed,
    server: outcome.server,
    stoppedSessions: stopped,
    failedSessions: failed,
  };
}

/** Enables a disabled account again: sign-in possible, its server `active` again. */
export async function enableAccount(actor: AdminActor, userId: string): Promise<AdminAccountView> {
  assertAdminMutation(actor);
  const outcome = await db.transaction(async (tx) => {
    const target = await lockTarget(tx, userId);
    guardTarget(actor, target);
    if (!target.disabledAt) return null;
    await tx.update(user).set({ disabledAt: null }).where(eq(user.id, target.id));
    const space = await spaceOf(tx, target.id);
    const [server] = space
      ? await tx
          .update(environments)
          .set({ status: 'active' })
          .where(and(eq(environments.spaceId, space.id), eq(environments.status, 'suspended')))
          .returning({ id: environments.id, name: environments.name })
      : [];
    return { target, server: server ?? null };
  });
  if (outcome) {
    invalidateAccount(userId, [outcome.server?.id]);
    await audit({
      action: 'admin.account_enabled',
      summary: `compte réactivé : ${outcome.target.email}${outcome.server ? ` · serveur « ${outcome.server.name} » actif` : ''}`,
      actorUserId: actor.id,
      subjectUserId: outcome.target.id,
      targetType: 'user',
      targetId: outcome.target.id,
      environmentId: outcome.server?.id ?? null,
    });
  }
  return getAccount(actor, userId);
}

// ---------------------------------------------------------------------------------------------
// Supprimer
// ---------------------------------------------------------------------------------------------

/**
 * Deletes a DISABLED account: its Claude Code sessions still running are stopped by its server's
 * runner, then the account is anonymised (`deleted_at`, name and e-mail replaced, credentials,
 * passkeys, 2FA and accesses removed), its space archived, its server retired (its database role can
 * no longer connect). Its GitHub repositories are never touched; the journal keeps the authors'
 * e-mails (`actor_label`).
 */
export async function deleteAccount(
  actor: AdminActor,
  userId: string,
): Promise<{ id: string; email: string; stoppedSessions: number; failedSessions: number }> {
  assertAdminMutation(actor);
  // Sessions still running on its server (disabled without « Arrêter aussi… ») are stopped through
  // its runner first, while the server can still write their end (its database role is closed below).
  // The guards are checked again, under lock, by the transaction.
  const [candidate] = await db
    .select({
      id: user.id,
      role: user.role,
      disabledAt: user.disabledAt,
      spaceId: spaces.id,
    })
    .from(user)
    .leftJoin(spaces, and(eq(spaces.ownerUserId, user.id), eq(spaces.kind, 'personal')))
    .where(and(eq(user.id, userId), isNull(user.deletedAt)))
    .limit(1);
  const used = candidate?.spaceId ? await serverOfAccount(db, candidate.spaceId) : null;
  const stoppable =
    candidate &&
    candidate.role !== 'owner' &&
    candidate.id !== actor.id &&
    candidate.disabledAt &&
    used;
  const halted = stoppable
    ? await stopLiveSessions(used!.id, candidate.spaceId!)
    : { stopped: 0, failed: 0 };
  const outcome = await db.transaction(async (tx) => {
    const target = await lockTarget(tx, userId);
    guardTarget(actor, target);
    if (!target.disabledAt) throw new AppError('CONFLICT', ACCOUNT_GUARDS.notDisabled);
    const now = new Date();
    await tx
      .update(user)
      .set({
        name: 'Compte supprimé',
        email: `supprime-${target.id.toLowerCase().replace(/[^a-z0-9]/g, '')}@comptes.nuera.invalid`,
        image: null,
        role: 'member',
        twoFactorEnabled: false,
        deletedAt: now,
      })
      .where(eq(user.id, target.id));
    await tx.delete(account).where(eq(account.userId, target.id));
    await tx.delete(passkey).where(eq(passkey.userId, target.id));
    await tx.delete(twoFactor).where(eq(twoFactor.userId, target.id));
    await tx.delete(session).where(eq(session.userId, target.id));
    await tx
      .delete(verification)
      .where(
        and(like(verification.identifier, 'trust-device-%'), eq(verification.value, target.id)),
      );
    await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, target.id));
    await tx
      .update(invitations)
      .set({ revokedAt: now })
      .where(
        and(
          isNull(invitations.revokedAt),
          isNull(invitations.completedAt),
          or(
            eq(invitations.userId, target.id),
            sql`lower(${invitations.email}) = ${target.email.toLowerCase()}`,
          ),
        ),
      );
    const space = await spaceOf(tx, target.id);
    let servers: Array<{ id: string; name: string; dbRole: string | null }> = [];
    let shared: { id: string; name: string } | null = null;
    if (space) {
      const working = await serverOfAccount(tx, space.id);
      await tx.update(spaces).set({ archivedAt: now }).where(eq(spaces.id, space.id));
      // A shared server (lot P1) keeps serving its other accounts: only this account leaves it (its
      // archived projects keep the row); the server is retired only when nobody else works there.
      if (working && (!working.primary || working.othersActive > 0)) {
        shared = { id: working.id, name: working.name };
      } else {
        servers = await tx
          .update(environments)
          .set({ status: 'retired' })
          .where(and(eq(environments.spaceId, space.id), ne(environments.status, 'retired')))
          .returning({ id: environments.id, name: environments.name, dbRole: environments.dbRole });
        for (const server of servers) await disableRunnerRoleLogin(tx, server.dbRole);
      }
    }
    return { target, servers, shared, spaceId: space?.id ?? null };
  });
  invalidateAccount(userId, [...outcome.servers.map((server) => server.id), outcome.shared?.id]);
  // Its Claude Code login must not stay on a server other accounts keep using.
  let signedOut = false;
  if (outcome.shared && outcome.spaceId) {
    try {
      const forgotten = await getRunnerForEnvironment(outcome.shared.id).claudeAccountForget(
        { params: { spaceId: outcome.spaceId }, body: { deleted: true } },
        { timeoutMs: 45_000 },
      );
      signedOut = forgotten.signedOut || forgotten.removed;
    } catch (error) {
      console.warn('[administration] connexion Claude du compte supprimé non retirée', error instanceof Error ? error.message : error);
    }
  }
  // NOLOGIN only refuses new connections: the ones its runner (or a session) still holds are closed.
  const closed = { closed: 0, refused: 0 };
  for (const server of outcome.servers) {
    const result = await closeRunnerRoleConnections(server.dbRole);
    closed.closed += result.closed;
    closed.refused += result.refused;
  }
  await audit({
    action: 'admin.account_deleted',
    summary: `compte supprimé : ${outcome.target.email}${outcome.servers.length ? ` · serveur « ${outcome.servers.map((s) => s.name).join(', ')} » retiré` : ''}${refusedConnectionsNote(closed.refused)}`,
    actorUserId: actor.id,
    subjectUserId: outcome.target.id,
    targetType: 'user',
    targetId: outcome.target.id,
    metadata: {
      email: outcome.target.email,
      retiredServers: outcome.servers.map((server) => server.id),
      sharedServer: outcome.shared?.id ?? null,
      claudeSignedOut: signedOut,
      stoppedSessions: halted.stopped,
      failedSessions: halted.failed,
      closedConnections: closed.closed,
      refusedConnections: closed.refused,
    },
  });
  return {
    id: outcome.target.id,
    email: outcome.target.email,
    stoppedSessions: halted.stopped,
    failedSessions: halted.failed,
  };
}

// ---------------------------------------------------------------------------------------------
// Lien de récupération
// ---------------------------------------------------------------------------------------------

export const recoverySchema = z.object({
  /** The administrator's own password, asked again (a recovery link can take over an account). */
  password: z.string('mot de passe requis').min(1, 'mot de passe requis').max(256),
  /** The device holding the passkeys is lost. */
  removePasskeys: z.boolean().default(false),
});

export interface RecoveryLinkView {
  url: string;
  expiresAt: string;
  email: string;
  closedAccesses: number;
}

/**
 * Recovery link of an account (administrator, password re-confirmed): closes its accesses, trusted
 * devices and second factor (packages/db/src/recovery.ts), warns its devices, then deletes its push
 * subscriptions. The link is shown once; the event is journaled with `subject_user_id`.
 */
export async function createAccountRecoveryLink(
  actor: AdminActor,
  userId: string,
  input: { password: string; removePasskeys?: boolean },
): Promise<RecoveryLinkView> {
  assertAdminMutation(actor);
  const parsed = recoverySchema.parse(input);
  const [target] = await db
    .select({ id: user.id, email: user.email, role: user.role, disabledAt: user.disabledAt })
    .from(user)
    .where(and(eq(user.id, userId), isNull(user.deletedAt)))
    .limit(1);
  if (!target) throw new AppError('NOT_FOUND', NOT_FOUND_ACCOUNT);
  if (target.disabledAt)
    throw new AppError(
      'CONFLICT',
      'Ce compte est désactivé : réactivez-le avant de créer un lien de récupération.',
    );
  if (target.id === actor.id) throw new AppError('FORBIDDEN', ACCOUNT_GUARDS.self);
  if (target.role === 'owner') throw new AppError('FORBIDDEN', ACCOUNT_GUARDS.ownerRecovery);
  await verifyOwnPassword(actor, parsed.password);

  let link;
  try {
    link = await createRecoveryLink(db, {
      email: target.email,
      appUrl: getAppOrigin(),
      actor: { userId: actor.id, label: actor.email },
      removePasskeys: parsed.removePasskeys,
    });
  } catch (error) {
    if (error instanceof RecoveryLinkError) {
      throw new AppError(
        error.code === 'UNKNOWN_ACCOUNT' || error.code === 'ACCOUNT_DELETED'
          ? 'NOT_FOUND'
          : 'CONFLICT',
        error.code === 'UNKNOWN_ACCOUNT' || error.code === 'ACCOUNT_DELETED'
          ? NOT_FOUND_ACCOUNT
          : error.message,
      );
    }
    throw error;
  }

  // Only once the link exists (never a warning about something that did not happen): the person is
  // warned on the devices that still receive its notifications, then they are removed.
  await createNotification(
    {
      kind: 'security',
      severity: 'warning',
      title: 'Un administrateur a créé un lien de récupération pour votre compte.',
      body: "Vos accès ont été fermés et votre double authentification réinitialisée. Si vous n'êtes pas à l'origine de la demande, prévenez un administrateur.",
      href: '/parametres?onglet=compte-et-securite',
    },
    { spaceId: null, userIds: [target.id] },
  ).catch((error: unknown) =>
    console.warn(
      '[administration] notification de récupération impossible',
      error instanceof Error ? error.message : error,
    ),
  );
  await deleteSubscriptionsForUser(target.id);
  invalidateContextCache(target.id);
  return {
    url: link.url,
    expiresAt: link.expiresAt.toISOString(),
    email: link.email,
    closedAccesses: link.closedSessions,
  };
}

/** French label of each role (journal summaries). */
export const ROLE_LABELS = ROLE_LABEL;
