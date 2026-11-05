'use client';

import { useActionState } from 'react';
import { SubmitButton } from '../../_components/submit-button';
import { Field, FormAlert } from '../../_components/ui';
import { restartEnrolmentAction, type SetupFormState } from '../actions';

const INITIAL: SetupFormState = { status: 'idle' };

/** Shown when no TOTP key is waiting for confirmation: a new one needs the password. */
export function RestartEnrolmentForm() {
  const [state, formAction] = useActionState(restartEnrolmentAction, INITIAL);
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormAlert tone="info" title="Aucune clé en attente">
        Confirmez votre mot de passe pour générer la clé de votre application d'authentification.
      </FormAlert>
      {state.status === 'error' && state.message ? <FormAlert tone="error" title={state.message} /> : null}
      <Field label="Mot de passe" name="password" type="password" autoComplete="current-password" required />
      <SubmitButton pendingLabel="Génération…">Générer la clé</SubmitButton>
    </form>
  );
}
