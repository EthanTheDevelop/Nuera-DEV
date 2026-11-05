'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  HEARTBEAT_INTERVAL_MS,
  parseRunnerEvent,
  type RunnerEvent,
  type RunnerEventOf,
  type RunnerEventType,
} from '@nuera/shared/events';
import {
  ACTIVE_SESSION_STATUSES,
  type ClaudeState,
  type ServerAvailability,
  type ShellClaude,
  type ShellData,
  type ShellMetrics,
  type ShellNotification,
} from '@/components/shell/types';

/* =================================================================================================
   Live events of the shell — ONE EventSource per tab on /api/stream/events (global runner stream,
   relayed by the web). Event types relied on (from @nuera/shared/events):
     heartbeat            every 15 s on a healthy stream → proof of life (W7 « Dernier signe du serveur »)
     stream.error         RUNNER_UNAVAILABLE emitted by the web relay → T5 « VPS-3 ne répond pas »
     stream.reset         runner restarted / replay impossible → subscribers reload what they show
     system.metrics       ServerCard CPU · RAM
     claude.status        « Claude Code connecté » line, T6 banner
     session.status       Sessions bubble / tab-bar counter (active = new, running, waiting_*)
     notification.created bell panel + unread count
   Reconnection: the hook owns it (exponential back-off 1 → 30 s with jitter while the browser cannot
   reach the web app — W7; a fixed 10 s while the web app reports the runner unreachable — T5
   « Nuera Dev réessaie toutes les 10 s »). A connection silent for 2.5 heartbeats is treated as lost.
   Each new EventSource resumes from the last event id (`?lastEventId=`, replay by the runner); a
   `stream.reset` (replay impossible) or the runner coming back re-reads the server snapshot
   (router.refresh), and every new snapshot of the layout resynchronises the live state.
   ================================================================================================= */

export const LIVE_EVENTS_URL = '/api/stream/events';
const T5_RETRY_MS = 10_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const SILENCE_LIMIT_MS = HEARTBEAT_INTERVAL_MS * 2.5;

/** Only in-app paths are followed from a live notification (`/sessions/…`), never another origin. */
export function safeNotificationHref(href: string | null): string | null {
  return href && href.startsWith('/') && !href.startsWith('//') && !href.includes('\\') ? href : null;
}

/** Stream URL resuming after `lastEventId` (the relay forwards it to the runner as Last-Event-ID). */
export function liveStreamUrl(base: string, lastEventId: string | null): string {
  if (!lastEventId || !/^\d{1,20}$/.test(lastEventId)) return base;
  return `${base}${base.includes('?') ? '&' : '?'}lastEventId=${lastEventId}`;
}

const latestIso = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
};

export type LiveConnection = 'connecting' | 'open' | 'reconnecting';

export interface LiveState {
  /** Browser ↔ web app stream. `reconnecting` drives W7 « Connexion au serveur perdue ». */
  connection: LiveConnection;
  /** Web app ↔ runner (VPS-3). `unavailable` drives T5. */
  runner: ServerAvailability;
  /** Last message of any kind on a healthy connection (ms epoch). */
  lastSignalAt: number | null;
  /** Last proof of life of the runner (ISO) — « Dernier contact il y a 3 min ». */
  lastRunnerContactAt: string | null;
  /** When the next automatic attempt happens (ms epoch), null while connected. */
  nextRetryAt: number | null;
  /** Consecutive failed attempts. */
  attempt: number;
  metrics: ShellMetrics | null;
  claude: ShellClaude;
  activeSessionIds: readonly string[];
  /** Last live status change per session (event time) — replayed over an older snapshot on `sync`. */
  sessionUpdates: Readonly<Record<string, { active: boolean; at: string }>>;
  notifications: { items: readonly ShellNotification[]; unread: number };
}

export type LiveEventHandler<T extends RunnerEventType> = (event: RunnerEventOf<T>) => void;

export interface LiveEventsApi extends LiveState {
  /** Cancels the pending timer and reconnects now (« Réessayer maintenant »). */
  retryNow: () => void;
  /** Subscribe to one event type (or '*' for all). Returns the unsubscribe function. */
  subscribe: <T extends RunnerEventType>(type: T | '*', handler: LiveEventHandler<T>) => () => void;
  /** Optimistic local update after a « marquer comme lu » server action. */
  markNotificationsRead: (ids: readonly string[] | 'all') => void;
  /**
   * Holds back the layout refreshes (`stream.reset`, runner back) while an intercepted route is shown
   * over its page (Projets « nouveau » modal, Intégrations MCP drawer): a `router.refresh()` there would
   * re-render the route as a full page. Returns the release; a refresh asked meanwhile runs on release.
   */
  deferRefresh: () => () => void;
}

/**
 * Coalesces refresh requests (one `run` per burst, on the next task) and holds them while at least
 * one deferral is active; the last release runs the refresh that was held. `force` ignores the
 * deferrals (session over: the layout must redirect to /connexion anyway).
 */
export function createRefreshGate(run: () => void, schedule: (task: () => void) => void = (task) => void setTimeout(task, 0)) {
  let queued = false;
  let pending = false;
  let deferrals = 0;
  const request = (force = false) => {
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      if (deferrals > 0 && !force) {
        pending = true;
        return;
      }
      pending = false;
      run();
    });
  };
  const defer = () => {
    deferrals += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      deferrals -= 1;
      if (deferrals === 0 && pending) {
        pending = false;
        request();
      }
    };
  };
  return { request, defer };
}

export type LiveAction =
  | { type: 'connecting' }
  | { type: 'open' }
  | { type: 'signal'; at: number }
  | { type: 'runner'; availability: ServerAvailability; contactAt?: string }
  | { type: 'lost'; nextRetryAt: number; attempt: number; runnerDown: boolean }
  | { type: 'metrics'; metrics: ShellMetrics }
  | { type: 'claude'; claude: ShellClaude }
  | { type: 'session'; id: string; active: boolean; at: string }
  | { type: 'notification'; item: ShellNotification }
  | { type: 'read'; ids: readonly string[] | 'all' }
  /** A newer server snapshot of the layout (router.refresh): it replaces what it read from the database. */
  | { type: 'sync'; snapshot: ShellData };

/** Pure state machine of the live shell (exported for tests). */
export function liveEventsReducer(state: LiveState, action: LiveAction): LiveState {
  switch (action.type) {
    case 'connecting':
      return { ...state, connection: state.connection === 'open' ? 'open' : state.connection, nextRetryAt: null };
    case 'open':
      return { ...state, connection: 'open', nextRetryAt: null };
    case 'signal':
      return { ...state, connection: 'open', lastSignalAt: action.at, attempt: 0, nextRetryAt: null };
    case 'runner':
      if (state.runner === action.availability && !action.contactAt) return state;
      return {
        ...state,
        runner: action.availability,
        lastRunnerContactAt: action.contactAt ?? state.lastRunnerContactAt,
      };
    case 'lost':
      return {
        ...state,
        // T5: the web app answered (with stream.error) — the browser link itself is fine.
        connection: action.runnerDown ? 'open' : 'reconnecting',
        nextRetryAt: action.nextRetryAt,
        attempt: action.attempt,
      };
    case 'metrics':
      return { ...state, metrics: action.metrics };
    case 'claude':
      return { ...state, claude: action.claude };
    case 'session': {
      const sessionUpdates = { ...state.sessionUpdates, [action.id]: { active: action.active, at: action.at } };
      return { ...state, activeSessionIds: withSession(state.activeSessionIds, action.id, action.active), sessionUpdates };
    }
    case 'notification': {
      const existing = state.notifications.items.find((n) => n.id === action.item.id);
      const items = [action.item, ...state.notifications.items.filter((n) => n.id !== action.item.id)].slice(0, 30);
      const unread = existing && !existing.read ? state.notifications.unread : state.notifications.unread + 1;
      return { ...state, notifications: { items, unread } };
    }
    case 'read': {
      const all = action.ids === 'all';
      const ids = new Set(all ? [] : action.ids);
      let changed = 0;
      const items = state.notifications.items.map((n) => {
        if (!n.read && (all || ids.has(n.id))) {
          changed += 1;
          return { ...n, read: true };
        }
        return n;
      });
      const unread = all ? 0 : Math.max(0, state.notifications.unread - changed);
      return { ...state, notifications: { items, unread } };
    }
    case 'sync': {
      const { server, claude, sessions, notifications, generatedAt } = action.snapshot;
      const since = Date.parse(generatedAt);
      // Events received after the snapshot was read win over it (the request took some time).
      const newer = Object.entries(state.sessionUpdates).filter(([, update]) => Date.parse(update.at) > since);
      const activeSessionIds = newer.reduce((ids, [id, update]) => withSession(ids, id, update.active), sessions.activeIds as readonly string[]);
      const known = new Set(notifications.items.map((n) => n.id));
      const fresh = state.notifications.items.filter((n) => !known.has(n.id) && Date.parse(n.createdAt) > since);
      return {
        ...state,
        // A successful runner answer is proof of life; only the stream (retried every 10 s) declares T5.
        runner: server.availability === 'available' ? 'available' : state.runner,
        lastRunnerContactAt: latestIso(state.lastRunnerContactAt, server.lastContactAt),
        metrics:
          server.metrics && (!state.metrics || Date.parse(server.metrics.sampledAt) >= Date.parse(state.metrics.sampledAt))
            ? server.metrics
            : state.metrics,
        claude: claude.state === 'unknown' ? state.claude : claude,
        activeSessionIds,
        sessionUpdates: Object.fromEntries(newer),
        notifications: {
          items: [...fresh, ...notifications.items].slice(0, 30),
          unread: notifications.unread + fresh.filter((n) => !n.read).length,
        },
      };
    }
  }
}

function withSession(ids: readonly string[], id: string, active: boolean): readonly string[] {
  const has = ids.includes(id);
  if (has === active) return ids;
  return active ? [...ids, id] : ids.filter((other) => other !== id);
}

export function initialLiveState(initial: ShellData): LiveState {
  return {
    connection: 'connecting',
    runner: initial.server.availability,
    lastSignalAt: null,
    lastRunnerContactAt: initial.server.lastContactAt,
    nextRetryAt: null,
    attempt: 0,
    metrics: initial.server.metrics,
    claude: initial.claude,
    activeSessionIds: initial.sessions.activeIds,
    sessionUpdates: {},
    notifications: initial.notifications,
  };
}

const ACTIVE = new Set<string>(ACTIVE_SESSION_STATUSES);

const LiveEventsContext = createContext<LiveEventsApi | null>(null);

export interface LiveEventsProviderProps {
  initial: ShellData;
  children: ReactNode;
  /** Override for tests. */
  url?: string;
}

export function LiveEventsProvider({ initial, children, url = LIVE_EVENTS_URL }: LiveEventsProviderProps) {
  const router = useRouter();
  const [state, dispatch] = useReducer(liveEventsReducer, initial, initialLiveState);
  const listeners = useRef(new Map<string, Set<(event: RunnerEvent) => void>>());
  const source = useRef<EventSource | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attemptRef = useRef(0);
  const erroredRef = useRef(false); // current connection carried a stream.error (T5 error stream)
  const lastMessageRef = useRef(0);
  const lastEventIdRef = useRef<string | null>(null);
  const runnerRef = useRef<ServerAvailability>(initial.server.availability);
  const connectRef = useRef<() => void>(() => undefined);
  const snapshotAt = useRef(initial.generatedAt);
  const routerRef = useRef(router);
  useEffect(() => {
    routerRef.current = router;
  }, [router]);
  // One router.refresh() for a burst of triggers (runner back + stream.reset arrive together), held
  // while an intercepted route is shown (deferRefresh).
  const [gate] = useState(() => createRefreshGate(() => routerRef.current.refresh()));
  const refreshSnapshot = useCallback((force?: boolean) => gate.request(force === true), [gate]);

  // A newer layout snapshot (router.refresh, T5 retry) resynchronises what the stream did not carry.
  useEffect(() => {
    if (initial.generatedAt === snapshotAt.current) return;
    snapshotAt.current = initial.generatedAt;
    if (initial.server.availability === 'available') runnerRef.current = 'available';
    dispatch({ type: 'sync', snapshot: initial });
  }, [initial]);

  /**
   * After repeated failures while the browser is online: is the web session over (401/403 on the
   * stream)? Then let the layout redirect to /connexion. Never router.refresh() blindly: without a
   * network, Next falls back to a full navigation and the browser error page replaces W7.
   */
  const probeSession = useCallback(async () => {
    const controller = new AbortController();
    try {
      const response = await fetch(url, { cache: 'no-store', headers: { accept: 'text/event-stream' }, signal: controller.signal });
      if (response.status === 401 || response.status === 403) refreshSnapshot(true);
    } catch {
      // unreachable: the countdown goes on
    } finally {
      controller.abort();
    }
  }, [refreshSnapshot, url]);

  const emit = useCallback((event: RunnerEvent) => {
    for (const key of [event.type, '*']) {
      listeners.current.get(key)?.forEach((handler) => {
        try {
          handler(event);
        } catch (error) {
          console.error('[live] abonné en erreur', error);
        }
      });
    }
  }, []);

  const setRunner = useCallback(
    (availability: ServerAvailability, contactAt?: string) => {
      const previous = runnerRef.current;
      runnerRef.current = availability;
      dispatch({ type: 'runner', availability, ...(contactAt ? { contactAt } : {}) });
      // T5 auto-recovery: re-render the server components with fresh data, no reload.
      if (previous === 'unavailable' && availability === 'available') refreshSnapshot();
    },
    [refreshSnapshot],
  );

  const handle = useCallback(
    (event: RunnerEvent) => {
      switch (event.type) {
        case 'heartbeat':
          if (!erroredRef.current) setRunner('available');
          break;
        case 'stream.error':
          erroredRef.current = true;
          if (event.data.code === 'RUNNER_UNAVAILABLE') setRunner('unavailable');
          break;
        case 'stream.reset':
          // Missed events could not be replayed (runner restarted…): re-read the snapshot.
          setRunner('available', event.at);
          refreshSnapshot();
          break;
        case 'system.metrics':
          dispatch({
            type: 'metrics',
            metrics: {
              cpuPercent: event.data.cpuPercent,
              memoryUsedBytes: event.data.memory.usedBytes,
              memoryTotalBytes: event.data.memory.totalBytes,
              diskUsedBytes: event.data.disk?.usedBytes ?? null,
              diskTotalBytes: event.data.disk?.totalBytes ?? null,
              sampledAt: event.data.sampledAt,
            },
          });
          setRunner('available', event.data.sampledAt);
          break;
        case 'claude.status':
          dispatch({
            type: 'claude',
            claude: {
              state: event.data.state as ClaudeState,
              version: event.data.version,
              checkedAt: event.data.checkedAt,
              error: event.data.error,
            },
          });
          setRunner('available', event.at);
          break;
        case 'session.status':
          dispatch({ type: 'session', id: event.data.sessionId, active: ACTIVE.has(event.data.status), at: event.at });
          setRunner('available', event.at);
          break;
        case 'notification.created':
          if (event.data.id) {
            dispatch({
              type: 'notification',
              item: {
                id: event.data.id,
                kind: event.data.kind,
                severity: event.data.severity,
                title: event.data.title,
                body: event.data.body,
                href: safeNotificationHref(event.data.href),
                read: false,
                createdAt: event.at,
              },
            });
          }
          break;
        default:
          setRunner('available', event.at);
      }
      emit(event);
    },
    [emit, refreshSnapshot, setRunner],
  );

  const scheduleReconnect = useCallback((runnerDown: boolean) => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    const attempt = attemptRef.current + 1;
    attemptRef.current = attempt;
    let delay: number;
    if (runnerDown) {
      delay = T5_RETRY_MS;
    } else {
      const base = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 30_000;
      delay = Math.round(base * (0.8 + Math.random() * 0.4));
    }
    dispatch({ type: 'lost', nextRetryAt: Date.now() + delay, attempt, runnerDown });
    retryTimer.current = setTimeout(() => connectRef.current(), delay);
  }, []);

  const connect = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    source.current?.close();
    erroredRef.current = false;
    // The silence watchdog measures from this attempt (a pending connection gets the full window).
    lastMessageRef.current = Date.now();
    dispatch({ type: 'connecting' });
    // A new EventSource does not resend Last-Event-ID by itself: resume explicitly (runner replay).
    const es = new EventSource(liveStreamUrl(url, lastEventIdRef.current));
    source.current = es;
    es.addEventListener('open', () => {
      lastMessageRef.current = Date.now();
      dispatch({ type: 'open' });
    });
    es.addEventListener('message', (message: MessageEvent<string>) => {
      const event = parseRunnerEvent(message.data);
      lastMessageRef.current = Date.now();
      if (message.lastEventId) lastEventIdRef.current = message.lastEventId;
      if (!erroredRef.current) {
        attemptRef.current = 0;
        dispatch({ type: 'signal', at: lastMessageRef.current });
      }
      if (event) handle(event);
    });
    es.addEventListener('error', () => {
      // We drive reconnection ourselves (to know « nouvel essai dans N s » and offer « Réessayer »).
      es.close();
      if (source.current !== es) return;
      source.current = null;
      scheduleReconnect(erroredRef.current);
      // Several failures in a row while the browser is online: the web session may have expired (probed at
      // every failure from the 3rd on — at most once per back-off step, ≤ 1 per 30 s in the long run).
      if (!erroredRef.current && attemptRef.current >= 3 && navigator.onLine !== false) void probeSession();
    });
  }, [handle, probeSession, scheduleReconnect, url]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    connectRef.current = connect;
    connect();
    const watchdog = setInterval(() => {
      if (source.current && lastMessageRef.current && Date.now() - lastMessageRef.current > SILENCE_LIMIT_MS) {
        source.current.close();
        source.current = null;
        scheduleReconnect(false);
      }
    }, 5_000);
    const onOnline = () => connectRef.current();
    const onOffline = () => {
      source.current?.close();
      source.current = null;
      scheduleReconnect(false);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !source.current) connectRef.current();
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(watchdog);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      source.current?.close();
      source.current = null;
    };
    // connect once per provider mount; later reconnects go through connectRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const subscribe = useCallback(<T extends RunnerEventType>(type: T | '*', handler: LiveEventHandler<T>) => {
    const key = type as string;
    const set = listeners.current.get(key) ?? new Set();
    const wrapped = handler as unknown as (event: RunnerEvent) => void;
    set.add(wrapped);
    listeners.current.set(key, set);
    return () => {
      set.delete(wrapped);
    };
  }, []);

  const retryNow = useCallback(() => {
    attemptRef.current = Math.max(0, attemptRef.current - 1);
    connectRef.current();
  }, []);

  const markNotificationsRead = useCallback((ids: readonly string[] | 'all') => dispatch({ type: 'read', ids }), []);

  const value = useMemo<LiveEventsApi>(
    () => ({ ...state, retryNow, subscribe, markNotificationsRead, deferRefresh: gate.defer }),
    [state, retryNow, subscribe, markNotificationsRead, gate],
  );

  return <LiveEventsContext.Provider value={value}>{children}</LiveEventsContext.Provider>;
}

/**
 * Live shell state + event subscription. Must be used under the shell layouts ((shell) and (workspace)),
 * which mount the single LiveEventsProvider of the tab.
 */
export function useLiveEvents(): LiveEventsApi {
  const ctx = useContext(LiveEventsContext);
  if (!ctx) throw new Error('useLiveEvents() doit être utilisé sous LiveEventsProvider (layouts (shell) / (workspace)).');
  return ctx;
}

/** Same as useLiveEvents but returns null outside the shells (gallery, auth pages). */
export function useOptionalLiveEvents(): LiveEventsApi | null {
  return useContext(LiveEventsContext);
}

/** Calls `handler` for every event of `type` while mounted (latest handler, no resubscription churn). */
export function useLiveEvent<T extends RunnerEventType>(type: T | '*', handler: LiveEventHandler<T>): void {
  const { subscribe } = useLiveEvents();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => subscribe<T>(type, (event) => latest.current(event)), [subscribe, type]);
}

/** While `active` (an intercepted route is shown over the page), the shell's layout refreshes wait. */
export function useDeferLiveRefresh(active: boolean): void {
  const defer = useOptionalLiveEvents()?.deferRefresh;
  useEffect(() => (active && defer ? defer() : undefined), [active, defer]);
}
