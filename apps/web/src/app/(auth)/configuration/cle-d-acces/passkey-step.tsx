'use client';

import { useEffect, useState } from 'react';
import { authClient, passkeyErrorMessage, passkeysSupported } from '@/lib/auth-client';
import { SubmitButton } from '../../_components/submit-button';
import { DsButton, FormAlert } from '../../_components/ui';
import { completeSetupAction } from '../actions';

type Status = { kind: 'idle' } | { kind: 'pending' } | { kind: 'added' } | { kind: 'error'; message: string };

export function PasskeyStep({ suggestedName }: { suggestedName: string }) {
  const [supported, setSupported] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    setSupported(passkeysSupported());
  }, []);

  async function addPasskey() {
    setStatus({ kind: 'pending' });
    const { error } = await authClient.passkey.addPasskey({ name: suggestedName });
    setStatus(error ? { kind: 'error', message: passkeyErrorMessage(error) } : { kind: 'added' });
  }

  return (
    <div className="flex flex-col gap-5">
      {supported === false ? (
        <FormAlert tone="info" title="Clés d'accès indisponibles">
          Ce navigateur ne prend pas en charge les clés d'accès. Vous pouvez terminer : la connexion se fera par mot de
          passe et code.
        </FormAlert>
      ) : null}
      {status.kind === 'added' ? (
        <FormAlert tone="success" title="Clé d'accès enregistrée">
          {suggestedName} · utilisable dès la prochaine connexion.
        </FormAlert>
      ) : null}
      {status.kind === 'error' ? <FormAlert tone="error" title={status.message} /> : null}

      {supported && status.kind !== 'added' ? (
        <DsButton type="button" variant="default" icon="key" pending={status.kind === 'pending'} onClick={addPasskey}>
          {status.kind === 'pending' ? "En attente de l'appareil…" : "Ajouter une clé d'accès"}
        </DsButton>
      ) : null}

      <form action={completeSetupAction} className="flex flex-col gap-3 border-t border-border pt-5">
        <SubmitButton pendingLabel="Ouverture…" variant={status.kind === 'added' || supported === false ? 'accent' : 'default'}>
          {status.kind === 'added' || supported === false ? 'Terminer' : 'Plus tard'}
        </SubmitButton>
        <p className="text-app-12 text-muted">Configuration terminée : Nuera Dev s'ouvre sur l'Accueil.</p>
      </form>
    </div>
  );
}
