'use client';

import { SessionStatusBadge, usageLimitLabel } from '@/components/dev';
import { Icon, type IconName } from '@/components/icons';
import {
  Badge,
  CompactButton,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  IconButton,
  Tooltip,
} from '@/components/ui';
import { useNow } from '@/hooks/useNow';
import { cn } from '@/lib/cn';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useWorkspace } from '../WorkspaceContext';
import { headerMeta, sessionDurationMs } from '../lib/thread';
import { useSessionMenu } from './SessionActions';
import { SessionSwitcherPopover } from './SessionSwitcher';
import { useAutoResume } from '../session/UsageLimitBanner';
import { CommonConfigChip } from './CommonConfigChip';

function Chip({ icon, children, muted, title }: { icon: IconName; children: ReactNode; muted?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className="inline-flex h-[23px] max-w-[260px] min-w-0 shrink items-center gap-1.5 rounded-sm border border-border bg-surface-raised px-2 py-[3px]"
    >
      <Icon name={icon} size={13} className="shrink-0 text-muted" />
      <span className={cn('truncate font-mono text-app-11', muted ? 'text-muted' : 'text-text')}>{children}</span>
    </span>
  );
}

/** Ended sessions: total duration; live ones: elapsed since start (ticking). */
export function useSessionDuration(): number | null {
  const ws = useWorkspace();
  const now = useNow(30_000, ws.initialNow);
  return sessionDurationMs(ws.ctl.state.session, now);
}

export function SessionStatus({ className }: { className?: string }) {
  const ws = useWorkspace();
  const { session } = ws.ctl.state;
  const duration = useSessionDuration();
  return (
    <SessionStatusBadge
      status={session.status}
      since={session.status === 'running' ? session.startedAt : null}
      durationMs={session.status === 'finished' ? duration : null}
      reconnecting={ws.reconnecting}
      className={className}
    />
  );
}

/** D05 `En-tête de session` (214:1457): identity, context chips, switcher, Interrompre, Commit et push, …, panel toggle. */
export function SessionHeader() {
  const ws = useWorkspace();
  const { session } = ws.ctl.state;
  const { project, worktree } = ws.data;
  const now = useNow(30_000, ws.initialNow);
  const menu = useSessionMenu();
  const auto = useAutoResume();
  const limitLabel = usageLimitLabel(session.limit, now);
  const panelShown = ws.url.panel !== 'ferme' && !ws.url.review;
  const meta = headerMeta(session, ws.host, now);
  const commitDisabledReason =
    ws.serverDisabledReason ?? (!ws.canPrepareCommit ? 'Rien à committer ni à pousser dans ce worktree.' : null);
  const interruptReason = ws.canInterrupt ? null : 'Aucune étape en cours : rien à interrompre.';

  return (
    <header className="flex min-h-[81px] w-full min-w-0 items-center gap-3 border-b border-border bg-bg py-3.5 pr-5 pl-6">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 overflow-hidden">
        <div className="flex h-[23px] min-w-0 items-center gap-2.5">
          <Link
            href={`/projets/${encodeURIComponent(project.id)}`}
            className="shrink-0 font-sans text-app-18 font-medium whitespace-pre text-muted hover:text-text"
            title={`Ouvrir le projet ${project.name}`}
          >
            {`${project.name}  /`}
          </Link>
          <h1 className="m-0 min-w-0 truncate font-sans text-app-18 font-semibold text-text" title={session.title}>
            {session.title}
          </h1>
          <SessionStatus className="shrink-0" />
          {limitLabel ? (
            <Badge tone="warn" icon="clock" className="shrink-0" data-testid="limite-entete">
              {limitLabel}
            </Badge>
          ) : null}
        </div>
        <div className="flex h-[23px] min-w-0 items-center gap-2 overflow-hidden">
          <Chip icon="github" muted title={project.fullName}>
            {project.fullName}
          </Chip>
          {worktree ? (
            <>
              <Chip icon="git-branch" title={worktree.branch}>
                {worktree.branch}
              </Chip>
              <Chip icon="worktree" title={worktree.present ? undefined : 'Worktree supprimé sur le serveur'}>
                {worktree.isPrimary ? 'clone principal' : `worktree ${worktree.name}`}
              </Chip>
            </>
          ) : null}
          <CommonConfigChip />
          <span className="shrink-0 font-mono text-app-11 whitespace-nowrap text-muted" title={session.tmuxName ? `tmux ${session.tmuxName}` : undefined}>
            {meta}
          </span>
        </div>
      </div>

      <SessionSwitcherPopover />

      <Tooltip content={interruptReason ?? "Envoie Échap au CLI : l'étape en cours s'arrête, la session reste vivante."}>
        <span className="inline-flex">
          <CompactButton
            variant="secondaire"
            icon="stop"
            disabled={!ws.canInterrupt}
            loading={ws.interrupting}
            onClick={() => void ws.interrupt()}
          >
            Interrompre
          </CompactButton>
        </span>
      </Tooltip>

      <Tooltip content={commitDisabledReason ?? 'Préparer le commit, le push et la pull request'}>
        <span className="inline-flex">
          <CompactButton variant="principal" icon="upload" disabled={Boolean(commitDisabledReason)} onClick={() => ws.openCommit('commit-push')}>
            Commit et push
          </CompactButton>
        </span>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton icon="more" label="Actions de la session" variant="outline" size="sm" />
        </DropdownMenuTrigger>
        <DropdownMenuContent width={260}>
          <DropdownMenuItem icon="edit" onSelect={menu.openRename}>
            Renommer la session
          </DropdownMenuItem>
          {menu.canResume ? (
            <DropdownMenuItem icon="play" onSelect={() => void menu.resume()} disabled={menu.resuming}>
              {menu.resumeLabel}
            </DropdownMenuItem>
          ) : null}
          {menu.canStop ? (
            <DropdownMenuItem icon="stop" destructive onSelect={menu.openStop}>
              Arrêter la session
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            icon="refresh"
            role="menuitemcheckbox"
            aria-checked={auto.enabled}
            disabled={auto.disabled}
            aside={<span className="shrink-0 font-sans text-app-12 text-muted">{auto.enabled ? 'activée' : 'désactivée'}</span>}
            onSelect={() => void auto.setEnabled(!auto.enabled)}
          >
            Reprise automatique après la limite
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLinkItem icon="projets" href={`/projets/${encodeURIComponent(project.id)}`}>
            Ouvrir le projet
          </DropdownMenuLinkItem>
          <DropdownMenuLinkItem icon="github" href={project.htmlUrl} external>
            Voir le dépôt sur GitHub
          </DropdownMenuLinkItem>
          <DropdownMenuLinkItem icon="terminal" href="/sessions">
            Toutes les sessions
          </DropdownMenuLinkItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <IconButton
        icon="panel-right"
        label={panelShown ? 'Masquer le panneau contextuel' : 'Afficher le panneau contextuel'}
        aria-pressed={panelShown}
        variant="outline"
        size="sm"
        iconClassName={panelShown ? 'text-accent' : 'text-ink'}
        disabled={ws.url.review}
        onClick={() => ws.url.set({ panneau: panelShown ? 'ferme' : null })}
      />
      {menu.dialogs}
    </header>
  );
}
