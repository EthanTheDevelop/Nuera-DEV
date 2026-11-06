'use client';

import { terminalText } from '@/components/dev';
import { useOptionalLiveEvents } from '@/hooks/useLiveEvents';
import { parseRunnerEvent } from '@nuera/shared/events';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  fetchRun,
  fetchRuns,
  previewHandoffRequest,
  startDevServerRequest,
  stopRunRequest,
  WorkspaceApiError,
  type RunListItem,
} from '../api';
import { useWorkspace } from '../WorkspaceContext';

/**
 * « Aperçu » state of the session's worktree: its latest dev server run (live through
 * `/api/stream/runs/<id>` — `run.status`, `run.output` — and the global `run.status` events: a dev
 * server started elsewhere shows up), the handoff to the preview origin once a port is detected,
 * the path shown in the frame (posted by the preview page itself) and the viewer's options.
 * Never polled.
 */

export type ServerState = 'loading' | 'unavailable' | 'stopped' | 'starting' | 'online' | 'error';
export type PreviewViewport = 'bureau' | 'telephone';

/** Message posted by the preview page (server/preview/html.ts `positionScript`). */
const POSITION_MESSAGE = 'nuera-apercu:position';
const OUTPUT_KEEP = 16 * 1024;
/** A handoff older than this is renewed by « Recharger » (the preview cookie lives 12 h). */
const HANDOFF_RENEW_MS = 11 * 3_600_000;
const AUTO_RELOAD_DELAY_MS = 1_200;

// --- Viewer preferences (browser storage: a convenience, never required) -------------------------

const listeners = new Set<() => void>();
function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // private window, blocked storage: the choice lasts for this page only
  }
  for (const listener of listeners) listener();
}
function subscribePref(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const memory = new Map<string, string>();
function usePref<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (value: T) => void] {
  const raw = useSyncExternalStore(subscribePref, () => memory.get(key) ?? readPref(key), () => null);
  const value = raw && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
  const set = useCallback(
    (next: T) => {
      memory.set(key, next);
      writePref(key, next);
    },
    [key],
  );
  return [value, set];
}

// --- Helpers -------------------------------------------------------------------------------------

/** Last meaningful lines of a command output (ANSI removed). */
export function lastLines(output: string | null, count = 6): string {
  if (!output) return '';
  const lines = terminalText(output)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  return lines.slice(-count).join('\n');
}

function withoutHash(path: string): string {
  const at = path.indexOf('#');
  return at >= 0 ? path.slice(0, at) : path;
}

/** Last page shown per dev server, so moving the preview (panel ⇄ main view ⇄ tab) keeps it. */
const lastPaths = new Map<string, string>();

interface RunState {
  status: 'loading' | 'ready' | 'error';
  run: RunListItem | null;
  live: boolean;
  output: string;
  message: string | null;
}

export interface PreviewController {
  enabled: boolean;
  disabledReason: string | null;
  origin: string | null;
  devCommand: string | null;
  worktreePresent: boolean;
  projectId: string;
  state: ServerState;
  run: RunListItem | null;
  outputLines: string;
  output: string;
  loadError: string | null;
  actionError: string | null;
  clearActionError: () => void;
  /** Single-use entry URL loaded in the frame (null until handed off). */
  frameSrc: string | null;
  opening: boolean;
  /** Path shown in the frame (as reported by the page), else the last one asked. */
  path: string;
  starting: boolean;
  stopping: boolean;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  reload: () => void;
  /** New handoff (the previous one failed). */
  reopen: () => void;
  navigate: (path: string) => void;
  openInNewTab: () => Promise<void>;
  retryLoad: () => void;
  /** Callback ref of the frame element. */
  attachFrame: (element: HTMLIFrameElement | null) => void;
  viewport: PreviewViewport;
  setViewport: (value: PreviewViewport) => void;
  autoReload: boolean;
  setAutoReload: (value: boolean) => void;
  serverDisabledReason: string | null;
}

export function usePreview(): PreviewController {
  const ws = useWorkspace();
  const live = useOptionalLiveEvents();
  const { project, worktree, preview } = ws.data;
  const worktreeId = worktree?.present ? worktree.id : null;
  const devCommand = project.commands.dev;
  const origin = preview.enabled ? preview.origin : null;

  const [viewport, setViewport] = usePref<PreviewViewport>('nuera.apercu.affichage', 'bureau', ['bureau', 'telephone']);
  const [autoPref, setAutoPref] = usePref<'oui' | 'non'>('nuera.apercu.rechargement', 'oui', ['oui', 'non']);
  const autoReload = autoPref === 'oui';
  const setAutoReload = useCallback((value: boolean) => setAutoPref(value ? 'oui' : 'non'), [setAutoPref]);

  const [runState, setRunState] = useState<RunState>({ status: 'loading', run: null, live: false, output: '', message: null });
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);

  // --- Latest dev server of the worktree ---------------------------------------------------------
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    if (!worktreeId) return;
    const seq = (loadSeq.current += 1);
    try {
      const { runs } = await fetchRuns(project.id, worktreeId);
      const latest = runs.find((r) => r.kind === 'dev') ?? null;
      const detail = latest ? await fetchRun(latest.id) : null;
      if (seq !== loadSeq.current) return;
      setRunState({
        status: 'ready',
        run: detail ? { ...latest!, ...detail.run, port: detail.run.port ?? null } : null,
        live: detail?.live ?? false,
        output: detail?.outputTail ?? '',
        message: null,
      });
    } catch (error) {
      if (seq !== loadSeq.current) return;
      setRunState((prev) => ({ ...prev, status: 'error', message: (error as Error).message }));
    }
  }, [project.id, worktreeId]);

  useEffect(() => {
    // eslint-disable-next-line react/set-state-in-effect -- reads external data (runs of the worktree)
    void load();
  }, [load]);

  const run = runState.run;
  const runId = run?.id ?? null;
  const running = run?.status === 'running' && runState.live;

  // Live run: status (port detected, end) and output (starting / error lines).
  useEffect(() => {
    if (!runId || !running) return;
    const source = new EventSource(`/api/stream/runs/${encodeURIComponent(runId)}`, { withCredentials: true });
    source.addEventListener('message', (message) => {
      const event = parseRunnerEvent(message.data);
      if (event?.type === 'run.status' && event.data.run.id === runId) {
        const next = event.data.run;
        setRunState((prev) =>
          prev.run?.id !== runId
            ? prev
            : { ...prev, live: next.live, run: { ...prev.run, status: next.status, port: next.port, exitCode: next.exitCode, summary: next.summary, finishedAt: next.finishedAt } },
        );
        if (next.status !== 'running') void load();
      } else if (event?.type === 'run.output' && event.data.runId === runId) {
        const { data, replay } = event.data;
        setRunState((prev) => ({ ...prev, output: (replay ? data : prev.output + data).slice(-OUTPUT_KEEP) }));
      }
    });
    return () => source.close();
  }, [load, runId, running]);

  // A dev server of this worktree started or stopped elsewhere (another tab, the project page).
  const subscribe = live?.subscribe;
  useEffect(() => {
    if (!subscribe || !worktreeId) return;
    return subscribe('run.status', (event) => {
      const other = event.data.run;
      if (other.kind === 'dev' && other.worktreeId === worktreeId && other.id !== runId) void load();
    });
  }, [load, runId, subscribe, worktreeId]);

  const state: ServerState = useMemo(() => {
    if (runState.status === 'loading') return 'loading';
    if (runState.status === 'error' && !run) return 'unavailable';
    if (!run) return 'stopped';
    if (run.status === 'running' && runState.live) return run.port ? 'online' : 'starting';
    if (run.status === 'failed') return 'error';
    return 'stopped';
  }, [run, runState.live, runState.status]);

  // --- Handoff → frame -----------------------------------------------------------------------------
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const attachFrame = useCallback((element: HTMLIFrameElement | null) => {
    frameRef.current = element;
  }, []);
  const [frame, setFrame] = useState<{ runId: string; src: string; at: number } | null>(null);
  const [opening, setOpening] = useState(false);
  const [path, setPath] = useState('/');
  const pathRef = useRef('/');
  const runIdRef = useRef(runId);
  useEffect(() => {
    runIdRef.current = runId;
  }, [runId]);
  const showPath = useCallback((value: string) => {
    pathRef.current = value;
    if (runIdRef.current) lastPaths.set(runIdRef.current, value);
    setPath(value);
  }, []);

  const handoff = useCallback(
    async (id: string, at: string) => {
      setOpening(true);
      try {
        const { url } = await previewHandoffRequest(id, at);
        setFrame({ runId: id, src: url, at: Date.now() });
        setActionError(null);
      } catch (error) {
        setFrame(null);
        setActionError(error instanceof WorkspaceApiError ? error.message : "L'aperçu n'a pas pu être ouvert.");
      } finally {
        setOpening(false);
      }
    },
    [],
  );

  const onlineRunId = state === 'online' && origin ? runId : null;
  useEffect(() => {
    if (!onlineRunId) {
      // eslint-disable-next-line react/set-state-in-effect -- the frame follows the dev server (external state)
      setFrame(null);
      return;
    }
    if (frame?.runId === onlineRunId) return;
    const resume = lastPaths.get(onlineRunId) ?? '/';
    pathRef.current = resume;
    // eslint-disable-next-line react/set-state-in-effect -- resumes the page last shown for this dev server
    setPath(resume);
    void handoff(onlineRunId, withoutHash(resume));
  }, [frame?.runId, handoff, onlineRunId]);

  // Position posted by the preview page (only from our frame, only from the preview origin).
  useEffect(() => {
    if (!origin) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frameRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; path?: unknown } | null;
      if (data?.type !== POSITION_MESSAGE || typeof data.path !== 'string' || !data.path.startsWith('/') || data.path.length > 2048) return;
      showPath(data.path);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [origin, showPath]);

  const go = useCallback(
    (target: string) => {
      if (!origin || !onlineRunId) return;
      if (frame && Date.now() - frame.at > HANDOFF_RENEW_MS) {
        void handoff(onlineRunId, withoutHash(target));
        return;
      }
      const win = frameRef.current?.contentWindow;
      const url = `${origin}${withoutHash(target)}`;
      try {
        if (win) win.location.replace(url);
        else if (frameRef.current) frameRef.current.src = url;
      } catch {
        if (frameRef.current) frameRef.current.src = url;
      }
    },
    [frame, handoff, onlineRunId, origin],
  );

  const reload = useCallback(() => go(pathRef.current), [go]);
  const navigate = useCallback(
    (value: string) => {
      const text = value.trim();
      const target = text ? (text.startsWith('/') ? text : `/${text}`) : '/';
      if (target.startsWith('//') || target.startsWith('/__nuera/') || /[\s\\]/.test(target)) {
        setActionError('Chemin invalide : saisissez un chemin du site, par exemple /devis.');
        return;
      }
      setActionError(null);
      showPath(target);
      go(target);
    },
    [go, showPath],
  );

  // « Recharger après chaque modification de Claude ».
  const writes = ws.ctl.claudeWrites;
  const seenWrites = useRef(writes);
  useEffect(() => {
    if (writes === seenWrites.current) return;
    seenWrites.current = writes;
    if (!autoReload || !frame) return;
    const timer = setTimeout(reload, AUTO_RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [autoReload, frame, reload, writes]);

  // --- Actions -------------------------------------------------------------------------------------
  const start = useCallback(async () => {
    if (!worktreeId) return;
    setStarting(true);
    setActionError(null);
    try {
      const { run: started } = await startDevServerRequest(project.id, worktreeId);
      setRunState((prev) => ({
        ...prev,
        status: 'ready',
        live: true,
        output: '',
        run: {
          id: started.id,
          kind: 'dev',
          command: devCommand ?? '',
          status: started.status,
          exitCode: null,
          summary: null,
          port: started.port ?? null,
          worktreeId,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          tests: null,
        },
      }));
      void load();
    } catch (error) {
      setActionError((error as Error).message);
      // Already running in this worktree (another tab): show that one.
      void load();
    } finally {
      setStarting(false);
    }
  }, [devCommand, load, project.id, worktreeId]);

  const stop = useCallback(async () => {
    if (!runId) return;
    setStopping(true);
    setActionError(null);
    try {
      await stopRunRequest(runId);
      await load();
    } catch (error) {
      setActionError((error as Error).message);
    } finally {
      setStopping(false);
    }
  }, [load, runId]);

  const openInNewTab = useCallback(async () => {
    if (!onlineRunId) return;
    // Opened during the click (popup blockers), filled once the handoff URL is known.
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      setActionError("Le navigateur a bloqué l'ouverture d'un nouvel onglet.");
      return;
    }
    tab.opener = null;
    try {
      const { url } = await previewHandoffRequest(onlineRunId, withoutHash(pathRef.current));
      tab.location.replace(url);
    } catch (error) {
      tab.close();
      setActionError(error instanceof WorkspaceApiError ? error.message : "L'aperçu n'a pas pu être ouvert.");
    }
  }, [onlineRunId]);

  return {
    enabled: preview.enabled,
    disabledReason: preview.enabled ? null : preview.reason,
    origin,
    devCommand,
    worktreePresent: Boolean(worktreeId),
    projectId: project.id,
    state,
    run,
    output: runState.output,
    outputLines: lastLines(runState.output),
    loadError: runState.status === 'error' ? runState.message : null,
    actionError,
    clearActionError: () => setActionError(null),
    frameSrc: frame?.src ?? null,
    opening,
    path,
    starting,
    stopping,
    start,
    stop,
    reload,
    reopen: () => {
      if (onlineRunId) void handoff(onlineRunId, withoutHash(pathRef.current));
    },
    navigate,
    openInNewTab,
    retryLoad: () => void load(),
    attachFrame,
    viewport,
    setViewport,
    autoReload,
    setAutoReload,
    serverDisabledReason: ws.serverDisabledReason,
  };
}
