'use client';

import { useActionState } from 'react';
import { SubmitButton } from '../_components/submit-button';
import { Field, FormAlert } from '../_components/ui';
import { resumeSetupAction, type SetupFormState } from './actions';

const INITIAL: SetupFormState = { status: 'idle' };

export function ResumeForm({ disabled }: { disabled: boolean }) {
  const [state, formAction] = useActionState(resumeSetupAction, INITIAL);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {state.status === 'error' && state.message ? (
        <FormAlert tone="error" title={state.message}>
          {state.detail ?? null}
        </FormAlert>
      ) : null}
      <Field
        label="Jeton de configuration"
        name="token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        required
        disabled={disabled}
        error={errors.token}
      />
      <Field
        label="E-mail"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        required
        disabled={disabled}
        error={errors.email}
        defaultValue={state.values?.email ?? ''}
        key={`email-${state.values?.email ?? ''}`}
      />
      <Field
        label="Mot de passe"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        disabled={disabled}
        error={errors.password}
      />
      <SubmitButton pendingLabel="Vérification…" disabled={disabled}>
        Continuer
      </SubmitButton>
    </form>
  );
}
