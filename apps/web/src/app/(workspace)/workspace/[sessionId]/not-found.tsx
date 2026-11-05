import { CompactButton, EmptyState } from '@/components/ui';

/** Unknown, archived or deleted session (T2 wording: why, and the one useful action). */
export default function WorkspaceNotFound() {
  return (
    <div className="flex min-h-dvh w-full items-start justify-center px-4 py-10">
      <EmptyState
        icon="terminal"
        title="Session introuvable"
        className="w-full max-w-[560px]"
        action={
          <CompactButton variant="principal" icon="terminal" href="/sessions">
            Voir les sessions
          </CompactButton>
        }
      >
        Cette session n&apos;existe pas ou a été archivée : sa conversation reste consultable depuis l&apos;historique des sessions.
      </EmptyState>
    </div>
  );
}
