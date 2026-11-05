'use client';

import { Button, ErrorPanel } from '@/components/ui';

/** Unexpected failure of the project page (T4): what failed, nothing was touched, retry. */
export default function ProjectError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <ErrorPanel
        title="La page du projet n'a pas pu s'afficher"
        excerpt={error.digest ? `Référence : ${error.digest}` : null}
        untouched="Rien n'a été modifié sur le projet ni sur le serveur."
        onRetry={reset}
        actions={<Button href="/projets">Retour aux projets</Button>}
      />
    </div>
  );
}
