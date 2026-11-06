'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { newRecoveryPasswordSchema } from '@/server/auth/links';
import { resetPasswordWithToken } from '@/server/auth/password-reset';
import { assertSameOriginHeaders } from '@/server/security/origin';
import { fieldErrorsOf, formText, linkFailure } from '../../_components/form-state';
import type { LinkFormState } from '../../_components/link-forms';

/** « Choisir ce mot de passe » : lien consommé, puis connexion avec le nouveau mot de passe et la 2FA. */
export async function resetPasswordAction(token: string, _previous: LinkFormState, formData: FormData): Promise<LinkFormState> {
  const input = { password: formText(formData, 'password'), passwordConfirmation: formText(formData, 'passwordConfirmation') };
  const parsed = newRecoveryPasswordSchema.safeParse({ ...input, email: formText(formData, 'email') });
  if (!parsed.success) {
    return { status: 'error', message: 'Vérifiez les champs signalés.', fieldErrors: fieldErrorsOf(parsed.error.issues) };
  }
  try {
    const requestHeaders = await headers();
    assertSameOriginHeaders(requestHeaders);
    await resetPasswordWithToken(token, input, requestHeaders);
  } catch (error) {
    return linkFailure('mot de passe oublié', error);
  }
  redirect('/connexion?mot-de-passe=reinitialise');
}
