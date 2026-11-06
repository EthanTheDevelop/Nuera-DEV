'use server';

import { headers } from 'next/headers';
import { requestPasswordReset } from '@/server/auth/password-reset';
import { isAppError } from '@/server/errors';
import { assertSameOriginHeaders } from '@/server/security/origin';
import { formText } from '../_components/form-state';

export interface ForgotPasswordState {
  status: 'idle' | 'sent' | 'error';
  message?: string;
  detail?: string;
  email?: string;
}

/** « Envoyer le lien » : même réponse qu'un compte existe ou non. */
export async function requestPasswordResetAction(_previous: ForgotPasswordState, formData: FormData): Promise<ForgotPasswordState> {
  const email = formText(formData, 'email').trim();
  try {
    const requestHeaders = await headers();
    assertSameOriginHeaders(requestHeaders);
    await requestPasswordReset(email, requestHeaders);
  } catch (error) {
    if (isAppError(error)) return { status: 'error', message: error.message, detail: error.detail, email };
    console.error('[mot de passe oublié]', error);
    return { status: 'error', message: 'Erreur inattendue du serveur. Réessayez.', email };
  }
  return { status: 'sent', email };
}
