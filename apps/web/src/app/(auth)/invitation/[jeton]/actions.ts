'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { acceptInvitation, acceptInvitationSchema, resumeInvitation } from '@/server/auth/links';
import { getCurrentUser } from '@/server/auth/session';
import { assertSameOriginHeaders } from '@/server/security/origin';
import { fieldErrorsOf, formText, linkFailure } from '../../_components/form-state';
import type { LinkFormState } from '../../_components/link-forms';

/** « Créer mon compte »: account created, link consumed, then « Activation de votre compte ». */
export async function acceptInvitationAction(token: string, _previous: LinkFormState, formData: FormData): Promise<LinkFormState> {
  const input = {
    name: formText(formData, 'name'),
    password: formText(formData, 'password'),
    passwordConfirmation: formText(formData, 'passwordConfirmation'),
  };
  const values = { name: input.name };
  // Field by field first (the e-mail of the link is re-read on the server, never taken from the form).
  const parsed = acceptInvitationSchema.safeParse({ ...input, email: formText(formData, 'email') });
  if (!parsed.success) {
    return { status: 'error', message: 'Vérifiez les champs signalés.', fieldErrors: fieldErrorsOf(parsed.error.issues), values };
  }
  try {
    const requestHeaders = await headers();
    assertSameOriginHeaders(requestHeaders);
    await acceptInvitation(token, input, requestHeaders, await getCurrentUser());
  } catch (error) {
    return linkFailure('invitation', error, values);
  }
  redirect('/configuration/double-facteur');
}

/** « Reprendre l'activation »: the password chosen when the account was created. */
export async function resumeInvitationAction(token: string, _previous: LinkFormState, formData: FormData): Promise<LinkFormState> {
  try {
    const requestHeaders = await headers();
    assertSameOriginHeaders(requestHeaders);
    await resumeInvitation(token, { password: formText(formData, 'password') }, requestHeaders, await getCurrentUser());
  } catch (error) {
    return linkFailure('invitation', error);
  }
  redirect('/configuration/double-facteur');
}
