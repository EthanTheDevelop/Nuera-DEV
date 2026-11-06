import { CompactButton, EmptyState } from '@/components/ui';

/**
 * Unknown, archived or deleted session, or a session of another account (T2 wording: why, and the
 * one useful action). The same page for all of them: it never tells whether the id exists elsewhere.
 */
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
        Cette session n&apos;existe pas, a été archivée ou dépend d&apos;un autre compte Nuera Dev. Une session archivée reste consultable depuis l&apos;historique des sessions.
      </EmptyState>
    </div>
  );
}
