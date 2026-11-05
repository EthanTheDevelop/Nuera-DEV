'use client';

import { useActionState } from 'react';
import { SubmitButton } from '../_components/submit-button';
import { Field, FormAlert } from '../_components/ui';
import { createOwnerAction, type SetupFormState } from './actions';

const INITIAL: SetupFormState = { status: 'idle' };

export function OwnerForm({ disabled }: { disabled: boolean }) {
  const [state, formAction] = useActionState(createOwnerAction, INITIAL);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};

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
        hint="Valeur de SETUP_TOKEN dans l'environnement du serveur."
      />
      <Field
        label="Nom"
        name="name"
        autoComplete="name"
        required
        disabled={disabled}
        error={errors.name}
        defaultValue={values.name ?? ''}
        key={`name-${values.name ?? ''}`}
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
        defaultValue={values.email ?? ''}
        key={`email-${values.email ?? ''}`}
      />
      <Field
        label="Mot de passe"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        disabled={disabled}
        error={errors.password}
        hint="12 caractères au minimum, avec des lettres et au moins un chiffre ou un symbole."
      />
      <Field
        label="Confirmer le mot de passe"
        name="passwordConfirmation"
        type="password"
        autoComplete="new-password"
        required
        disabled={disabled}
        error={errors.passwordConfirmation}
      />
      <SubmitButton pendingLabel="Création du compte…" disabled={disabled}>
        Créer le compte
      </SubmitButton>
    </form>
  );
}
