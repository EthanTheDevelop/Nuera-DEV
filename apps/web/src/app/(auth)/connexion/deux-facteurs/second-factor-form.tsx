'use client';

import { useActionState, useState } from 'react';
import { SubmitButton } from '../../_components/submit-button';
import { CompactButton, Field, FormAlert } from '../../_components/ui';
import { verifySecondFactor, type SecondFactorFormState } from '../actions';

const INITIAL: SecondFactorFormState = { status: 'idle' };

export function SecondFactorForm({ next }: { next: string }) {
  const [state, formAction] = useActionState(verifySecondFactor, INITIAL);
  const [mode, setMode] = useState<'totp' | 'backup'>('totp');
  const restartHref = next === '/' ? '/connexion' : `/connexion?suivant=${encodeURIComponent(next)}`;

  return (
    <div className="flex flex-col gap-5">
      {state.status === 'error' && state.message ? (
        <FormAlert tone="error" title={state.message}>
          {state.restart ? (
            <a href={restartHref} className="font-medium text-accent underline underline-offset-4">
              Recommencer avec le mot de passe
            </a>
          ) : null}
        </FormAlert>
      ) : null}

      <form action={formAction} className="flex flex-col gap-5" noValidate>
        <input type="hidden" name="suivant" value={next} />
        <input type="hidden" name="mode" value={mode} />
        {mode === 'totp' ? (
          <Field
            key="totp"
            label="Code à 6 chiffres"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9 ]*"
            maxLength={7}
            mono
            required
            autoFocus
            hint="Le code change toutes les 30 secondes dans votre application d'authentification."
          />
        ) : (
          <Field
            key="backup"
            label="Code de secours"
            name="code"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={40}
            mono
            required
            autoFocus
            hint="Un des 8 codes conservés à la configuration. Chaque code ne sert qu'une fois."
          />
        )}
        <label className="flex min-h-11 cursor-pointer items-start gap-3 text-app-13 leading-4.5 text-text">
          <input type="checkbox" name="trustDevice" className="mt-0.5 size-4 shrink-0 accent-(--accent)" />
          <span>
            Approuver cet appareil pendant 30 jours
            <span className="block text-app-12 text-muted">Le code ne sera plus demandé ici ; le mot de passe, toujours.</span>
          </span>
        </label>
        <SubmitButton pendingLabel="Vérification…">Vérifier</SubmitButton>
      </form>

      <div className="flex flex-col items-start gap-3 border-t border-border pt-4">
        <CompactButton
          type="button"
          variant="discret"
          onClick={() => setMode(mode === 'totp' ? 'backup' : 'totp')}
          className="min-h-11"
        >
          {mode === 'totp' ? 'Utiliser un code de secours' : "Utiliser l'application d'authentification"}
        </CompactButton>
        <a href={restartHref} className="text-app-13 text-muted underline-offset-4 hover:underline">
          Recommencer la connexion
        </a>
      </div>
    </div>
  );
}
