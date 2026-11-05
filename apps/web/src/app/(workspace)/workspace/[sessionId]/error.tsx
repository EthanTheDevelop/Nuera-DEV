'use client';

import { CompactButton, ErrorPanel } from '@/components/ui';

/** Unexpected failure of the Workspace page (T4: what failed, what was not touched, retry). */
export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-dvh w-full items-start justify-center px-4 py-10">
      <div className="w-full max-w-[560px]">
        <ErrorPanel
          title="Le Workspace n'a pas pu s'afficher"
          excerpt={error.digest ? `Référence de l'erreur : ${error.digest}` : 'Erreur inattendue du serveur.'}
          untouched="La session continue sur le serveur : rien n'est perdu."
          onRetry={reset}
          actions={
            <CompactButton variant="discret" href="/sessions">
              Toutes les sessions
            </CompactButton>
          }
        />
      </div>
    </div>
  );
}
