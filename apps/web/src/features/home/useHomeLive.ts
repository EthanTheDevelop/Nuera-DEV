'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveEvent, useLiveEvents } from '@/hooks/useLiveEvents';
import { applySessionStatus } from './lib';
import type { ClaudeState, HomeData, HomePendingPermission, HomeServer, HomeSession, ServerAvailability } from './types';

/** Debounce of the server re-read after a burst of events (no polling: only events trigger it). */
const REFRESH_DEBOUNCE_MS = 800;

export interface HomeLive {
  /** Server of the space (null while none is assigned: its tiles show « Aucun serveur attribué »). */
  server: HomeServer | null;
  claudeState: ClaudeState;
  claudePlan: string | null;
  availability: ServerAvailability;
  /** Same number as the sidebar bubble / tab counter. */
  activeCount: number;
  sessions: HomeSession[];
  pending: HomePendingPermission[];
  quickResume: HomeSession | null;
  /** Re-reads the server data (`router.refresh()`), e.g. « Réessayer » of a tile. */
  refresh: () => void;
}

/**
 * Live layer of the Accueil over the server snapshot (`HomeData`), through the single global stream:
 *  - `system.metrics` / `claude.status` → server and Claude tiles (from `useLiveEvents`, plus uptime / plan);
 *  - `session.status` → session cards patched in place; a session entering or leaving the active set,
 *    or a new permission request, re-reads the server data (debounced `router.refresh()`);
 *  - `session.permission` → re-read (the request's target lives in the database).
 * `stream.reset` and the runner coming back are handled by the shell (router.refresh). No polling.
 */
export function useHomeLive(data: HomeData): HomeLive {
  const router = useRouter();
  const live = useLiveEvents();
  const [sessions, setSessions] = useState<HomeSession[]>(data.sessions.items);
  const [quick, setQuick] = useState<HomeSession | null>(data.quickResume);
  const [uptimeSec, setUptimeSec] = useState<number | null>(data.server?.uptimeSec ?? null);
  const [plan, setPlan] = useState<string | null>(data.claude.plan);
  const [snapshot, setSnapshot] = useState(data);
  // A new server snapshot (router.refresh, navigation) replaces the live overlay.
  if (snapshot !== data) {
    setSnapshot(data);
    setSessions(data.sessions.items);
    setQuick(data.quickResume);
    setUptimeSec(data.server?.uptimeSec ?? null);
    setPlan(data.claude.plan);
  }
  const sessionsRef = useRef(sessions);
  const quickRef = useRef(quick);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    sessionsRef.current = sessions;
    quickRef.current = quick;
  }, [sessions, quick]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const refresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    router.refresh();
  }, [router]);

  const scheduleRefresh = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      router.refresh();
    }, REFRESH_DEBOUNCE_MS);
  }, [router]);

  useLiveEvent('session.status', (event) => {
    const next = applySessionStatus(sessionsRef.current, event.data);
    if (next === null) {
      scheduleRefresh();
      return;
    }
    sessionsRef.current = next;
    setSessions(next);
    const q = quickRef.current;
    if (q && q.id === event.data.sessionId) {
      const patched = next.find((s) => s.id === q.id);
      if (patched) {
        quickRef.current = patched;
        setQuick(patched);
      } else scheduleRefresh();
    }
  });
  useLiveEvent('session.permission', () => scheduleRefresh());
  useLiveEvent('system.metrics', (event) => setUptimeSec(event.data.uptimeSec));
  useLiveEvent('claude.status', (event) => setPlan(event.data.state === 'connected' ? (event.data.auth?.subscriptionType ?? null) : null));

  // Without a server, nothing of the runner is shown (the global stream has no runner part).
  const availability: ServerAvailability = !data.server ? 'unknown' : live.runner === 'unknown' ? data.server.availability : live.runner;

  const server = useMemo<HomeServer | null>(
    () =>
      data.server
        ? {
            ...data.server,
            availability,
            metrics: live.metrics ?? data.server.metrics,
            uptimeSec,
            lastContactAt: live.lastRunnerContactAt ?? data.server.lastContactAt,
          }
        : null,
    [data.server, availability, live.metrics, uptimeSec, live.lastRunnerContactAt],
  );

  // Requests still pending as far as the live statuses know (an answered one disappears at once).
  const pending = useMemo(
    () => data.pending.filter((p) => sessions.some((s) => s.id === p.sessionId && s.pendingPermission?.id === p.id)),
    [data.pending, sessions],
  );

  const claudeState: ClaudeState = !data.server ? 'unknown' : live.claude.state === 'unknown' ? data.claude.state : live.claude.state;

  return {
    server,
    claudeState,
    claudePlan: plan,
    availability,
    activeCount: live.activeSessionIds.length,
    sessions,
    pending,
    quickResume: quick,
    refresh,
  };
}
