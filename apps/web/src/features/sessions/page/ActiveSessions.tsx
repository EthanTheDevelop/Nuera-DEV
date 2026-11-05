'use client';

import { useEffect, useRef, useState } from 'react';
import { SessionCard } from '@/components/dev';
import { Icon } from '@/components/icons';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  IconButton,
  SectionLabel,
} from '@/components/ui';
import { cn } from '@/lib/cn';
import { NewSessionButton } from '../NewSessionButton';
import type { SessionActions } from '../useSessionActions';
import { isLiveStatus, workspaceUrl, type SessionListItem } from '../lib/contract';
import { activeLabel, cardActivity, sessionHref, sortActive, worktreeNotes } from '../lib/view';

interface ActiveSessionsProps {
  items: SessionListItem[];
  actions: SessionActions;
  disabledReason: string | null;
}

/**
 * « EN COURS · n »: D06 = cards 340 + dashed « Démarrer une session » tile + worktree note;
 * M06 = 290 px rail (the session waiting for the owner first) with position dots.
 * Each card keeps its single Figma action; « … » holds the secondary ones (rename, stop / archive).
 */
export function ActiveSessions({ items, actions, disabledReason }: ActiveSessionsProps) {
  const desktop = sortActive(items, 'desktop');
  const phone = sortActive(items, 'phone');
  const notes = worktreeNotes(items);
  const label = activeLabel(items.length);

  if (items.length === 0) {
    return (
      <section aria-labelledby="sessions-en-cours" className="flex min-w-0 flex-col gap-3 nav:gap-4">
        <SectionLabel as="h2" id="sessions-en-cours">
          {label}
        </SectionLabel>
        <EmptyState
          icon="terminal"
          title="Aucune session en cours"
          action={<NewSessionButton variant="principal" disabledReason={disabledReason} />}
        >
          Démarrez-en une depuis un projet. Elle continue même navigateur fermé.
        </EmptyState>
      </section>
    );
  }

  return (
    <section aria-labelledby="sessions-en-cours" className="flex min-w-0 flex-col gap-3 nav:gap-4">
      <SectionLabel as="h2" id="sessions-en-cours">
        {label}
      </SectionLabel>

      {/* Desktop: cards + add tile */}
      <ul className="m-0 hidden list-none grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-6 p-0 nav:grid" aria-label="Sessions en cours">
        {desktop.map((item) => (
          <li key={item.id} className="flex min-w-0">
            <ActiveCard item={item} actions={actions} className="w-full" />
          </li>
        ))}
        <li className="flex min-w-0">
          <NewSessionButton variant="card" disabledReason={disabledReason} className="h-full" />
        </li>
      </ul>

      {/* Phone: rail */}
      <PhoneRail items={phone} actions={actions} />

      {notes.map((note) => (
        <p key={note} className="m-0 hidden items-start gap-2 font-sans text-app-13 text-muted nav:flex">
          <Icon name="worktree" size={16} className="mt-px shrink-0 text-muted" />
          <span>{note}</span>
        </p>
      ))}
    </section>
  );
}

function ActiveCard({ item, actions, className }: { item: SessionListItem; actions: SessionActions; className?: string }) {
  const live = item.live || isLiveStatus(item.status);
  const time =
    live && item.startedAt
      ? ({ kind: 'elapsed', since: item.startedAt } as const)
      : ({ kind: 'at', date: item.createdAt } as const);
  return (
    <div className={cn('relative flex min-w-0', className)} data-session-card={item.id} data-status={item.status}>
      <SessionCard
        status={item.status}
        title={item.title}
        projectName={item.project.name}
        branch={item.branch}
        worktreeName={item.worktree && !item.worktree.isPrimary ? item.worktree.name : item.worktree ? 'principal' : null}
        time={time}
        activity={cardActivity(item)}
        action={{ href: sessionHref(item) }}
        // Cards of a row share its height (D06 row 203 tall); the action stays at the bottom.
        className="w-full [&>div:last-child]:mt-auto"
      />
      <div className="absolute right-5 bottom-5">
        <CardMenu item={item} actions={actions} live={live} />
      </div>
    </div>
  );
}

function CardMenu({ item, actions, live }: { item: SessionListItem; actions: SessionActions; live: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton icon="more" label={`Autres actions · ${item.title}`} size="sm" iconClassName="text-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent width={220}>
        <DropdownMenuLinkItem href={workspaceUrl(item.id)} icon="terminal">
          Ouvrir le Workspace
        </DropdownMenuLinkItem>
        <DropdownMenuItem icon="edit" onSelect={() => actions.requestRename(item)}>
          Renommer
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {live ? (
          <DropdownMenuItem icon="stop" onSelect={() => actions.requestStop(item)}>
            Arrêter la session
          </DropdownMenuItem>
        ) : (
          <DropdownMenuItem icon="archive" onSelect={() => actions.requestArchive(item)}>
            Archiver
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PhoneRail({ items, actions }: { items: SessionListItem[]; actions: SessionActions }) {
  const rail = useRef<HTMLUListElement>(null);
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const element = rail.current;
    if (!element) return;
    const onScroll = () => {
      const first = element.firstElementChild as HTMLElement | null;
      const step = first ? first.offsetWidth + 12 : element.clientWidth;
      setIndex(Math.max(0, Math.min(items.length - 1, Math.round(element.scrollLeft / Math.max(1, step)))));
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [items.length]);

  return (
    <div className="flex min-w-0 flex-col gap-4 nav:hidden">
      <ul
        ref={rail}
        className="nu-scroll-x -mx-4 m-0 flex list-none snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 py-2"
        aria-label="Sessions en cours"
      >
        {items.map((item) => (
          <li key={item.id} className="flex w-[290px] shrink-0 snap-start">
            <ActiveCard item={item} actions={actions} className="w-full" />
          </li>
        ))}
      </ul>
      {items.length > 1 ? (
        <div className="flex items-center justify-center gap-1" aria-hidden>
          {items.map((item, i) => (
            <span key={item.id} className={cn('h-1.5 rounded-full transition-all duration-(--dur-fast)', i === index ? 'w-[18px] bg-accent' : 'w-1.5 bg-border')} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
