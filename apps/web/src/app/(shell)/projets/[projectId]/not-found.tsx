import { Button, EmptyState } from '@/components/ui';

/** Unknown project id (deleted after a failed clone, mistyped link). */
export default function ProjectNotFound() {
  return (
    <EmptyState icon="projets" title="Projet introuvable" action={<Button href="/projets">Retour aux projets</Button>}>
      Ce projet n'existe pas ou a été retiré de Nuera Dev. Le dépôt GitHub, lui, n'est jamais touché.
    </EmptyState>
  );
}
