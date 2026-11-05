'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { formatRelative } from '@nuera/shared/format';
import { cn } from '@/lib/cn';
import { Icon } from '@/components/icons';
import { CompactButton } from '@/components/ui/CompactButton';
import { EmptyState } from '@/components/ui/EmptyState';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Menu';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/Sheet';
import { StatusDot, type StatusTone } from '@/components/ui/StatusDot';
import { useIsDesktopNav } from '@/hooks/useMediaQuery';
import { useLiveEvents } from '@/hooks/useLiveEvents';
import { useNow } from '@/hooks/useNow';
import { markAllNotificationsReadAction, markNotificationsReadAction } from '@/server/shell/actions';
import type { ShellNotification } from './types';

const severityTone: Record<ShellNotification['severity'], StatusTone> = {
  info: 'accent',
  success: 'success',
  warning: 'warn',
  danger: 'danger',
};

export interface NotificationListProps {
  items: readonly ShellNotification[];
  unread: number;
  onOpenItem: (item: ShellNotification) => void;
  onMarkAll: () => void;
  markingAll?: boolean;
  /** Reference time for « il y a … » (the caller ticks it with useNow, so render stays pure). */
  now: number;
}

/** Notification panel body (props only): unread first, severity dot + title + body + relative time. */
export function NotificationList({ items, unread, onOpenItem, onMarkAll, markingAll, now }: NotificationListProps) {
  if (items.length === 0) {
    return (
      <EmptyState icon="bell" title="Aucune notification" variant="plain" titleAs="p">
        Les demandes d'autorisation et les sessions terminées apparaissent ici.
      </EmptyState>
    );
  }
  return (
    <div className="flex flex-col">
      <ul className="m-0 flex list-none flex-col p-0">
        {items.map((item) => {
          const body = (
            <>
              <StatusDot tone={severityTone[item.severity]} className="mt-1.5" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn('font-sans text-app-14 text-text', item.read ? 'font-normal' : 'font-semibold')}>
                  {item.title}
                  {item.read ? null : <span className="sr-only"> · non lue</span>}
                </span>
                {item.body ? <span className="font-sans text-app-13 leading-[18px] text-muted">{item.body}</span> : null}
                <span className="font-mono text-app-11 text-muted" suppressHydrationWarning>
                  {formatRelative(item.createdAt, now)}
                </span>
              </span>
            </>
          );
          const rowClasses = 'flex w-full items-start gap-3 rounded-sm px-3 py-2.5 text-left transition-colors duration-(--dur-fast) hover:bg-hover';
          return (
            <li key={item.id}>
              {item.href ? (
                <Link href={item.href} className={rowClasses} onClick={() => onOpenItem(item)}>
                  {body}
                </Link>
              ) : (
                <button type="button" className={rowClasses} onClick={() => onOpenItem(item)} disabled={item.read}>
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {unread > 0 ? (
        <div className="flex justify-end border-t border-border px-3 pt-2">
          <CompactButton variant="discret" icon="check" onClick={onMarkAll} loading={markingAll}>
            Tout marquer comme lu
          </CompactButton>
        </div>
      ) : null}
    </div>
  );
}

export interface NotificationBellProps {
  /** `sm` = D01 bordered 36 px square (icon 18) · `md` = M01 44 px (icon 20). Default: by breakpoint. */
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Bell button of the page headers (D01 / M01 `Bouton · Notifications`) + its panel (not drawn in Figma):
 * a popover on desktop, a bottom sheet on the phone. Reads the live notifications of the shell; opening
 * a notification marks it read (server action) and follows its link.
 */
export function NotificationBell({ size, className }: NotificationBellProps) {
  const live = useLiveEvents();
  const desktop = useIsDesktopNav();
  const [open, setOpen] = useState(false);
  const [markingAll, startMarkAll] = useTransition();
  const [, startMarkOne] = useTransition();
  const [failed, setFailed] = useState(false);
  const now = useNow(30_000);
  const { items, unread } = live.notifications;
  const resolvedSize = size ?? (desktop ? 'sm' : 'md');

  // A failed action must neither crash the page (errors thrown in a transition reach the error
  // boundary) nor pretend it worked: the panel says it and the server state wins at the next refresh.
  const openItem = (item: ShellNotification) => {
    setOpen(false);
    if (item.read) return;
    live.markNotificationsRead([item.id]);
    startMarkOne(async () => {
      try {
        await markNotificationsReadAction([item.id]);
      } catch {
        setFailed(true);
      }
    });
  };
  const markAll = () => {
    setFailed(false);
    startMarkAll(async () => {
      try {
        await markAllNotificationsReadAction();
        live.markNotificationsRead('all');
      } catch {
        setFailed(true);
      }
    });
  };

  const label = unread > 0 ? `Notifications · ${unread} non ${unread > 1 ? 'lues' : 'lue'}` : 'Notifications';
  const trigger = (
    <button
      type="button"
      aria-label={label}
      className={cn(
        'nu-hit relative inline-flex shrink-0 items-center justify-center rounded-md border border-border bg-bg text-text',
        'transition-colors duration-(--dur-fast) ease-out hover:bg-hover data-[state=open]:bg-hover',
        resolvedSize === 'sm' ? 'size-9' : 'size-11',
        className,
      )}
    >
      <Icon name="bell" size={resolvedSize === 'sm' ? 18 : 20} />
      {unread > 0 ? <span aria-hidden className="absolute top-1.5 right-1.5 size-2 rounded-full bg-accent ring-2 ring-bg" /> : null}
    </button>
  );

  const list = (
    <>
      <NotificationList items={items} unread={unread} onOpenItem={openItem} onMarkAll={markAll} markingAll={markingAll} now={now} />
      {failed ? (
        <p role="alert" className="m-0 px-3 pt-2 pb-1 font-sans text-app-12 text-danger">
          La lecture n'a pas pu être enregistrée : vérifiez la connexion, puis réessayez.
        </p>
      ) : null}
    </>
  );

  if (!desktop) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent title="Notifications" meta={unread > 0 ? `${unread} non ${unread > 1 ? 'lues' : 'lue'}` : undefined}>
          {list}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent width={380} className="max-h-[min(70dvh,520px)] overflow-y-auto p-2">
        <p className="m-0 px-3 pt-2 pb-1 font-mono text-app-11 tracking-label text-muted uppercase">Notifications</p>
        {list}
      </PopoverContent>
    </Popover>
  );
}
