'use client';

import { useState } from 'react';
import { SubmitButton } from '../../_components/submit-button';
import { CompactButton, FormAlert } from '../../_components/ui';
import { acknowledgeCodesAction } from '../actions';

export function BackupCodesPanel({ codes, account }: { codes: string[]; account: string }) {
  const [feedback, setFeedback] = useState<string>('');

  const text = [
    'Nuera Dev — codes de secours',
    `Compte : ${account}`,
    "Chaque code ne sert qu'une fois.",
    '',
    ...codes,
    '',
  ].join('\n');

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setFeedback('Codes copiés.');
    } catch {
      setFeedback('Copie impossible : sélectionnez les codes.');
    }
  }

  function downloadCodes() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'nuera-dev-codes-de-secours.txt';
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setFeedback('Fichier téléchargé.');
  }

  if (codes.length === 0) {
    // No dead end: the setup goes on (nothing is recorded as « conservés »).
    return (
      <div className="flex flex-col gap-5">
        <FormAlert tone="error" title="Codes de secours illisibles">
          Les codes n'ont pas pu être lus. Vous pourrez en générer de nouveaux depuis Paramètres · Compte et sécurité.
        </FormAlert>
        <a
          href="/configuration/cle-d-acces"
          className="flex min-h-11 items-center text-app-14 font-medium text-accent underline-offset-4 hover:underline"
        >
          Continuer la configuration
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <ul
        aria-label={`${codes.length} codes de secours`}
        data-testid="backup-codes"
        className="grid grid-cols-2 gap-2 rounded-md border border-border p-4 select-all"
      >
        {codes.map((code) => (
          <li key={code} className="font-mono text-app-13 leading-5 font-medium tracking-(--tracking-label) text-text">
            {code}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <CompactButton type="button" variant="secondaire" onClick={copyCodes}>
          Copier les codes
        </CompactButton>
        <CompactButton type="button" variant="secondaire" icon="file" onClick={downloadCodes}>
          Télécharger (.txt)
        </CompactButton>
        <span role="status" className="text-app-12 text-muted">
          {feedback}
        </span>
      </div>
      <form action={acknowledgeCodesAction} className="flex flex-col">
        <SubmitButton pendingLabel="Enregistrement…">J'ai conservé mes codes</SubmitButton>
      </form>
    </div>
  );
}
