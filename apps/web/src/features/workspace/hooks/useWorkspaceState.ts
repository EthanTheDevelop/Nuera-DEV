'use client';

import type { RunnerEvent } from '@nuera/shared/events';
import type { ChangesResponse, PermissionRequestDto, SessionEventItem } from '@nuera/shared/runner';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { useOptionalLiveEvents } from '@/hooks/useLiveEvents';
import { fetchChanges, fetchEvents, fetchWorktreeStatus } from '../api';
import type { WorkspaceBranchStatus, WorkspaceData, WorkspacePullRequest, WorkspaceSession } from '../lib/contract';
import {
  applyPermissionEvent,
  applyStatusEvent,
  changesWorktree,
  maxVersion,
  orderedItems,
  reconcilePending,
  statusNeedsSnapshot,
  upsertItems,
  type PendingInstruction,
  type ThreadMap,
} from '../lib/thread';
import { useSessionStream, type SessionStreamState } from './useSessionStream';

export interface WorkspaceState {
  session: WorkspaceSession;
  thread: ThreadMap;
  version: number;
  /** The thread could not be read (runner down at load, reload failure). */
  threadError: string | null;
  threadLoading: boolean;
  permission: PermissionRequestDto | null;
  pending: PendingInstruction[];
  changes: ChangesResponse | null;
  changesError: string | null;
  branch: WorkspaceBranchStatus | null;
  pullRequest: WorkspacePullRequest | null;
}

type Action =
  | { type: 'items'; items: readonly SessionEventItem[] }
  | { type: 'reset'; items: readonly SessionEventItem[]; version: number }
  | { type: 'thread/loading' }
  | { type: 'thread/error'; message: string }
  | { type: 'status'; event: Extract<RunnerEvent, { type: 'session.status' }>['data'] }
  | { type: 'permission'; permission: PermissionRequestDto }
  | { type: 'session'; patch: Partial<WorkspaceSession> }
  | { type: 'pending/add'; pending: PendingInstruction }
  | { type: 'pending/remove'; localId: string }
  | { type: 'pending/update'; localId: string; queued: boolean }
  | { type: 'changes'; changes: ChangesResponse | null; branch?: WorkspaceBranchStatus | null; error?: string | null }
  | { type: 'pullRequest'; pullRequest: WorkspacePullRequest };

function reducer(state: WorkspaceState, action: Action): WorkspaceState {
  switch (action.type) {
    case 'items': {
      const thread = upsertItems(state.thread, action.items);
      if (thread === state.thread) return state;
      const pending = reconcilePending(state.pending, orderedItems(thread));
      return { ...state, thread, version: maxVersion(thread, state.version), pending, threadError: null };
    }
    case 'reset': {
      const thread = upsertItems(new Map(), action.items);
      return {
        ...state,
        thread,
        version: Math.max(action.version, maxVersion(thread)),
        pending: reconcilePending(state.pending, orderedItems(thread)),
        threadError: null,
        threadLoading: false,
      };
    }
    case 'thread/loading':
      return { ...state, threadLoading: true };
    case 'thread/error':
      return { ...state, threadLoading: false, threadError: state.thread.size === 0 ? action.message : state.threadError };
    case 'status':
      return { ...state, session: applyStatusEvent(state.session, action.event) };
    case 'permission':
      if (action.permission.sessionId !== state.session.id) return state;
      return { ...state, permission: applyPermissionEvent(state.permission, action.permission) };
    case 'session':
      return { ...state, session: { ...state.session, ...action.patch } };
    case 'pending/add':
      return { ...state, pending: [...state.pending, action.pending] };
    case 'pending/update':
      return { ...state, pending: state.pending.map((p) => (p.localId === action.localId ? { ...p, queued: action.queued } : p)) };
    case 'pending/remove':
      return { ...state, pending: state.pending.filter((p) => p.localId !== action.localId) };
    case 'changes':
      return {
        ...state,
        changes: action.changes ?? state.changes,
        branch: action.branch === undefined ? state.branch : action.branch,
        changesError: action.error ?? null,
      };
    case 'pullRequest':
      return { ...state, pullRequest: action.pullRequest };
  }
}

function init(data: WorkspaceData): WorkspaceState {
  const thread = upsertItems(new Map(), data.events?.items ?? []);
  return {
    session: data.session,
    thread,
    version: data.events?.version ?? 0,
    threadError: data.events ? null : `Le fil de la session est indisponible : ${data.environment.name} ne répond pas.`,
    threadLoading: false,
    permission: data.permission,
    pending: [],
    changes: data.changes,
    changesError: data.worktree?.present && !data.changes ? 'Les modifications du worktree sont indisponibles.' : null,
    branch: data.branch,
    pullRequest: data.pullRequest,
  };
}

export interface WorkspaceController {
  state: WorkspaceState;
  items: SessionEventItem[];
  stream: SessionStreamState;
  /** Browser ↔ server link lost (W7): global live stream reconnecting. */
  reconnecting: boolean;
  dispatch: (action: Action) => void;
  reloadThread: () => Promise<void>;
  refreshChanges: () => void;
}

/**
 * State of one Workspace: the session (status events), its conversation (upsert by key / version,
 * reload on `stream.reset`, catch-up after W7), its pending permission and its worktree changes
 * (re-read after writing tools, turns and Git actions — never polled).
 */
export function useWorkspaceState(data: WorkspaceData): WorkspaceController {
  const router = useRouter();
  const [state, dispatch] = useReducer(reducer, data, init);
  const live = useOptionalLiveEvents();
  const versionRef = useRef(state.version);
  useEffect(() => {
    versionRef.current = state.version;
  }, [state.version]);
  const worktreeId = data.worktree?.present ? data.worktree.id : null;
  const sessionId = data.session.id;

  // A new server snapshot (router.refresh) brings fresh changes / PR / permission.
  const snapshot = useRef(data.generatedAt);
  useEffect(() => {
    if (snapshot.current === data.generatedAt) return;
    snapshot.current = data.generatedAt;
    if (data.events) dispatch({ type: 'items', items: data.events.items });
    dispatch({ type: 'changes', changes: data.changes, branch: data.branch });
    if (data.pullRequest) dispatch({ type: 'pullRequest', pullRequest: data.pullRequest });
    if (data.permission) dispatch({ type: 'permission', permission: data.permission });
    dispatch({ type: 'session', patch: { title: data.session.title, resumable: data.session.resumable } });
  }, [data]);

  const changesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const changesAbort = useRef<AbortController | null>(null);
  const refreshChanges = useCallback(() => {
    if (!worktreeId) return;
    if (changesTimer.current) clearTimeout(changesTimer.current);
    changesTimer.current = setTimeout(async () => {
      changesAbort.current?.abort();
      const controller = new AbortController();
      changesAbort.current = controller;
      try {
        const [changes, status] = await Promise.all([fetchChanges(worktreeId, controller.signal), fetchWorktreeStatus(worktreeId, controller.signal)]);
        dispatch({ type: 'changes', changes, branch: status.branch });
      } catch (error) {
        if ((error as { name?: string }).name === 'AbortError') return;
        dispatch({ type: 'changes', changes: null, error: (error as Error).message });
      }
    }, 600);
  }, [worktreeId]);
  useEffect(
    () => () => {
      if (changesTimer.current) clearTimeout(changesTimer.current);
      changesAbort.current?.abort();
    },
    [],
  );

  const reloading = useRef<Promise<void> | null>(null);
  const reloadThread = useCallback(
    async (afterVersion = 0) => {
      if (reloading.current) return reloading.current;
      const run = (async () => {
        if (afterVersion === 0) dispatch({ type: 'thread/loading' });
        try {
          let page = await fetchEvents(sessionId, afterVersion);
          if (afterVersion === 0) dispatch({ type: 'reset', items: page.items, version: page.version });
          else dispatch({ type: 'items', items: page.items });
          // Very long conversations come in several bounded pages.
          for (let i = 0; !page.complete && page.items.length > 0 && i < 50; i += 1) {
            page = await fetchEvents(sessionId, page.version);
            dispatch({ type: 'items', items: page.items });
          }
        } catch (error) {
          dispatch({ type: 'thread/error', message: (error as Error).message });
        } finally {
          reloading.current = null;
        }
      })();
      reloading.current = run;
      return run;
    },
    [sessionId],
  );

  // The first paint is bounded: a very long conversation loads the rest right after it.
  const initialPage = useRef(data.events);
  useEffect(() => {
    const first = initialPage.current;
    if (first && !first.complete && first.items.length > 0) void reloadThread(first.version);
  }, [reloadThread]);

  const onEvent = useCallback(
    (event: RunnerEvent) => {
      switch (event.type) {
        case 'session.event':
          if (event.data.sessionId !== sessionId) return;
          dispatch({ type: 'items', items: [event.data.item] });
          if (changesWorktree(event.data.item)) refreshChanges();
          break;
        case 'session.status':
          if (event.data.sessionId !== sessionId) return;
          dispatch({ type: 'status', event: event.data });
          if (event.data.status !== 'running') refreshChanges();
          // The CLI is gone: the snapshot says whether « Reprendre la session » is possible.
          if (statusNeedsSnapshot(event.data)) router.refresh();
          break;
        case 'session.permission':
          dispatch({ type: 'permission', permission: event.data.permission });
          break;
        case 'stream.reset':
          // Missed events cannot be replayed: the whole thread is read again (W7 promise).
          void reloadThread(0);
          refreshChanges();
          router.refresh();
          break;
        default:
          break;
      }
    },
    [refreshChanges, reloadThread, router, sessionId],
  );

  const stream = useSessionStream(sessionId, onEvent);

  // Events written between the server render (snapshot) and the stream's opening are not replayed
  // by the runner (no Last-Event-ID on a fresh EventSource): catch up from the last known version
  // each time the stream opens.
  useEffect(() => {
    if (stream === 'open') void reloadThread(versionRef.current);
  }, [stream, reloadThread]);

  // W7 recovery: when the browser gets its link back, catch up from the last version.
  const reconnecting = live?.connection === 'reconnecting';
  const wasReconnecting = useRef(false);
  useEffect(() => {
    if (reconnecting) {
      wasReconnecting.current = true;
      return;
    }
    if (wasReconnecting.current && live?.connection === 'open') {
      wasReconnecting.current = false;
      void reloadThread(versionRef.current);
      refreshChanges();
    }
  }, [live?.connection, reconnecting, refreshChanges, reloadThread]);

  const items = useMemo(() => orderedItems(state.thread), [state.thread]);

  return {
    state,
    items,
    stream,
    reconnecting,
    dispatch,
    reloadThread: () => reloadThread(0),
    refreshChanges,
  };
}

export type WorkspaceDispatch = WorkspaceController['dispatch'];
