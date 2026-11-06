'use client';

import { useActionState } from 'react';
import { SubmitButton } from '../_components/submit-button';
import { Field, FormAlert } from '../_components/ui';
import { requestPasswordResetAction, type ForgotPasswordState } from './actions';

const INITIAL: ForgotPasswordState = { status: 'idle' };

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(requestPasswordResetAction, INITIAL);
  if (state.status === 'sent') {
    return (
      <FormAlert tone="info" title="Demande envoyée">
        Si un compte Nuera Dev existe pour {state.email}, un e-mail vient de lui être envoyé avec un lien pour choisir un nouveau
        mot de passe. Le lien est valable 30 minutes. Pensez à vérifier les indésirables.
      </FormAlert>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.status === 'error' && state.message ? (
        <FormAlert tone="error" title={state.message}>
          {state.detail ?? null}
        </FormAlert>
      ) : null}
      <Field
        label="E-mail"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        required
        defaultValue={state.email ?? ''}
        key={`email-${state.email ?? ''}`}
      />
      <SubmitButton pendingLabel="Envoi…">Envoyer le lien</SubmitButton>
    </form>
  );
}
