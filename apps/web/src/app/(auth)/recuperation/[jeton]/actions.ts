'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { newRecoveryPasswordSchema, resumeRecovery, redeemRecoveryLink } from '@/server/auth/links';
import { getCurrentUser } from '@/server/auth/session';
import { assertSameOriginHeaders } from '@/server/security/origin';
import { fieldErrorsOf, formText, linkFailure } from '../../_components/form-state';
import type { LinkFormState } from '../../_components/link-forms';

/** « Choisir ce mot de passe »: new password, link consumed, then the new second factor. */
export async function recoverAccountAction(token: string, _previous: LinkFormState, formData: FormData): Promise<LinkFormState> {
  const input = { password: formText(formData, 'password'), passwordConfirmation: formText(formData, 'passwordConfirmation') };
  const parsed = newRecoveryPasswordSchema.safeParse({ ...input, email: formText(formData, 'email') });
  if (!parsed.success) {
    return { status: 'error', message: 'Vérifiez les champs signalés.', fieldErrors: fieldErrorsOf(parsed.error.issues) };
  }
  try {
    const requestHeaders = await headers();
    assertSameOriginHeaders(requestHeaders);
    await redeemRecoveryLink(token, input, requestHeaders, await getCurrentUser());
  } catch (error) {
    return linkFailure('récupération', error);
  }
  redirect('/configuration/double-facteur');
}

/** « Reprendre l'activation » after the new password was chosen. */
export async function resumeRecoveryAction(token: string, _previous: LinkFormState, formData: FormData): Promise<LinkFormState> {
  try {
    const requestHeaders = await headers();
    assertSameOriginHeaders(requestHeaders);
    await resumeRecovery(token, { password: formText(formData, 'password') }, requestHeaders, await getCurrentUser());
  } catch (error) {
    return linkFailure('récupération', error);
  }
  redirect('/configuration/double-facteur');
}
