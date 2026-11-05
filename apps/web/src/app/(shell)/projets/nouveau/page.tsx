import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AddProjectFlow } from '@/features/projects/add/AddProjectFlow';
import { requireUser } from '@/server/auth/session';

export const metadata: Metadata = { title: 'Ajouter un projet' };

/** Hard load of /projets/nouveau: the same flow as the modal, as a page (desktop card, M03 full screen). */
export default async function AddProjectPage() {
  await requireUser();
  return (
    <div className="flex flex-1 items-start justify-center nav:py-6">
      <Suspense fallback={null}>
        <AddProjectFlow mode="page" />
      </Suspense>
    </div>
  );
}
