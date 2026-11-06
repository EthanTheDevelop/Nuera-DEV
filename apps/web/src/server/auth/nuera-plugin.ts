import 'server-only';
import { auditLog } from '@nuera/db/schema';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx, isAPIError } from 'better-auth/api';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/server/db';
import { describeDevice } from '@/server/auth/device';
import { evaluateSessionPolicy } from '@/server/auth/policy';
import { deleteSubscriptionsForSession } from '@/server/push';
import { audit, AUDIT_ACTIONS } from '@/server/security/audit';
import { displayableIp, getClientCity, getClientIp, getUserAgent } from '@/server/security/request-info';
import { getWebSessionPolicy } from '@/server/settings';

/**
 * Nuera Dev rules layered on Better Auth (placed after twoFactor/passkey, before nextCookies):
 *
 * before every auth call (HTTP or `auth.api.*`):
 *   - web-session policy: idle expiry (webSessionIdleHours) and absolute expiry (webSessionMaxDays)
 *     are enforced on the session cookie; activity (session.updatedAt) is refreshed every 5 min;
 *     an expired access takes its push subscriptions with it (the device stops receiving them);
 *   - 2FA cannot be disabled (mandatory);
 *   - the session of a disabled account (and its push subscriptions) is deleted on its next request;
 *   - passkeys can only be registered once 2FA is active.
 * (Refusing a disabled account or a password sign-in without 2FA happens in auth.ts,
 * `databaseHooks.session.create.before`: after the credential check, so the refusal never tells
 * whether an e-mail exists.)
 * after every auth call: audit of sign-ins (new device detection), failures, 2FA, passkeys,
 *   password changes, revocations, sign-out.
 */

type HookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

interface FoundSession {
  session: { id: string; token: string; userId: string; createdAt: Date; updatedAt: Date; userAgent?: string | null; ipAddress?: string | null };
  user: { id: string; email: string; twoFactorEnabled?: boolean | null };
}

/** Session read by the before hook, kept for the after hook of the same call (sign-out audit). */
const sessionsByCall = new WeakMap<object, FoundSession>();

function requestInfo(ctx: HookContext) {
  const headers = ctx.headers ?? null;
  return {
    ip: headers ? getClientIp(headers) : null,
    userAgent: headers ? getUserAgent(headers) : null,
    city: headers ? getClientCity(headers) : null,
  };
}

async function readSessionCookie(ctx: HookContext): Promise<string | null> {
  if (!ctx.headers?.get('cookie')) return null;
  const token = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
  return typeof token === 'string' && token ? token : null;
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Id of the account behind an e-mail tried at sign-in (its owner sees the attempt in its journal). */
async function accountIdOfEmail(ctx: HookContext, email: string | null): Promise<string | null> {
  if (!email) return null;
  try {
    const found = await ctx.context.internalAdapter.findUserByEmail(email.trim().toLowerCase());
    return found?.user.id ?? null;
  } catch {
    return null;
  }
}

const SIGN_IN_REFUSALS: Record<string, string> = {
  ACCOUNT_DISABLED: 'connexion refusée : compte désactivé',
  SETUP_INCOMPLETE: 'connexion refusée : double authentification non activée',
  ACTIVATION_INCOMPLETE: 'connexion refusée : double authentification non activée',
};

/** The devices registered through an access that is being closed: they stop receiving its notifications. */
async function closeAccessDevices(sessionId: string): Promise<void> {
  try {
    await deleteSubscriptionsForSession(sessionId);
  } catch (error) {
    // sendPush also refuses a subscription whose access no longer exists.
    console.error('[auth] abonnements push non retirés', error instanceof Error ? error.message : error);
  }
}

/** Exported for tests only. */
export async function enforceSessionPolicy(ctx: HookContext): Promise<void> {
  const token = await readSessionCookie(ctx);
  if (!token) return;
  const found = (await ctx.context.internalAdapter.findSession(token)) as FoundSession | null;
  if (!found) return;
  if (toDate((found.user as { disabledAt?: unknown }).disabledAt)) {
    // Disabled while this access was open (the administration deletes them; this closes a race).
    await closeAccessDevices(found.session.id);
    await ctx.context.internalAdapter.deleteSession(token);
    return;
  }
  const policy = await getWebSessionPolicy();
  const now = new Date();
  const verdict = evaluateSessionPolicy(
    { createdAt: new Date(found.session.createdAt), lastActivityAt: new Date(found.session.updatedAt) },
    policy,
    now,
  );
  if (!verdict.valid) {
    await closeAccessDevices(found.session.id);
    await ctx.context.internalAdapter.deleteSession(token);
    const device = describeDevice(found.session.userAgent);
    await audit({
      action: AUDIT_ACTIONS.sessionExpired,
      summary:
        verdict.reason === 'idle'
          ? `accès expiré après ${policy.idleHours} h d'inactivité (${device.label})`
          : `accès expiré : durée maximale de ${policy.maxDays} jours atteinte (${device.label})`,
      actorUserId: found.user.id,
      actorKind: 'system',
      targetType: 'session',
      targetId: found.session.id,
      metadata: { reason: verdict.reason, device: device.label },
      ...requestInfo(ctx),
    });
    return;
  }
  sessionsByCall.set(ctx.context, found);
  if (verdict.shouldTouch) {
    await ctx.context.internalAdapter.updateSession(token, { updatedAt: now });
  }
}

async function hasSignedInFromDevice(userId: string, deviceLabel: string, excludeSessionId: string): Promise<boolean> {
  const rows = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.actorUserId, userId),
        inArray(auditLog.action, [AUDIT_ACTIONS.signIn, AUDIT_ACTIONS.signInNewDevice]),
        sql`${auditLog.metadata}->>'device' = ${deviceLabel}`,
        sql`coalesce(${auditLog.metadata}->>'sessionId', '') <> ${excludeSessionId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

type SignInMethod = 'password' | 'totp' | 'backup_code' | 'passkey';

const METHOD_SUFFIX: Record<SignInMethod, string> = {
  password: '',
  totp: '',
  backup_code: ' avec un code de secours',
  passkey: " par clé d'accès",
};

async function auditSignIn(ctx: HookContext, method: SignInMethod): Promise<void> {
  const created = ctx.context.newSession as FoundSession | null | undefined;
  if (!created?.session) return;
  const info = requestInfo(ctx);
  const device = describeDevice(created.session.userAgent ?? info.userAgent);
  const known = await hasSignedInFromDevice(created.user.id, device.label, created.session.id);
  // Trusted city header first, then the IP read from the trusted proxy header — never a guess.
  const where = info.city ?? info.ip ?? displayableIp(created.session.ipAddress);
  await audit({
    action: known ? AUDIT_ACTIONS.signIn : AUDIT_ACTIONS.signInNewDevice,
    summary: `connexion${known ? '' : ' depuis un nouvel appareil'}${METHOD_SUFFIX[method]}${where ? ` (${where})` : ''}`,
    actorUserId: created.user.id,
    targetType: 'session',
    targetId: created.session.id,
    metadata: { method, device: device.label, city: info.city, ip: info.ip, sessionId: created.session.id },
    ...info,
  });
}

function returnedBody(ctx: HookContext): Record<string, unknown> | null {
  const returned = ctx.context.returned;
  return returned && typeof returned === 'object' && !isAPIError(returned) ? (returned as Record<string, unknown>) : null;
}

async function auditAfter(ctx: HookContext): Promise<void> {
  const failed = isAPIError(ctx.context.returned);
  const info = requestInfo(ctx);
  const existing = sessionsByCall.get(ctx.context) ?? null;
  const actorUserId = existing?.user.id ?? null;

  switch (ctx.path) {
    case '/sign-in/email': {
      if (failed) {
        const email = typeof ctx.body?.email === 'string' ? ctx.body.email.slice(0, 200) : null;
        const code = (ctx.context.returned as { body?: { code?: unknown } }).body?.code;
        const refusal = typeof code === 'string' ? SIGN_IN_REFUSALS[code] : undefined;
        const subjectUserId = await accountIdOfEmail(ctx, email);
        await audit({
          action: AUDIT_ACTIONS.signInFailed,
          summary: refusal ?? 'échec de connexion : e-mail ou mot de passe refusé',
          metadata: { method: 'password', email, ...(typeof code === 'string' ? { reason: code } : {}) },
          subjectUserId,
          ...(subjectUserId ? { targetType: 'user', targetId: subjectUserId } : {}),
          ...info,
        });
      } else if (ctx.context.newSession) {
        await auditSignIn(ctx, 'password');
      }
      return;
    }
    case '/two-factor/verify-totp': {
      if (failed) {
        await audit({
          action: AUDIT_ACTIONS.secondFactorFailed,
          summary: 'code de double authentification refusé',
          actorUserId,
          metadata: { method: 'totp' },
          ...info,
        });
      } else if (existing && !existing.user.twoFactorEnabled) {
        await audit({
          action: AUDIT_ACTIONS.twoFactorEnabled,
          summary: "double authentification activée (application d'authentification)",
          actorUserId,
          targetType: 'user',
          targetId: actorUserId ?? undefined,
          ...info,
        });
      } else if (!existing) {
        await auditSignIn(ctx, 'totp');
      }
      return;
    }
    case '/two-factor/verify-backup-code': {
      if (failed) {
        await audit({
          action: AUDIT_ACTIONS.secondFactorFailed,
          summary: 'code de secours refusé',
          actorUserId,
          metadata: { method: 'backup_code' },
          ...info,
        });
      } else if (!existing && ctx.context.newSession) {
        const created = ctx.context.newSession as FoundSession;
        await audit({
          action: AUDIT_ACTIONS.backupCodeUsed,
          summary: 'code de secours utilisé',
          actorUserId: created.user.id,
          ...info,
        });
        await auditSignIn(ctx, 'backup_code');
      }
      return;
    }
    case '/passkey/verify-authentication': {
      if (failed) {
        await audit({
          action: AUDIT_ACTIONS.signInFailed,
          summary: "échec de connexion par clé d'accès",
          metadata: { method: 'passkey' },
          ...info,
        });
      } else {
        await auditSignIn(ctx, 'passkey');
      }
      return;
    }
    case '/passkey/verify-registration': {
      if (failed) return;
      const body = returnedBody(ctx);
      const device = describeDevice(info.userAgent);
      await audit({
        action: AUDIT_ACTIONS.passkeyAdded,
        summary: `clé d'accès ajoutée (${device.label})`,
        actorUserId,
        targetType: 'passkey',
        targetId: typeof body?.id === 'string' ? body.id : undefined,
        metadata: { name: typeof body?.name === 'string' ? body.name : null, device: device.label },
        ...info,
      });
      return;
    }
    case '/passkey/delete-passkey': {
      if (failed) return;
      await audit({
        action: AUDIT_ACTIONS.passkeyRemoved,
        summary: "clé d'accès supprimée",
        actorUserId,
        targetType: 'passkey',
        targetId: typeof ctx.body?.id === 'string' ? ctx.body.id : undefined,
        ...info,
      });
      return;
    }
    case '/change-password': {
      await audit(
        failed
          ? {
              action: AUDIT_ACTIONS.passwordChanged,
              summary: 'changement de mot de passe refusé (mot de passe actuel incorrect)',
              actorUserId,
              metadata: { ok: false },
              ...info,
            }
          : {
              action: AUDIT_ACTIONS.passwordChanged,
              summary: ctx.body?.revokeOtherSessions
                ? 'mot de passe modifié · autres accès fermés'
                : 'mot de passe modifié',
              actorUserId,
              metadata: { ok: true },
              ...info,
            },
      );
      return;
    }
    case '/two-factor/generate-backup-codes': {
      if (failed) return;
      await audit({
        action: AUDIT_ACTIONS.backupCodesRegenerated,
        summary: 'codes de secours régénérés',
        actorUserId,
        ...info,
      });
      return;
    }
    case '/revoke-other-sessions':
    case '/revoke-sessions': {
      if (failed) return;
      await audit({
        action: AUDIT_ACTIONS.otherSessionsRevoked,
        summary: ctx.path === '/revoke-sessions' ? 'tous les accès fermés' : 'autres accès fermés',
        actorUserId,
        ...info,
      });
      return;
    }
    case '/revoke-session': {
      if (failed) return;
      await audit({
        action: AUDIT_ACTIONS.sessionRevoked,
        summary: 'accès révoqué',
        actorUserId,
        targetType: 'session',
        ...info,
      });
      return;
    }
    case '/sign-out': {
      if (!existing) return;
      await audit({
        action: AUDIT_ACTIONS.signOut,
        summary: `déconnexion (${describeDevice(existing.session.userAgent).label})`,
        actorUserId: existing.user.id,
        targetType: 'session',
        targetId: existing.session.id,
        ...info,
      });
      return;
    }
    default:
      return;
  }
}

export const nueraAuthPlugin = () =>
  ({
    id: 'nuera-guard',
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.path === '/two-factor/disable') {
              throw new APIError('FORBIDDEN', {
                message: 'La double authentification est obligatoire sur Nuera Dev.',
                code: 'TWO_FACTOR_REQUIRED',
              });
            }

            await enforceSessionPolicy(ctx);

            if (ctx.path === '/passkey/generate-register-options' || ctx.path === '/passkey/verify-registration') {
              const current = await getSessionFromCtx(ctx);
              const twoFactorEnabled = (current?.user as { twoFactorEnabled?: boolean | null } | undefined)?.twoFactorEnabled;
              if (current && !twoFactorEnabled) {
                throw new APIError('FORBIDDEN', {
                  message: "Activez d'abord la double authentification.",
                  code: 'TWO_FACTOR_REQUIRED',
                });
              }
            }
          }),
        },
      ],
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            try {
              await auditAfter(ctx);
            } catch (error) {
              console.error('[auth] audit impossible', ctx.path, error instanceof Error ? error.message : error);
            }
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
