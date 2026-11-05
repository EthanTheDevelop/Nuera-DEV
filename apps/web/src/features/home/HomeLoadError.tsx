'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { PageHeader } from '@/components/shell';
import { ErrorPanel } from '@/components/ui';

/** The Accueil could not be read at all (database unreachable…): T4 with « Réessayer ». */
export function HomeLoadError() {
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  const [attempts, setAttempts] = useState(0);
  return (
    <div className="flex flex-col gap-5 nav:gap-6">
      <PageHeader title="Accueil" />
      <ErrorPanel
        title="L'accueil n'a pas pu être chargé"
        untouched="Rien n'a été modifié : vos projets, sessions et dépôts sont intacts."
        excerpt={attempts > 0 ? 'La nouvelle tentative a aussi échoué. Réessayez dans un instant.' : undefined}
        onRetry={() => {
          setAttempts((n) => n + 1);
          startRetry(() => router.refresh());
        }}
        retrying={retrying}
      />
    </div>
  );
}
