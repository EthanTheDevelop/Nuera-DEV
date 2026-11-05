'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { auth } from '@/server/auth/auth';
import { authErrorCode, authErrorMessage } from '@/server/auth/messages';
import { safeRedirectPath } from '@/server/auth/policy';
import { normaliseBackupCode, normaliseTotpCode } from '@/server/auth/totp';
import { isAppError } from '@/server/errors';
import { assertSameOriginHeaders } from '@/server/security/origin';
import { assertRateLimit, AUTH_RATE_LIMITS } from '@/server/security/rate-limit';
import { getClientIp } from '@/server/security/request-info';

export interface SignInFormState {
  status: 'idle' | 'error';
  message?: string;
  /** Set when the setup is not finished: the form links to /configuration. */
  setupIncomplete?: boolean;
  email?: string;
}

export interface SecondFactorFormState {
  status: 'idle' | 'error';
  message?: string;
  /** The 2FA challenge is gone (expired, too many attempts): sign in again with the password. */
  restart?: boolean;
  mode?: 'totp' | 'backup';
}

const signInSchema = z.object({
  email: z.string().trim().toLowerCase().min(3).max(200),
  password: z.string().min(1).max(256),
});

function errorMessage(error: unknown): string {
  if (isAppError(error)) return error.message;
  return authErrorMessage(error);
}

function withNext(path: string, next: string): string {
  return next === '/' ? path : `${path}?suivant=${encodeURIComponent(next)}`;
}

/** Password step of /connexion. On success: second factor (or `suivant` on a trusted device). */
export async function signInWithPassword(_previous: SignInFormState, formData: FormData): Promise<SignInFormState> {
  const requestHeaders = await headers();
  const next = safeRedirectPath(formData.get('suivant'));
  const email = String(formData.get('email') ?? '').trim();
  const parsed = signInSchema.safeParse({ email, password: formData.get('password') });
  if (!parsed.success) {
    return { status: 'error', message: 'Saisissez votre e-mail et votre mot de passe.', email };
  }

  let destination: string;
  try {
    assertSameOriginHeaders(requestHeaders);
    assertRateLimit('auth:sign-in', getClientIp(requestHeaders), AUTH_RATE_LIMITS.signIn);
    const result = (await auth.api.signInEmail({
      body: { email: parsed.data.email, password: parsed.data.password, rememberMe: true },
      headers: requestHeaders,
    })) as { twoFactorRedirect?: boolean };
    destination = result.twoFactorRedirect ? withNext('/connexion/deux-facteurs', next) : next;
  } catch (error) {
    return {
      status: 'error',
      message: errorMessage(error),
      setupIncomplete: authErrorCode(error) === 'SETUP_INCOMPLETE',
      email,
    };
  }
  redirect(destination);
}

const RESTART_CODES = new Set(['INVALID_TWO_FACTOR_COOKIE', 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE']);

/** Second step: TOTP code or single-use backup code. */
export async function verifySecondFactor(
  _previous: SecondFactorFormState,
  formData: FormData,
): Promise<SecondFactorFormState> {
  const requestHeaders = await headers();
  const next = safeRedirectPath(formData.get('suivant'));
  const mode = formData.get('mode') === 'backup' ? 'backup' : 'totp';
  const trustDevice = formData.get('trustDevice') === 'on';
  const rawCode = String(formData.get('code') ?? '');
  const code = mode === 'totp' ? normaliseTotpCode(rawCode) : normaliseBackupCode(rawCode);

  if (mode === 'totp' && code.length !== 6) {
    return { status: 'error', message: 'Saisissez les 6 chiffres affichés par votre application.', mode };
  }
  if (mode === 'backup' && (code.length < 8 || code.length > 40)) {
    return { status: 'error', message: 'Saisissez un code de secours complet (ex. « Abcde-12345 »).', mode };
  }

  try {
    assertSameOriginHeaders(requestHeaders);
    assertRateLimit('auth:2fa', getClientIp(requestHeaders), AUTH_RATE_LIMITS.secondFactor);
    if (mode === 'totp') {
      await auth.api.verifyTOTP({ body: { code, trustDevice }, headers: requestHeaders });
    } else {
      await auth.api.verifyBackupCode({ body: { code, trustDevice }, headers: requestHeaders });
    }
  } catch (error) {
    const authCode = authErrorCode(error);
    return {
      status: 'error',
      message:
        mode === 'backup' && authCode === 'INVALID_CODE' ? 'Code de secours inconnu ou déjà utilisé.' : errorMessage(error),
      restart: authCode !== null && RESTART_CODES.has(authCode),
      mode,
    };
  }
  redirect(next);
}
