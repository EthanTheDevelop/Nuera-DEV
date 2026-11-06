import 'server-only';
import { passkey } from '@better-auth/passkey';
import {
  account,
  passkey as passkeyTable,
  session,
  twoFactor as twoFactorTable,
  user,
  verification,
} from '@nuera/db/schema';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { nextCookies } from 'better-auth/next-js';
import { twoFactor } from 'better-auth/plugins';
import { eq } from 'drizzle-orm';
import { db } from '@/server/db';
import { consumeEnrolmentGrant, ENROLMENT_GRANT_HEADER } from '@/server/auth/enrolment-grant';
import { nueraAuthPlugin } from '@/server/auth/nuera-plugin';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/server/auth/password-policy';
import { absoluteExpiry, SESSION_HARD_CEILING_DAYS } from '@/server/auth/policy';
import { TOTP_ISSUER } from '@/server/auth/totp';
import { trustedIpHeaders } from '@/server/security/request-info';
import { getWebSessionPolicy } from '@/server/settings';

/**
 * Better Auth for the accounts of Nuera Dev (docs/MULTICOMPTE.md §6).
 *
 * - e-mail + password (scrypt), public sign-up CLOSED: `user.create.before` refuses every account
 *   creation (SIGN_UP_CLOSED). Accounts are written by Nuera Dev's own transactions only: the owner by
 *   /configuration (SETUP_TOKEN), the others by an invitation (server/auth/links.ts);
 * - `session.create.before` (after the credential check, every sign-in path, passkeys included):
 *   a disabled or deleted account is refused (ACCOUNT_DISABLED), and a password sign-in of an account
 *   without 2FA is refused unless an enrolment grant bound to its e-mail is presented
 *   (server/auth/enrolment-grant.ts: setup, invitation, recovery);
 * - TOTP 2FA mandatory for every account (issuer « Nuera Dev », 8 backup codes, cannot be disabled),
 *   passkeys optional (user verification required, so a passkey counts as two factors);
 * - `role` and `disabledAt` are additional user fields that no endpoint accepts as input;
 * - sessions: absolute lifetime = webSessionMaxDays (set at creation, never extended), idle expiry =
 *   webSessionIdleHours (enforced by nueraAuthPlugin on every auth call);
 * - cookies `nuera.*` (Secure + `__Secure-` prefix in production), SameSite=Lax, trusted origin = APP_URL;
 * - built-in rate limiting for /api/auth/* (server actions use src/server/security/rate-limit.ts).
 *
 * Created lazily (first use) so that importing this module never fails at build time.
 */

/** Copy of the refusals raised by the database hooks (also used by nueraAuthPlugin's audit). */
export const AUTH_REFUSALS = {
  accountDisabled: 'Ce compte est désactivé. Contactez un administrateur.',
  signUpClosed: 'Les inscriptions sont fermées : demandez une invitation à un administrateur.',
  setupIncomplete: 'Configuration inachevée : terminez-la depuis la page de configuration, avec le jeton.',
  activationIncomplete:
    "Activation inachevée : la double authentification de ce compte n'est pas encore activée. Rouvrez votre lien d'invitation ou de récupération pour la terminer.",
} as const;

interface HookContext {
  path?: string;
  headers?: Headers;
}

/** Throws the APIError that refuses a new session of `userId`, if any (see the module comment). */
export async function assertSessionAllowed(userId: string, ctx: HookContext | null | undefined): Promise<void> {
  const [row] = await db
    .select({
      email: user.email,
      role: user.role,
      twoFactorEnabled: user.twoFactorEnabled,
      disabledAt: user.disabledAt,
      deletedAt: user.deletedAt,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row || row.disabledAt || row.deletedAt) {
    throw new APIError('FORBIDDEN', { message: AUTH_REFUSALS.accountDisabled, code: 'ACCOUNT_DISABLED' });
  }
  if (row.twoFactorEnabled || ctx?.path !== '/sign-in/email') return;
  if (consumeEnrolmentGrant(ctx.headers?.get(ENROLMENT_GRANT_HEADER), row.email)) return;
  throw row.role === 'owner'
    ? new APIError('FORBIDDEN', { message: AUTH_REFUSALS.setupIncomplete, code: 'SETUP_INCOMPLETE' })
    : new APIError('FORBIDDEN', { message: AUTH_REFUSALS.activationIncomplete, code: 'ACTIVATION_INCOMPLETE' });
}

const DAY_SECONDS = 24 * 60 * 60;

/** Public origin of the app (APP_URL). Required in production. */
export function getAppOrigin(): string {
  const raw = process.env.APP_URL || process.env.BETTER_AUTH_URL;
  if (raw) return new URL(raw).origin;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('APP_URL manquante : URL publique de Nuera Dev (ex. https://dev.nuera.studio).');
  }
  return 'http://localhost:3000';
}

function createAuth() {
  const appOrigin = getAppOrigin();
  const isProduction = process.env.NODE_ENV === 'production';

  return betterAuth({
    appName: 'Nuera Dev',
    baseURL: appOrigin,
    basePath: '/api/auth',
    secret: process.env.BETTER_AUTH_SECRET,
    trustedOrigins: [appOrigin],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: { user, session, account, verification, twoFactor: twoFactorTable, passkey: passkeyTable },
    }),
    user: {
      // Written by Nuera Dev only (setup, invitations, administration), never by a client.
      additionalFields: {
        role: { type: 'string', required: false, defaultValue: 'member', input: false },
        disabledAt: { type: 'date', required: false, input: false },
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
    },
    session: {
      // Cookie lifetime only: the real expiry (≤ webSessionMaxDays) is written at creation.
      expiresIn: SESSION_HARD_CEILING_DAYS * DAY_SECONDS,
      disableSessionRefresh: true,
      // Sensitive Better Auth operations (adding a passkey…) need a session opened < 1 h ago.
      freshAge: 60 * 60,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: 'memory',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/passkey/verify-authentication': { window: 60, max: 10 },
        '/passkey/generate-authenticate-options': { window: 60, max: 20 },
      },
    },
    advanced: {
      useSecureCookies: isProduction,
      cookiePrefix: 'nuera',
      ipAddress: { ipAddressHeaders: trustedIpHeaders() },
      defaultCookieAttributes: { sameSite: 'lax', httpOnly: true },
    },
    // Unused flows stay closed at the HTTP router level as well.
    disabledPaths: [
      '/sign-up/email',
      '/two-factor/disable',
      '/two-factor/send-otp',
      '/two-factor/verify-otp',
      '/two-factor/get-totp-uri',
      '/request-password-reset',
      '/reset-password',
      '/change-email',
      '/delete-user',
      '/update-user',
      '/link-social',
      '/unlink-account',
      '/sign-in/social',
    ],
    databaseHooks: {
      user: {
        create: {
          // Accounts are only created by Nuera Dev's own transactions (/configuration, invitations).
          before: async () => {
            throw new APIError('FORBIDDEN', { message: AUTH_REFUSALS.signUpClosed, code: 'SIGN_UP_CLOSED' });
          },
        },
      },
      session: {
        create: {
          // Runs after the credential check, for every way of opening a session (password, second
          // factor, passkey): a disabled account never gets one, and a password alone never opens a
          // session for an account without 2FA unless an enrolment grant bound to its e-mail is presented.
          before: async (data, ctx) => {
            await assertSessionAllowed(data.userId, ctx);
            const { maxDays } = await getWebSessionPolicy();
            return { data: { ...data, expiresAt: absoluteExpiry(new Date(), maxDays) } };
          },
        },
      },
    },
    telemetry: { enabled: false },
    plugins: [
      twoFactor({
        issuer: TOTP_ISSUER,
        backupCodeOptions: { amount: 8, length: 10, storeBackupCodes: 'encrypted' },
        trustDeviceMaxAge: 30 * DAY_SECONDS,
        twoFactorCookieMaxAge: 10 * 60,
      }),
      passkey({
        rpID: new URL(appOrigin).hostname,
        rpName: 'Nuera Dev',
        origin: appOrigin,
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      }),
      nueraAuthPlugin(),
      nextCookies(), // must stay last
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

// Module-level (not globalThis): a dev reload of this file must pick up configuration changes.
let instance: Auth | undefined;

export function getAuth(): Auth {
  instance ??= createAuth();
  return instance;
}

/** Better Auth instance (lazy). `auth.api.*` for server calls, `auth.handler` for /api/auth/*. */
export const auth: Auth = new Proxy({} as Auth, {
  get(_target, property) {
    const current = getAuth();
    return Reflect.get(current, property, current);
  },
});

/** Better Auth internal context (adapter, password hasher, secrets). */
export async function getAuthContext() {
  return getAuth().$context;
}
