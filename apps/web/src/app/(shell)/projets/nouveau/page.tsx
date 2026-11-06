import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AddProjectFlow } from '@/features/projects/add/AddProjectFlow';
import { NoServerAddProject } from '@/features/projects/add/NoServerAddProject';
import { requireContext } from '@/server/tenancy/context';

export const metadata: Metadata = { title: 'Ajouter un projet' };

/**
 * Hard load of /projets/nouveau: the same flow as the modal, as a page (desktop card, M03 full
 * screen), cloning on the server of the account's space — « Aucun serveur attribué » without one.
 */
export default async function AddProjectPage() {
  const ctx = await requireContext();
  return (
    <div className="flex flex-1 items-start justify-center nav:py-6">
      {ctx.environment ? (
        <Suspense fallback={null}>
          <AddProjectFlow mode="page" serverName={ctx.environment.name} />
        </Suspense>
      ) : (
        <NoServerAddProject mode="page" />
      )}
    </div>
  );
}
