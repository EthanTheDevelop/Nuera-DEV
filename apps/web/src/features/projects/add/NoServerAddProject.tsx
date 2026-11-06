'use client';

import { useRouter } from 'next/navigation';
import { Button, Dialog, DialogContent, EmptyState } from '@/components/ui';

/** Same copy as the server's NO_ENVIRONMENT refusal (`@/server/tenancy/context`). */
export const NO_SERVER_TITLE = 'Aucun serveur attribué';
export const NO_SERVER_TEXT = "Aucun serveur ne vous est encore attribué : un administrateur doit vous en attribuer un. Vos dépôts y seront clonés, prêts pour Claude Code.";

/**
 * « Ajouter un projet » while no server is assigned to the account's space: nothing can be cloned,
 * so the flow is replaced by this state (no « Cloner » button that would fail). Modal over Projets
 * on a soft navigation, page card on a hard load.
 */
export function NoServerAddProject({ mode }: { mode: 'modal' | 'page' }) {
  const router = useRouter();
  if (mode === 'modal') {
    return (
      <Dialog open onOpenChange={(open) => !open && router.back()}>
        <DialogContent
          title="Ajouter un projet"
          description={NO_SERVER_TITLE}
          footer={<Button onClick={() => router.back()}>Fermer</Button>}
        >
          <EmptyState icon="server" title={NO_SERVER_TITLE} variant="plain" titleAs="h3">
            {NO_SERVER_TEXT}
          </EmptyState>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <EmptyState icon="server" title={NO_SERVER_TITLE} className="w-full max-w-[640px]" action={<Button href="/projets">Retour aux projets</Button>}>
      {NO_SERVER_TEXT}
    </EmptyState>
  );
}
