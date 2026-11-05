'use client';

import { QRCodeSVG } from 'qrcode.react';
import { useActionState, useState } from 'react';
import { SubmitButton } from '../../_components/submit-button';
import { CompactButton, Field, FormAlert } from '../../_components/ui';
import { confirmEnrolmentAction, type SetupFormState } from '../actions';

const INITIAL: SetupFormState = { status: 'idle' };

export function EnrolmentForm({ otpauthUri, manualKey }: { otpauthUri: string; manualKey: string }) {
  const [state, formAction] = useActionState(confirmEnrolmentAction, INITIAL);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(manualKey.replace(/\s+/g, ''));
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <ol className="flex flex-col gap-1 text-app-14 leading-5 text-text">
        <li>1. Ouvrez votre application d'authentification et ajoutez un compte.</li>
        <li>2. Scannez ce QR code, ou saisissez la clé à la main.</li>
        <li>3. Entrez le code à 6 chiffres qu'elle affiche.</li>
      </ol>

      <div className="flex flex-col items-center gap-4 rounded-md border border-border p-4 sm:flex-row sm:items-start">
        <div className="rounded-sm bg-paper p-2" role="img" aria-label="QR code de la double authentification Nuera Dev">
          {/* SVG attributes cannot read CSS variables: --paper (#ffffff) and --near-black (#141830). */}
          <QRCodeSVG value={otpauthUri} size={160} level="M" bgColor="#ffffff" fgColor="#141830" marginSize={0} />
        </div>
        <div className="flex w-full min-w-0 flex-col gap-2">
          <p id="cle-manuelle-titre" className="font-mono text-app-11 tracking-(--tracking-label) text-muted uppercase">
            Clé à saisir manuellement
          </p>
          <code
            aria-labelledby="cle-manuelle-titre"
            data-testid="totp-manual-key"
            className="font-mono text-app-13 leading-5 font-medium wrap-break-word text-text select-all"
          >
            {manualKey}
          </code>
          <div className="flex items-center gap-3">
            <CompactButton type="button" variant="secondaire" onClick={copyKey}>
              Copier la clé
            </CompactButton>
            <span role="status" className="text-app-12 text-muted">
              {copied === 'ok' ? 'Clé copiée.' : copied === 'failed' ? 'Copie impossible : sélectionnez la clé.' : ''}
            </span>
          </div>
        </div>
      </div>

      <form action={formAction} className="flex flex-col gap-5" noValidate>
        {state.status === 'error' && state.message ? (
          <FormAlert tone="error" title={state.message}>
            {state.detail ?? null}
          </FormAlert>
        ) : null}
        <Field
          label="Code à 6 chiffres"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]*"
          maxLength={7}
          mono
          required
        />
        <SubmitButton pendingLabel="Vérification…">Activer la double authentification</SubmitButton>
      </form>
    </div>
  );
}
