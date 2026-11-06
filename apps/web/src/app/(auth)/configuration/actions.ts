'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/server/auth/session';
import {
  acknowledgeBackupCodes,
  completeSetup,
  confirmEnrolment,
  createOwner,
  createOwnerSchema,
  restartEnrolment,
  resumeSetup,
  resumeSetupSchema,
} from '@/server/auth/setup';
import { isAppError } from '@/server/errors';
import { assertSameOriginHeaders } from '@/server/security/origin';

export interface SetupFormState {
  status: 'idle' | 'error';
  message?: string;
  detail?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
}

function fieldErrorsOf(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const key = String(issue.path[0] ?? 'form');
    errors[key] = errors[key] ? `${errors[key]}, ${issue.message}` : issue.message;
  }
  return errors;
}

function failure(error: unknown, values?: Record<string, string>): SetupFormState {
  if (isAppError(error)) return { status: 'error', message: error.message, detail: error.detail, values };
  console.error('[configuration]', error);
  return { status: 'error', message: 'Erreur inattendue du serveur. Réessayez.', values };
}

const text = (formData: FormData, name: string) => String(formData.get(name) ?? '');

/** Étape 1 — création du compte propriétaire, le premier (jeton de configuration). */
export async function createOwnerAction(_previous: SetupFormState, formData: FormData): Promise<SetupFormState> {
  const input = {
    token: text(formData, 'token'),
    name: text(formData, 'name'),
    email: text(formData, 'email'),
    password: text(formData, 'password'),
    passwordConfirmation: text(formData, 'passwordConfirmation'),
  };
  const values = { name: input.name, email: input.email };
  const parsed = createOwnerSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 'error', message: 'Vérifiez les champs signalés.', fieldErrors: fieldErrorsOf(parsed.error.issues), values };
  }
  try {
    const requestHeaders = await headers();
    assertSameOriginHeaders(requestHeaders);
    await createOwner(input, requestHeaders);
  } catch (error) {
    return failure(error, values);
  }
  redirect('/configuration/double-facteur');
}

/** Reprise d'une configuration interrompue (compte créé, double authentification non activée). */
export async function resumeSetupAction(_previous: SetupFormState, formData: FormData): Promise<SetupFormState> {
  const input = { token: text(formData, 'token'), email: text(formData, 'email'), password: text(formData, 'password') };
  const values = { email: input.email };
  const parsed = resumeSetupSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 'error', message: 'Vérifiez les champs signalés.', fieldErrors: fieldErrorsOf(parsed.error.issues), values };
  }
  try {
    const requestHeaders = await headers();
    assertSameOriginHeaders(requestHeaders);
    await resumeSetup(input, requestHeaders);
  } catch (error) {
    return failure(error, values);
  }
  redirect('/configuration/double-facteur');
}

/** Étape 2 — premier code TOTP : la double authentification devient active. */
export async function confirmEnrolmentAction(_previous: SetupFormState, formData: FormData): Promise<SetupFormState> {
  try {
    const requestHeaders = await headers();
    assertSameOriginHeaders(requestHeaders);
    const user = await getCurrentUser();
    if (!user) return { status: 'error', message: 'Votre accès a expiré : reprenez la configuration depuis votre lien.' };
    if (!user.twoFactorEnabled) await confirmEnrolment(text(formData, 'code'), requestHeaders, user);
  } catch (error) {
    return failure(error);
  }
  redirect('/configuration/codes-de-secours');
}

/** Étape 2 (repli) — nouvelle clé TOTP quand aucune n'est en attente (mot de passe requis). */
export async function restartEnrolmentAction(_previous: SetupFormState, formData: FormData): Promise<SetupFormState> {
  try {
    const requestHeaders = await headers();
    assertSameOriginHeaders(requestHeaders);
    const user = await getCurrentUser();
    if (!user) return { status: 'error', message: 'Votre accès a expiré : reprenez la configuration.' };
    if (!user.twoFactorEnabled) await restartEnrolment(text(formData, 'password'), requestHeaders, user);
  } catch (error) {
    return failure(error);
  }
  redirect('/configuration/double-facteur');
}

/** Étape 3 — « J'ai conservé mes codes ». */
export async function acknowledgeCodesAction(): Promise<void> {
  const requestHeaders = await headers();
  assertSameOriginHeaders(requestHeaders);
  const user = await getCurrentUser();
  if (!user) redirect('/connexion');
  if (!user.twoFactorEnabled) redirect('/configuration/double-facteur');
  await acknowledgeBackupCodes(user.id);
  redirect('/configuration/cle-d-acces');
}

/** Étape 4 — fin de la configuration ou de l'activation (clé d'accès ajoutée ou non). */
export async function completeSetupAction(): Promise<void> {
  const requestHeaders = await headers();
  assertSameOriginHeaders(requestHeaders);
  const user = await getCurrentUser();
  if (!user) redirect('/connexion');
  if (!user.twoFactorEnabled) redirect('/configuration/double-facteur');
  await acknowledgeBackupCodes(user.id);
  await completeSetup(user.id);
  redirect('/');
}
