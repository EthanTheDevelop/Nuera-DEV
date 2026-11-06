'use client';

import { useActionState } from 'react';
import { SubmitButton } from './submit-button';
import { Field, FormAlert } from './ui';

/** State returned by the server actions of /invitation/[jeton] and /recuperation/[jeton]. */
export interface LinkFormState {
  status: 'idle' | 'error';
  message?: string;
  detail?: string;
  fieldErrors?: Record<string, string>;
  values?: Record<string, string>;
}

type LinkAction = (previous: LinkFormState, formData: FormData) => Promise<LinkFormState>;

const INITIAL: LinkFormState = { status: 'idle' };
const PASSWORD_HINT = '12 caractères au minimum, avec des lettres et au moins un chiffre ou un symbole.';

function ErrorAlert({ state }: { state: LinkFormState }) {
  if (state.status !== 'error' || !state.message) return null;
  return (
    <FormAlert tone="error" title={state.message}>
      {state.detail ?? null}
    </FormAlert>
  );
}

/**
 * New password chosen twice for the e-mail of the link (read-only): the invitation form (with the
 * name) and the recovery form (without).
 */
export function NewPasswordForm({
  action,
  email,
  withName,
  submitLabel,
  pendingLabel,
}: {
  action: LinkAction;
  email: string;
  withName: boolean;
  submitLabel: string;
  pendingLabel: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <ErrorAlert state={state} />
      {withName ? (
        <Field
          label="Nom"
          name="name"
          autoComplete="name"
          required
          error={errors.name}
          defaultValue={values.name ?? ''}
          key={`name-${values.name ?? ''}`}
        />
      ) : null}
      <Field
        label="E-mail"
        name="email"
        type="email"
        autoComplete="username"
        readOnly
        aria-readonly="true"
        value={email}
        hint={withName ? "Adresse choisie par la personne qui vous a invité." : 'Le compte à récupérer.'}
      />
      <Field
        label="Mot de passe"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        error={errors.password}
        hint={PASSWORD_HINT}
      />
      <Field
        label="Confirmer le mot de passe"
        name="passwordConfirmation"
        type="password"
        autoComplete="new-password"
        required
        error={errors.passwordConfirmation}
      />
      <SubmitButton pendingLabel={pendingLabel}>{submitLabel}</SubmitButton>
    </form>
  );
}

/** Resumes an activation in progress with the password chosen when the link was first used. */
export function ResumeLinkForm({ action, email }: { action: LinkAction; email: string }) {
  const [state, formAction] = useActionState(action, INITIAL);
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <ErrorAlert state={state} />
      <Field label="E-mail" name="email" type="email" autoComplete="username" readOnly aria-readonly="true" value={email} />
      <Field label="Mot de passe" name="password" type="password" autoComplete="current-password" required />
      <SubmitButton pendingLabel="Vérification…">Reprendre l'activation</SubmitButton>
    </form>
  );
}
