import type { ReactNode } from 'react';
import Link from 'next/link';
import { Icon } from '@/components/icons';
import { Badge, Card, CompactButton, SectionLabel, StatusDot } from '@/components/ui';
import { cn } from '@/lib/cn';
import { syncBadge, type SyncBadgeInput } from '../lib/git';
import type { ProjectSessionsSummary } from '../lib/projects';
import { LiveTime, type DateInput } from '../status/LiveTime';
import { FavoriteToggle } from './FavoriteToggle';

/** Column template shared by `ProjectTableHeader` and the table rows (D02, content 1088 wide). */
export const PROJECT_TABLE_GRID =
  'grid grid-cols-[minmax(0,1fr)_200px_170px_130px_110px_116px] items-center gap-4';

/** D02 table header (`PROJET · BRANCHE · SYNCHRONISATION · SESSIONS · ACTIVITÉ · ACTIONS`). */
export function ProjectTableHeader({ className }: { className?: string }) {
  return (
    <div className={cn(PROJECT_TABLE_GRID, 'border-b border-border py-2.5', className)}>
      <SectionLabel as="span">Projet</SectionLabel>
      <SectionLabel as="span">Branche</SectionLabel>
      <SectionLabel as="span">Synchronisation</SectionLabel>
      <SectionLabel as="span">Sessions</SectionLabel>
      <SectionLabel as="span">Activité</SectionLabel>
      <SectionLabel as="span" className="text-right">
        Actions
      </SectionLabel>
    </div>
  );
}

export interface ProjectRowProps {
  name: string;
  /** `owner/repo` */
  repoFullName: string;
  branch?: string | null;
  sync: SyncBadgeInput;
  sessions: ProjectSessionsSummary;
  lastActivityAt?: DateInput | null;
  favorite: boolean;
  onToggleFavorite?: () => void;
  favoritePending?: boolean;
  /** Project detail (`/projets/[id]`): name link, « Ouvrir » (table) or the whole card (phone). */
  href?: string;
  /** Table actions cell (« Ouvrir » + row menu). Defaults to « Ouvrir » when `href` is set. */
  actions?: ReactNode;
  /** `table` = D02 `Dev · Ligne de projet` (210:674) · `card` = M02 project card. */
  variant?: 'table' | 'card';
  className?: string;
}

/**
 * `Dev · Ligne de projet` (210:674) — « Ligne de la bibliothèque des projets : nom, dépôt GitHub, branche
 * courante, état de synchronisation, sessions, dernière activité. Le menu porte favoris,
 * synchronisation, branche et archivage. »
 */
export function ProjectRow(props: ProjectRowProps) {
  return props.variant === 'card' ? <ProjectCard {...props} /> : <ProjectTableRow {...props} />;
}

function ProjectTableRow({
  name,
  repoFullName,
  branch,
  sync,
  sessions,
  lastActivityAt,
  favorite,
  onToggleFavorite,
  favoritePending,
  href,
  actions,
  className,
}: ProjectRowProps) {
  const badge = syncBadge(sync, 'long');
  return (
    <div className={cn(PROJECT_TABLE_GRID, 'border-b border-border py-3.5 last:border-b-0', className)}>
      <div className="flex min-w-0 items-center gap-3">
        <FavoriteToggle favorite={favorite} name={name} onToggle={onToggleFavorite} pending={favoritePending} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {href ? (
            <Link href={href} className="truncate font-sans text-app-15 font-semibold text-text hover:underline">
              {name}
            </Link>
          ) : (
            <p className="m-0 truncate font-sans text-app-15 font-semibold text-text">{name}</p>
          )}
          <p className="m-0 flex min-w-0 items-center gap-1.5">
            <Icon name="github" size={12} className="text-muted" />
            <span className="truncate font-mono text-app-11 text-muted">{repoFullName}</span>
          </p>
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        {branch ? (
          <>
            <Icon name="git-branch" size={14} className="text-muted" />
            <span className="truncate font-mono text-app-12 text-text" title={branch}>
              {branch}
            </span>
          </>
        ) : null}
      </div>
      <div className="flex min-w-0">
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot tone={sessions.tone} />
        <span className="truncate font-sans text-app-13 text-text">{sessions.label}</span>
      </div>
      <div className="min-w-0 truncate font-sans text-app-13 text-muted">
        {lastActivityAt ? <LiveTime value={lastActivityAt} format="activity" /> : null}
      </div>
      <div className="flex min-w-0 items-center justify-end gap-1">
        {actions ??
          (href ? (
            <CompactButton variant="secondaire" href={href}>
              Ouvrir
            </CompactButton>
          ) : null)}
      </div>
    </div>
  );
}

function ProjectCard({
  name,
  repoFullName,
  branch,
  sync,
  sessions,
  lastActivityAt,
  favorite,
  onToggleFavorite,
  favoritePending,
  href,
  className,
}: ProjectRowProps) {
  const badge = syncBadge(sync, 'short');
  return (
    <Card
      variant="card"
      as="article"
      className={cn('relative gap-2', href && 'transition-colors duration-(--dur-fast) hover:bg-hover', className)}
    >
      <div className="flex items-center gap-2.5">
        <FavoriteToggle favorite={favorite} name={name} onToggle={onToggleFavorite} pending={favoritePending} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {href ? (
            <Link
              href={href}
              className="truncate font-sans text-app-16 font-semibold text-text after:absolute after:inset-0 after:rounded-lg after:content-['']"
            >
              {name}
            </Link>
          ) : (
            <p className="m-0 truncate font-sans text-app-16 font-semibold text-text">{name}</p>
          )}
          <span className="truncate font-mono text-app-11 text-muted">{repoFullName}</span>
        </div>
        {href ? <Icon name="chevron" size={18} className="text-muted" /> : null}
      </div>
      {branch ? (
        <p className="m-0 flex min-w-0 items-center gap-1.5">
          <Icon name="git-branch" size={14} className="text-muted" />
          <span className="truncate font-mono text-app-11 text-muted">{branch}</span>
        </p>
      ) : null}
      <div className="flex min-w-0 items-center gap-2">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <StatusDot tone={sessions.tone} />
        <span className="shrink-0 font-sans text-app-12 text-text">{sessions.label}</span>
        <span className="min-w-0 flex-1 truncate text-right font-mono text-app-11 text-muted">
          {lastActivityAt ? <LiveTime value={lastActivityAt} format="age" /> : null}
        </span>
      </div>
    </Card>
  );
}
