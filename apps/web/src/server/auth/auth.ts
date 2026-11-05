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
import { count } from 'drizzle-orm';
import { db } from '@/server/db';
import { nueraAuthPlugin } from '@/server/auth/nuera-plugin';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@/server/auth/password-policy';
import { absoluteExpiry, SESSION_HARD_CEILING_DAYS } from '@/server/auth/policy';
import { TOTP_ISSUER } from '@/server/auth/totp';
import { trustedIpHeaders } from '@/server/security/request-info';
import { getWebSessionPolicy } from '@/server/settings';

/**
 * Better Auth for the single owner of Nuera Dev.
 *
 * - e-mail + password (scrypt), public sign-up CLOSED: the owner is created by /configuration
 *   (SETUP_TOKEN), and the `user` table accepts one row only (unique index + hook below);
 * - TOTP 2FA mandatory (issuer « Nuera Dev », 8 backup codes, cannot be disabled), passkeys optional
 *   (user verification required, so a passkey counts as two factors);
 * - sessions: absolute lifetime = app_settings.webSessionMaxDays (set at creation, never extended),
 *   idle expiry = webSessionIdleHours (enforced by nueraAuthPlugin on every auth call);
 * - cookies `nuera.*` (Secure + `__Secure-` prefix in production), SameSite=Lax, trusted origin = APP_URL;
 * - built-in rate limiting for /api/auth/* (server actions use src/server/security/rate-limit.ts).
 *
 * Created lazily (first use) so that importing this module never fails at build time.
 */

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
          before: async () => {
            const [row] = await db.select({ total: count() }).from(user);
            if ((row?.total ?? 0) > 0) {
              throw new APIError('FORBIDDEN', {
                message: 'Nuera Dev a déjà un propriétaire.',
                code: 'OWNER_ALREADY_EXISTS',
              });
            }
          },
        },
      },
      session: {
        create: {
          before: async (data) => {
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
