'use client';

import { useState } from 'react';
import { RecentProjectRow, SessionCard } from '@/components/dev';
import { Icon } from '@/components/icons';
import { CompactButton } from '@/components/ui';
import { useSessionActions, workspaceUrl } from '@/features/sessions';
import { cn } from '@/lib/cn';
import { setProjectFavorite } from './api';
import { cardActivity } from './lib';
import type { HomePartError, HomeProject, HomeSession } from './types';

/** Target of a session's main action: « Répondre » lands on the pending request (`#demande-…`). */
export function sessionHref(session: Pick<HomeSession, 'id' | 'status' | 'pendingPermission'>): string {
  return workspaceUrl(session.id, session.status === 'waiting_permission' ? (session.pendingPermission?.id ?? null) : null);
}

/** `Dev · Carte de session` fed by a home session (D01 grid 320 / M01 rail 290). */
export function HomeSessionCard({ session, className }: { session: HomeSession; className?: string }) {
  const since =
    session.status === 'waiting_permission' && session.pendingPermission
      ? session.pendingPermission.createdAt
      : (session.startedAt ?? session.createdAt);
  return (
    <div data-session-card={session.id} className={cn('grid', className)}>
    <SessionCard
      status={session.status}
      title={session.title}
      projectName={session.projectName}
      branch={session.branch}
      worktreeName={session.worktreeName}
      time={{ kind: 'elapsed', since }}
      activity={cardActivity(session)}
      action={{ href: sessionHref(session) }}
      resumable={session.resumable}
    />
    </div>
  );
}

/**
 * « Reprendre la session »: a live session opens its Workspace; a stopped but resumable one is
 * resumed first (`claude --resume`, Sessions lot), then the Workspace opens.
 */
export function ResumeSessionButton({
  session,
  variant,
  block,
  size = 'md',
}: {
  session: HomeSession;
  variant: 'principal' | 'secondaire';
  block?: boolean;
  size?: 'md' | 'lg';
}) {
  const actions = useSessionActions();
  const label = 'Reprendre la session';
  const alive = session.live || session.status === 'new' || session.status === 'running' || session.status === 'waiting_input' || session.status === 'waiting_permission';
  if (alive) {
    return (
      <CompactButton variant={variant} icon="play" href={sessionHref(session)} block={block} size={size}>
        {label}
      </CompactButton>
    );
  }
  const pending = actions.pending?.id === session.id;
  return (
    <>
      <CompactButton
        variant={variant}
        icon="play"
        block={block}
        size={size}
        loading={pending}
        disabled={!session.resumable}
        title={session.resumable ? undefined : 'Cette session ne peut plus être reprise.'}
        onClick={() =>
          void actions.resume({
            id: session.id,
            title: session.title,
            project: { name: session.projectName },
            worktree: session.worktreeName ? { name: session.worktreeName, isPrimary: false } : null,
          })
        }
      >
        {label}
      </CompactButton>
      {actions.errorPanel}
      {actions.dialogs}
    </>
  );
}

/** Optimistic favourite star of the « Projets récents » rows. */
export function useFavorites() {
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const favorite = (p: HomeProject) => overrides[p.id] ?? p.favorite;
  const toggle = async (p: HomeProject) => {
    const next = !favorite(p);
    setOverrides((o) => ({ ...o, [p.id]: next }));
    setPending(p.id);
    setError(null);
    try {
      await setProjectFavorite(p.id, next);
    } catch (failure) {
      setOverrides((o) => ({ ...o, [p.id]: !next }));
      const reason = failure instanceof Error ? failure.message : '';
      setError(`${p.name} : le favori n'a pas été enregistré.${reason ? ` ${reason}` : ''}`);
    } finally {
      setPending(null);
    }
  };
  return { favorite, toggle, pending, error };
}

export function HomeProjectRow({
  project,
  variant,
  favorite,
  onToggleFavorite,
  favoritePending,
}: {
  project: HomeProject;
  variant: 'desktop' | 'phone';
  favorite?: boolean;
  onToggleFavorite?: () => void;
  favoritePending?: boolean;
}) {
  return (
    <RecentProjectRow
      name={project.name}
      branch={project.branch}
      sync={{ state: project.sync.state, ahead: project.sync.ahead, behind: project.sync.behind, syncing: project.sync.syncing }}
      lastActivityAt={project.lastActivityAt}
      favorite={favorite ?? project.favorite}
      {...(onToggleFavorite ? { onToggleFavorite } : {})}
      favoritePending={favoritePending}
      href={`/projets/${project.id}`}
      variant={variant}
    />
  );
}

const PART_ERROR_TEXT: Record<HomePartError, string> = {
  runner_unavailable: 'Le serveur ne répond pas : ces informations reviendront dès son retour.',
  failed: "Ces informations n'ont pas pu être lues.",
};

/** Inline failure of one tile (the rest of the page keeps working). */
export function PartUnavailable({ error, title, onRetry, className }: { error: HomePartError; title: string; onRetry: () => void; className?: string }) {
  return (
    <div role="status" className={cn('flex flex-col items-start gap-2 py-2', className)}>
      <p className="m-0 flex items-start gap-2 font-sans text-app-13 leading-[18px] text-muted">
        <Icon name="alert" size={16} className="mt-px shrink-0 text-warn" />
        <span>
          {title}. {PART_ERROR_TEXT[error]}
        </span>
      </p>
      <CompactButton variant="discret" icon="refresh" onClick={onRetry}>
        Réessayer
      </CompactButton>
    </div>
  );
}
