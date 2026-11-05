'use client';

import { useActionState, useEffect, useState } from 'react';
import { authClient, passkeyErrorMessage, passkeysSupported } from '@/lib/auth-client';
import { SubmitButton } from '../_components/submit-button';
import { DsButton, Field, FormAlert } from '../_components/ui';
import { signInWithPassword, type SignInFormState } from './actions';

const INITIAL: SignInFormState = { status: 'idle' };

export function SignInForm({ next }: { next: string }) {
  const [state, formAction] = useActionState(signInWithPassword, INITIAL);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [canUsePasskey, setCanUsePasskey] = useState(false);

  useEffect(() => {
    if (!passkeysSupported()) return;
    setCanUsePasskey(true);
    // Conditional UI: the browser offers saved passkeys in the e-mail field's autofill.
    let cancelled = false;
    void (async () => {
      const check = PublicKeyCredential.isConditionalMediationAvailable;
      const available = typeof check === 'function' ? await check.call(PublicKeyCredential).catch(() => false) : false;
      if (!available || cancelled) return;
      const { error } = await authClient.signIn.passkey({ autoFill: true });
      if (!cancelled && !error) window.location.assign(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [next]);

  async function signInWithPasskey() {
    setPasskeyPending(true);
    setPasskeyError(null);
    const { error } = await authClient.signIn.passkey();
    if (error) {
      setPasskeyError(passkeyErrorMessage(error));
      setPasskeyPending(false);
      return;
    }
    window.location.assign(next);
  }

  return (
    <div className="flex flex-col gap-5">
      {state.status === 'error' && state.message ? (
        <FormAlert tone="error" title={state.message}>
          {state.setupIncomplete ? (
            <a href="/configuration" className="font-medium text-accent underline underline-offset-4">
              Reprendre la configuration
            </a>
          ) : null}
        </FormAlert>
      ) : null}

      <form action={formAction} className="flex flex-col gap-5" noValidate>
        <input type="hidden" name="suivant" value={next} />
        <Field
          label="E-mail"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username webauthn"
          autoCapitalize="none"
          spellCheck={false}
          required
          defaultValue={state.email ?? ''}
          key={`email-${state.email ?? ''}`}
        />
        <Field label="Mot de passe" name="password" type="password" autoComplete="current-password" required />
        <SubmitButton pendingLabel="Connexion…">Se connecter</SubmitButton>
      </form>

      {canUsePasskey ? (
        <>
          <div className="flex items-center gap-3 text-app-12 text-muted" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            ou
            <span className="h-px flex-1 bg-border" />
          </div>
          <DsButton type="button" variant="default" icon="key" pending={passkeyPending} onClick={signInWithPasskey}>
            {passkeyPending ? "Clé d'accès…" : "Se connecter avec une clé d'accès"}
          </DsButton>
          {passkeyError ? (
            <p role="alert" className="text-app-13 text-danger">
              {passkeyError}
            </p>
          ) : null}
        </>
      ) : null}

      <p className="text-app-12 text-muted">Double authentification demandée à chaque nouvel appareil.</p>
    </div>
  );
}
