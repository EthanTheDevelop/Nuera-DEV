import { Suspense } from 'react';
import { AddProjectFlow } from '@/features/projects/add/AddProjectFlow';
import { NoServerAddProject } from '@/features/projects/add/NoServerAddProject';
import { requireContext } from '@/server/tenancy/context';

/**
 * Soft navigation to /projets/nouveau from Projets: the add-project modal over the list (D03,
 * A1–A4), on the server of the account's space — « Aucun serveur attribué » without one.
 */
export default async function AddProjectModal() {
  const ctx = await requireContext();
  if (!ctx.environment) return <NoServerAddProject mode="modal" />;
  return (
    <Suspense fallback={null}>
      <AddProjectFlow mode="modal" serverName={ctx.environment.name} />
    </Suspense>
  );
}
