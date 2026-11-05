import { Suspense } from 'react';
import { AddProjectFlow } from '@/features/projects/add/AddProjectFlow';
import { requireUser } from '@/server/auth/session';

/** Soft navigation to /projets/nouveau from Projets: the add-project modal over the list (D03, A1–A4). */
export default async function AddProjectModal() {
  await requireUser();
  return (
    <Suspense fallback={null}>
      <AddProjectFlow mode="modal" />
    </Suspense>
  );
}
