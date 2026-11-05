'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader, useOptionalShellData } from '@/components/shell';
import { Banner, ErrorPanel } from '@/components/ui';
import { useLiveEvent, useLiveEvents } from '@/hooks/useLiveEvents';
import { NewSessionButton } from '../NewSessionButton';
import { useSessionActions } from '../useSessionActions';
import type { HistoryUrlState, SessionCapacity, SessionListItem, SessionListPage } from '../lib/contract';
import { capacityFullReason } from '../lib/form';
import { applyStatusEvent, liveCount } from '../lib/view';
import { ActiveSessions } from './ActiveSessions';
import { CapacityTile } from './CapacityTile';
import { HistorySection } from './HistorySection';

export type SectionError = { message: string; detail?: string; raw?: string };
export type SectionLoad<T> = { ok: true; data: T } | { ok: false; error: SectionError };

export interface SessionsViewProps {
  filters: HistoryUrlState;
  capacity: SectionLoad<SessionCapacity>;
  active: SectionLoad<SessionListPage>;
  history: SectionLoad<SessionListPage>;
  projects: Array<{ id: string; name: string }>;
}

/**
 * D06 / M06 — client part of /sessions. Live: `session.status` updates the EN COURS cards in place
 * (and re-reads the server data when a session starts or leaves them), `session.permission` and
 * `stream.reset` re-read the server data. No polling.
 */
export function SessionsView({ filters, capacity, active, history, projects }: SessionsViewProps) {
  const router = useRouter();
  const shell = useOptionalShellData();
  const serverName = shell?.server.name ?? 'VPS-3';
  const live = useLiveEvents();
  const metrics = live.metrics ?? shell?.server.metrics ?? null;

  const [items, setItems] = useState<SessionListItem[]>(active.ok ? active.data.items : []);
  // New server snapshot (refresh, navigation): it replaces the live-patched list.
  const [snapshot, setSnapshot] = useState(active);
  if (snapshot !== active) {
    setSnapshot(active);
    if (active.ok) setItems(active.data.items);
  }

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      router.refresh();
    }, 600);
  }, [router]);
  useEffect(() => () => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
  }, []);

  useLiveEvent('session.status', (event) => {
    const result = applyStatusEvent(items, event.data);
    setItems(result.items);
    if (result.refresh) scheduleRefresh();
  });
  useLiveEvent('session.permission', () => scheduleRefresh());
  useLiveEvent('stream.reset', () => scheduleRefresh());

  const actions = useSessionActions();

  const capacityValue: SessionCapacity | null = useMemo(() => {
    if (!capacity.ok) return null;
    if (!active.ok || !active.data.verified || capacity.data.source !== 'runner') return capacity.data;
    return { ...capacity.data, active: liveCount(items) };
  }, [capacity, active, items]);
  const full = capacityValue ? capacityValue.active >= capacityValue.max : false;
  const disabledReason = full && capacityValue ? capacityFullReason(capacityValue.active, capacityValue.max) : null;
  const unverified = (active.ok && !active.data.verified) || (history.ok && !history.data.verified);

  return (
    <div className="flex min-w-0 flex-col gap-4 nav:gap-6">
      <PageHeader
        title="Sessions"
        subtitle={
          <>
            <span className="hidden nav:inline">{`Chaque session est un processus Claude Code sur ${serverName}, dans son propre worktree.`}</span>
            <span className="nav:hidden">{`Une session = un processus Claude Code sur ${serverName}`}</span>
          </>
        }
        actions={<NewSessionButton variant="accent" disabledReason={disabledReason} />}
        mobileAction={<NewSessionButton variant="icon" size="lg" disabledReason={disabledReason} />}
      />

      {unverified ? (
        <Banner tone="warn" title={`${serverName} ne répond pas`}>
          Statuts lus dans la base de Nuera Dev : les processus vivants et les reprises possibles ne sont pas vérifiés.
        </Banner>
      ) : null}

      {capacity.ok && capacityValue ? (
        <CapacityTile capacity={capacityValue} metrics={metrics} />
      ) : !capacity.ok ? (
        <ErrorPanel title="La capacité n'a pas pu être lue" excerpt={capacity.error.message} untouched="Aucune session n'a été modifiée." onRetry={() => router.refresh()} retryLabel="Réessayer" />
      ) : null}

      {active.ok ? (
        <ActiveSessions items={items} actions={actions} disabledReason={disabledReason} />
      ) : (
        <ErrorPanel
          title="Les sessions en cours n'ont pas pu être lues"
          excerpt={active.error.detail ? `${active.error.message} ${active.error.detail}` : active.error.message}
          untouched="Aucune session n'a été modifiée : elles continuent sur le serveur."
          raw={active.error.raw ?? null}
          onRetry={() => router.refresh()}
          retryLabel="Réessayer"
        />
      )}

      {actions.errorPanel}

      <HistorySection
        filters={filters}
        history={history}
        projects={projects}
        actions={actions}
      />

      {actions.dialogs}
    </div>
  );
}
