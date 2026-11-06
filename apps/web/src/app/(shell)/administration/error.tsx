'use client';

import { Button, ErrorPanel } from '@/components/ui';

/** Unexpected failure of the administration (T4): what failed, nothing was touched, retry. */
export default function AdministrationError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <ErrorPanel
        title="L'administration n'a pas pu s'afficher"
        excerpt={error.digest ? `Référence : ${error.digest}` : null}
        untouched="Aucun compte ni aucun serveur n'a été modifié."
        onRetry={reset}
        actions={<Button href="/">Retour à l'Accueil</Button>}
      />
    </div>
  );
}
