import { Button, EmptyState } from '@/components/ui';

/** Unknown project id (deleted after a failed clone, mistyped link, project of another account). */
export default function ProjectNotFound() {
  return (
    <EmptyState icon="projets" title="Projet introuvable" action={<Button href="/projets">Retour aux projets</Button>}>
      Ce projet n'existe pas, a été retiré de Nuera Dev ou dépend d'un autre compte. Le dépôt GitHub, lui, n'est jamais touché.
    </EmptyState>
  );
}
